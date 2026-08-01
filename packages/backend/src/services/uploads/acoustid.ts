/**
 * What recording is this? — asked of AcoustID, by the audio itself.
 *
 * Every other identity signal in this pipeline reads something a human wrote
 * into the file: an ISRC frame, a MusicBrainz id, an artist string. All of them
 * are absent from the files that need identifying most, because the tools people
 * use to strip provenance strip exactly those. The fingerprint survives, so this
 * is the one lookup that answers for a file whose tags say nothing.
 *
 * It cuts both ways, and both are the point:
 *
 *  - A file with no ISRC can have one RESOLVED, so an upload that the public
 *    path would refuse for being unidentifiable becomes identifiable.
 *  - A fingerprint that resolves to a commercially released recording says the
 *    file is not the uploader's to distribute, however clean its tags look. That
 *    is a BLOCKING provenance marker — see `provenanceSignals.ts`.
 *
 * ## Degraded mode is a first-class outcome
 *
 * `ACOUSTID_API_KEY` may be absent, the service may be down, and the rate-limit
 * budget may be spent. Every one of those returns {@link AcoustidResult}'s
 * `unavailable` arm — the same discipline `fingerprint.ts` applies to a missing
 * `fpcalc`, for the same reason: a screening step that reports "nothing found"
 * when it never looked is the one failure mode a screening step must not have.
 * Callers treat `unavailable` as "no new evidence" and leave every existing
 * refusal exactly as it was.
 *
 * ## Not a general-purpose HTTP client, and deliberately not `enrichmentHttp`
 *
 * `enrichmentHttp.ts` serialises Wikidata, Commons and Cover Art Archive onto one
 * 1 req/s chain with a 15 s timeout, which is right for a background job with
 * nobody waiting. This call is on the upload path with a person waiting on the
 * response, and AcoustID's own budget is 3 req/s, so it gets its own limiter with
 * a bounded wait (see {@link ACOUSTID_MAX_QUEUE_WAIT_MS}). The SSRF concern that
 * shaped that module does not arise here: the URL is a module constant and every
 * value from the uploaded file travels in a form-encoded POST body, so no part of
 * a stranger's file can steer where the request goes.
 */

import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { IsrcRegistryModel } from '../../models/IsrcRegistry';
import { FINGERPRINT_MATCH_BER, type Fingerprint } from './fingerprint';

/** The web service. A constant, never built from anything in an uploaded file. */
const ACOUSTID_LOOKUP_URL = 'https://api.acoustid.org/v2/lookup';

/**
 * Identifies Syra to AcoustID with a contact URL, matching what
 * `ENRICHMENT_USER_AGENT` does for the MetaBrainz and Wikimedia APIs.
 */
const ACOUSTID_USER_AGENT = 'SyraCatalogEnrichment/1.0 (+https://syra.fm)';

/**
 * What we ask for, and why each piece is load-bearing:
 *
 *  - `recordings` rather than `recordingids`: the artist MBID is what feeds
 *    `resolveArtist` tier 4 and, through it, the background enrichment that
 *    gives a contributed profile a photograph. `recordingids` returns bare
 *    recording ids with no artists at all, so the identifier this whole feature
 *    exists to recover would never arrive.
 *  - `releaseids` + `releasegroupids`: whether the recording is CARRIED ON a
 *    release is the discriminator between the blocking marker and the merely
 *    high one, so it has to come back with the match rather than be guessed.
 *  - `compress`: response compression. Free, and these payloads are mostly
 *    repeated MBIDs.
 */
const ACOUSTID_META = 'recordings+releaseids+releasegroupids+compress';

/**
 * A score at or above this is the same recording.
 *
 * DERIVED, not chosen. `FINGERPRINT_MATCH_BER` is the bit error rate below which
 * this codebase already calls two Chromaprint fingerprints the same recording,
 * and it was measured against a real corpus (see its own documentation: worst
 * genuine positive 0.0226, closest unrelated pair 0.1638). AcoustID's score is
 * the complementary quantity — the proportion of bits that AGREE — so the
 * threshold that keeps the remote index and the local comparator saying the same
 * thing about the same pair of fingerprints is `1 − FINGERPRINT_MATCH_BER`.
 *
 * Expressed as the subtraction rather than as `0.9` so the two cannot drift: a
 * future recalibration of the local BER moves this with it, which is the whole
 * reason the local constant's own documentation notes that 0.10 "matches
 * AcoustID's own convention of treating ≥90 % bit agreement as the same
 * recording, so a future move to their index needs no recalibration". This is
 * that move.
 *
 * The caveat, stated because it is real: AcoustID computes its score over its own
 * alignment of a fingerprint against an indexed one, not with this module's
 * comparator, so the two numbers are the same CONVENTION rather than the same
 * arithmetic. What that buys is a threshold with a measured margin behind it
 * instead of a round number picked because it looks like one.
 */
export const ACOUSTID_MATCH_SCORE = 1 - FINGERPRINT_MATCH_BER;

/**
 * AcoustID asks for no more than 3 requests a second, so requests start at least
 * this far apart. 334 ms rather than 333 keeps the rate strictly under the limit
 * (2.994/s) instead of exactly at it.
 */
export const ACOUSTID_MIN_REQUEST_INTERVAL_MS = 334;

/**
 * The longest a caller will wait for a rate-limit slot before giving up.
 *
 * This is what makes an inline lookup safe. The answer is needed BEFORE the
 * upload is accepted or refused — a queued job cannot inform a gate that has
 * already fired — so the call is inline by necessity, and the protection is that
 * it is bounded rather than deferred: at most this wait plus
 * {@link REQUEST_TIMEOUT_MS}, whatever the queue depth. Past the bound the
 * request is never made and the caller gets `unavailable`, which every caller
 * already handles.
 *
 * 1.5 s admits roughly four requests' worth of backlog at the interval above.
 * Beyond that the upload is better served by an honest "not identified" than by
 * waiting behind a queue it cannot see.
 */
export const ACOUSTID_MAX_QUEUE_WAIT_MS = 1_500;

/** A single request's own ceiling, on top of any queue wait. */
const REQUEST_TIMEOUT_MS = 5_000;

// ── Chromaprint compression ─────────────────────────────────────────────────

/**
 * The API takes the COMPRESSED fingerprint — what `fpcalc` prints without
 * `-raw` — and `fingerprint.ts` holds the raw int32 values. Rather than decode
 * the audio a second time to obtain the other spelling of a number we already
 * have, the values are compressed here.
 *
 * This is Chromaprint's own format, reimplemented, not an approximation of it:
 * a 4-byte header (algorithm, then a 24-bit big-endian item count), then the
 * bit-position deltas of each value XOR-ed with its predecessor, written 3 bits
 * at a time with 7 as an escape into a second 5-bit stream. The two streams are
 * packed least-significant-bit first and concatenated, then base64url-encoded
 * without padding.
 *
 * VERIFIED byte-for-byte against `fpcalc` 1.5.1 on four fingerprints, including
 * one that produces no escapes at all and three that produce 26, 89 and 138 of
 * them — the escape path is content-dependent, so a single sample could not tell
 * a working implementation from one that never reaches it. The pairs are
 * committed in `__fixtures__/chromaprint-compressed.json` so the test needs no
 * binary.
 */
const CHROMAPRINT_ALGORITHM = 1;
const CHROMAPRINT_MAX_NORMAL_VALUE = 7;
const CHROMAPRINT_NORMAL_BITS = 3;
const CHROMAPRINT_EXCEPTIONAL_BITS = 5;

/** Packs values of a fixed bit width into bytes, least-significant bit first. */
function packBits(values: ReadonlyArray<number>, width: number): number[] {
  const bytes: number[] = [];
  let buffer = 0;
  let size = 0;
  for (const value of values) {
    buffer |= value << size;
    size += width;
    while (size >= 8) {
      bytes.push(buffer & 0xff);
      buffer >>>= 8;
      size -= 8;
    }
  }
  while (size > 0) {
    bytes.push(buffer & 0xff);
    buffer >>>= 8;
    size -= 8;
  }
  return bytes;
}

/** Raw Chromaprint values → the base64url form the AcoustID API accepts. */
export function encodeChromaprint(values: ReadonlyArray<number>): string {
  const normal: number[] = [];
  const exceptional: number[] = [];

  let previous = 0;
  for (const value of values) {
    // Delta against the previous item, then the POSITIONS of the set bits. Both
    // halves matter: consecutive Chromaprint items differ in very few bits, and
    // those few bits cluster, so the gaps between them fit in three bits.
    let remaining = (value ^ previous) >>> 0;
    previous = value >>> 0;

    let bit = 1;
    let lastBit = 0;
    while (remaining !== 0) {
      if (remaining & 1) {
        const gap = bit - lastBit;
        if (gap >= CHROMAPRINT_MAX_NORMAL_VALUE) {
          normal.push(CHROMAPRINT_MAX_NORMAL_VALUE);
          exceptional.push(gap - CHROMAPRINT_MAX_NORMAL_VALUE);
        } else {
          normal.push(gap);
        }
        lastBit = bit;
      }
      remaining >>>= 1;
      bit += 1;
    }
    // A zero terminates the item, which is how the decoder knows where the next
    // one starts. An item that differs in no bits at all is just this zero.
    normal.push(0);
  }

  const count = values.length;
  const bytes = Buffer.from([
    CHROMAPRINT_ALGORITHM & 0xff,
    (count >> 16) & 0xff,
    (count >> 8) & 0xff,
    count & 0xff,
    ...packBits(normal, CHROMAPRINT_NORMAL_BITS),
    ...packBits(exceptional, CHROMAPRINT_EXCEPTIONAL_BITS),
  ]);

  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Rate limiting ───────────────────────────────────────────────────────────

/**
 * When the next request may START, as an epoch millisecond.
 *
 * A reservation rather than a promise chain (which is what `enrichmentHttp.ts`
 * uses) because a caller here has to be able to DECLINE its place in the queue:
 * joining a chain commits to waiting however long the chain is, and this call
 * runs with an upload waiting on it.
 *
 * No `setInterval`, so there is no module-level timer to `unref` — the only
 * timers are the per-request ones below, which unref themselves.
 */
let nextRequestSlotAt = 0;

/** Reset the limiter. Tests must not inherit another test's reservations. */
export function resetAcoustidRateLimitForTests(): void {
  nextRequestSlotAt = 0;
}

/**
 * Claim the next slot, or refuse when it is further away than the caller can
 * wait. Returns the milliseconds to wait before starting.
 */
function reserveRequestSlot(): number | undefined {
  const now = Date.now();
  const startAt = Math.max(now, nextRequestSlotAt);
  const wait = startAt - now;
  if (wait > ACOUSTID_MAX_QUEUE_WAIT_MS) return undefined;
  nextRequestSlotAt = startAt + ACOUSTID_MIN_REQUEST_INTERVAL_MS;
  return wait;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// ── Results ─────────────────────────────────────────────────────────────────

/** One artist credited on a matched recording, as MusicBrainz identifies them. */
export interface AcoustidArtist {
  mbid: string;
  name: string;
}

/** A MusicBrainz recording the audio was identified as. */
export interface AcoustidRecording {
  /** AcoustID's own id for the fingerprint cluster, for the audit trail. */
  acoustid: string;
  /** Bit agreement, in `[0, 1]`; at or above {@link ACOUSTID_MATCH_SCORE}. */
  score: number;
  recordingMbid: string;
  title?: string;
  artists: AcoustidArtist[];
  releaseMbids: string[];
  releaseGroupMbids: string[];
  /** The recording's length as MusicBrainz records it, when it is known. */
  durationSec?: number;
}

/**
 * `match` — identified, at or above the score threshold.
 * `no-match` — the service answered and nothing reached the threshold. This IS a
 *   negative result: the audio was checked against the index and is not in it.
 * `unavailable` — no key, no budget, or the service could not be reached. NOT a
 *   negative result, and callers must not treat it as one.
 */
export type AcoustidResult =
  | { status: 'match'; recording: AcoustidRecording }
  | { status: 'no-match'; bestScore?: number }
  | { status: 'unavailable'; reason: string };

// ── HTTP ────────────────────────────────────────────────────────────────────

/**
 * The network call, behind a swappable reference — the same seam
 * `enrichmentHttp.ts` exposes, for the same reason: the parser below has to face
 * the payload shapes this API really produces without a test suite making
 * requests to a service that asks us not to.
 */
export type AcoustidFetch = (body: URLSearchParams) => Promise<unknown>;

let acoustidFetch: AcoustidFetch | undefined;

export function setAcoustidFetchForTests(implementation?: AcoustidFetch): void {
  acoustidFetch = implementation;
  resetAcoustidRateLimitForTests();
}

/**
 * POST rather than GET, always.
 *
 * A full-length track fingerprints to a few thousand items, which is several
 * kilobytes of base64 — past the length at which intermediaries start refusing
 * URLs. Choosing per request would mean the long-file path was the one never
 * exercised in testing, so there is one path and it is the one that always works.
 */
async function postLookup(body: URLSearchParams): Promise<unknown> {
  if (acoustidFetch) return acoustidFetch(body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const response = await fetch(ACOUSTID_LOOKUP_URL, {
      method: 'POST',
      headers: {
        'User-Agent': ACOUSTID_USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`AcoustID responded ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ── Parsing ─────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The `id` of every entry in `source[key]`, deduplicated, in order. */
function collectMbids(source: Record<string, unknown> | undefined, key: string): string[] {
  if (!source) return [];
  const ids: string[] = [];
  for (const entry of asArray(source[key])) {
    const id = asString(asRecord(entry)?.id);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function readArtists(recording: Record<string, unknown>): AcoustidArtist[] {
  const artists: AcoustidArtist[] = [];
  for (const entry of asArray(recording.artists)) {
    const record = asRecord(entry);
    const mbid = asString(record?.id);
    const name = asString(record?.name);
    if (mbid && name) artists.push({ mbid, name });
  }
  return artists;
}

/**
 * The best-scoring identified recording in the response, and the best score seen
 * at all.
 *
 * A result with no recordings is a fingerprint AcoustID knows but nobody has
 * linked to MusicBrainz. It is not an identification — there is no recording to
 * name — so it cannot produce a marker, however high it scores. It still counts
 * towards `bestScore`, which is diagnostic only.
 *
 * Release ids are read from the recording and, failing that, from the result
 * that carries it. Not defensive noise: which of the two levels the API nests
 * them at is the one field in this payload whose misreading changes a SAFETY
 * outcome — a commercially released recording would be reported as an unreleased
 * one, downgrading a blocking marker to a merely high one — so both are checked
 * rather than one being assumed.
 */
export function parseAcoustidResponse(payload: unknown): AcoustidResult {
  const root = asRecord(payload);
  if (!root) return { status: 'unavailable', reason: 'AcoustID returned a body that is not JSON' };

  if (root.status !== 'ok') {
    const error = asRecord(root.error);
    const message = asString(error?.message) ?? 'unspecified error';
    const code = asNumber(error?.code);
    return {
      status: 'unavailable',
      reason: `AcoustID refused the lookup: ${message}${code === undefined ? '' : ` (code ${code})`}`,
    };
  }

  let best: AcoustidRecording | undefined;
  let bestScore: number | undefined;

  for (const entry of asArray(root.results)) {
    const result = asRecord(entry);
    if (!result) continue;
    const score = asNumber(result.score);
    const acoustid = asString(result.id);
    if (score === undefined || !acoustid) continue;
    if (bestScore === undefined || score > bestScore) bestScore = score;
    if (score < ACOUSTID_MATCH_SCORE) continue;
    if (best !== undefined && score <= best.score) continue;

    for (const candidate of asArray(result.recordings)) {
      const recording = asRecord(candidate);
      const recordingMbid = asString(recording?.id);
      if (!recording || !recordingMbid) continue;

      const releaseMbids = collectMbids(recording, 'releases');
      const releaseGroupMbids = collectMbids(recording, 'releasegroups');
      best = {
        acoustid,
        score,
        recordingMbid,
        title: asString(recording.title),
        artists: readArtists(recording),
        releaseMbids: releaseMbids.length > 0 ? releaseMbids : collectMbids(result, 'releases'),
        releaseGroupMbids:
          releaseGroupMbids.length > 0 ? releaseGroupMbids : collectMbids(result, 'releasegroups'),
        durationSec: asNumber(recording.duration),
      };
      // The first recording under the best-scoring result. AcoustID orders them
      // by how many sources agree, so the head is the canonical one; picking
      // among the rest would need evidence this lookup does not have.
      break;
    }
  }

  if (best) return { status: 'match', recording: best };
  return bestScore === undefined ? { status: 'no-match' } : { status: 'no-match', bestScore };
}

// ── Lookup ──────────────────────────────────────────────────────────────────

/**
 * Identify a recording by the fingerprint that was already computed for it.
 *
 * Takes the {@link Fingerprint} `fingerprint.ts` produced rather than a file
 * path, so the audio is decoded exactly once per upload.
 */
export async function lookupByFingerprint(fingerprint: Fingerprint): Promise<AcoustidResult> {
  const key = env.ACOUSTID_API_KEY?.trim();
  if (!key) {
    return {
      status: 'unavailable',
      reason:
        'ACOUSTID_API_KEY is not set — the recording was not identified acoustically. ' +
        'Register a client key at https://acoustid.org/new-application.',
    };
  }
  return requestAcoustidLookup(key, fingerprint);
}

/**
 * The request itself, with the key supplied rather than read.
 *
 * Split from {@link lookupByFingerprint} so that "is this configured?" and "make
 * the request" are separately answerable — `env` is parsed once at import, so a
 * test that could only enter through the configured path could not reach the
 * request builder, the rate limiter or the response parsing at all. Production
 * has exactly one caller, immediately above.
 */
export async function requestAcoustidLookup(
  key: string,
  fingerprint: Fingerprint,
): Promise<AcoustidResult> {
  if (fingerprint.values.length === 0) {
    return { status: 'unavailable', reason: 'the fingerprint carries no values to look up' };
  }

  const wait = reserveRequestSlot();
  if (wait === undefined) {
    return {
      status: 'unavailable',
      reason:
        `AcoustID's ${ACOUSTID_MIN_REQUEST_INTERVAL_MS} ms request interval is already booked ` +
        `beyond the ${ACOUSTID_MAX_QUEUE_WAIT_MS} ms an upload may wait`,
    };
  }
  if (wait > 0) await delay(wait);

  const body = new URLSearchParams({
    client: key,
    format: 'json',
    meta: ACOUSTID_META,
    // Integer seconds: AcoustID buckets its index by duration and rejects a
    // fractional value. `fpcalc`'s own duration is used rather than ffprobe's,
    // because it is the duration the fingerprint was computed over.
    duration: String(Math.round(fingerprint.durationSec)),
    fingerprint: encodeChromaprint(fingerprint.values),
  });

  let payload: unknown;
  try {
    payload = await postLookup(body);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('[acoustid] lookup failed', { reason });
    return { status: 'unavailable', reason: `AcoustID lookup failed: ${reason}` };
  }

  const result = parseAcoustidResponse(payload);
  if (result.status === 'unavailable') {
    logger.warn('[acoustid] lookup was not usable', { reason: result.reason });
  }
  return result;
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * Everything an acoustic match tells us about the recording, in the vocabulary
 * the rest of the upload pipeline already speaks.
 *
 * This is the shape that gets fed to the resolvers: `musicbrainzArtistId` is
 * `resolveArtist` tier 4, `releaseMbid` and `releaseGroupMbid` are what
 * `resolveAlbum` and the Cover Art Archive fallback take, and `isrc` is what the
 * public path demands.
 */
export interface AcousticIdentity {
  acoustid: string;
  score: number;
  recordingMbid: string;
  /** Recovered from `IsrcRegistry`, when the local slice knows this recording. */
  isrc?: string;
  title?: string;
  artistName?: string;
  musicbrainzArtistId?: string;
  releaseMbid?: string;
  releaseGroupMbid?: string;
  /**
   * How many MusicBrainz releases carry this recording.
   *
   * The discriminator between "this is a published record" and "this recording
   * exists in a database". Release GROUPS count too: a group is a release
   * entity, and a recording that carries one but no specific pressing is still a
   * recording somebody released.
   */
  releaseCount: number;
}

/**
 * Identify the recording and resolve the identifiers that follow from it.
 *
 * Returns `undefined` for every outcome that is not a confident identification —
 * no key, no budget, service down, nothing above the threshold. The caller
 * cannot tell those apart, and must not: all of them mean the same thing to it,
 * which is that no new evidence arrived and whatever it was going to do stands.
 */
export async function identifyRecording(
  fingerprint: Fingerprint,
): Promise<AcousticIdentity | undefined> {
  const result = await lookupByFingerprint(fingerprint);
  if (result.status !== 'match') {
    logger.debug('[acoustid] no acoustic identification', {
      status: result.status,
      ...(result.status === 'unavailable' ? { reason: result.reason } : { bestScore: result.bestScore }),
    });
    return undefined;
  }
  return resolveAcousticIdentity(result.recording);
}

/**
 * Turn a matched recording into the identifiers the pipeline consumes.
 *
 * Separate from the lookup because it is the half that touches the database and
 * makes the judgement calls — which artist is the primary one, what counts as a
 * release — and because `identifyRecording` cannot be entered at all without a
 * configured key, which would leave this logic untestable.
 */
export async function resolveAcousticIdentity(
  recording: AcoustidRecording,
): Promise<AcousticIdentity> {
  /**
   * The ISRC comes from the local MusicBrainz slice, keyed on the recording.
   *
   * AcoustID does not serve ISRCs at any `meta` level, so this is the join that
   * turns a recording MBID into the identifier the public path asks for. It is
   * only as good as the imported dump: on a database where
   * `scripts/importIsrcRegistry.ts` has never run, this collection is empty and
   * no ISRC is recoverable — the recording is still identified, and the markers
   * still fire, because those depend on the lookup rather than on the slice.
   */
  const registryRow = await IsrcRegistryModel.findOne({ recordingMbid: recording.recordingMbid })
    .select('isrc')
    .lean();

  const primaryArtist = recording.artists[0];
  const releaseMbid = recording.releaseMbids[0];
  const releaseGroupMbid = recording.releaseGroupMbids[0];

  return {
    acoustid: recording.acoustid,
    score: recording.score,
    recordingMbid: recording.recordingMbid,
    ...(registryRow?.isrc && { isrc: registryRow.isrc }),
    ...(recording.title && { title: recording.title }),
    ...(primaryArtist && {
      artistName: primaryArtist.name,
      musicbrainzArtistId: primaryArtist.mbid,
    }),
    ...(releaseMbid && { releaseMbid }),
    ...(releaseGroupMbid && { releaseGroupMbid }),
    releaseCount: new Set([...recording.releaseMbids, ...recording.releaseGroupMbids]).size,
  };
}
