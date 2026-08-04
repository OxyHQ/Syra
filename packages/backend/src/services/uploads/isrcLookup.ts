/**
 * What recording does this ISRC name? — and is it the one that was uploaded?
 *
 * The public path refuses a file that carries no ISRC (`isrc_required`), because
 * the code is the only thing that names a RECORDING exactly rather than matching
 * a person by their name. Two tiers already try to supply one without asking:
 * the file's own `TSRC`/`ISRC` tag, and the AcoustID lookup in `acoustid.ts`.
 * Both miss the same population — AcoustID's index is community-submitted, so a
 * recording nobody has ever fingerprinted is absent from it however legitimately
 * it was released, and a file whose tags were stripped or never written carries
 * nothing either. The person holding the file usually knows the code.
 *
 * So this module exists to make a THIRD tier possible, and the whole of its
 * difficulty is that the third tier's input is a CLAIM. The first two read the
 * file; this one reads a text box. Twelve characters in the right shape are
 * trivially invented, and an invented one that was accepted would not merely be
 * useless — it would attach a stranger's recording identifier to a track, which
 * `resolveArtist` tier 1 then resolves to that stranger's artist profile AT HIGH
 * CONFIDENCE and writes as `Track.artistId`. A wrong link is an accusation. So a
 * claim is accepted only where the recording it names agrees with the audio that
 * was actually uploaded — see {@link verifyIsrcClaim}.
 *
 * ## Two sources, cheapest first
 *
 *  1. `IsrcRegistry` — the MusicBrainz slice `scripts/importIsrcRegistry.ts`
 *     imports. Local, free, unlimited, and already the ISRC authority for
 *     `resolveArtist` tier 1 and the provenance scorer.
 *  2. Deezer's public API — keyless, and the source that answered the case this
 *     feature was built for (a 2026 release MusicBrainz and AcoustID both know
 *     nothing about, which `GET /track/isrc:ESA092607944` resolves completely).
 *
 * METADATA ONLY from Deezer, and never an image. Their terms cover metadata;
 * cover art is licensed per work and Syra has its own rule against rehosting
 * another platform's artwork. The parser below reads six fields and no URL.
 *
 * ## Degraded mode is a first-class outcome
 *
 * An empty registry (the state of any database where the import has never run),
 * a Deezer outage, an exhausted rate-limit budget — all of them are
 * {@link IsrcLookupResult}'s `unavailable` arm, exactly as `acoustid.ts` handles
 * a missing key. `unavailable` is NOT a negative result, and the claim it could
 * not check is refused rather than accepted: this is the one direction in which
 * failing closed costs an uploader an upload and failing open costs somebody
 * else their attribution.
 */

import { ISRC_PATTERN, normalizeIsrc, normalizeNameKey } from '@syra/shared-types';
import { IsrcRegistryModel } from '../../models/IsrcRegistry';
import { logger } from '../../utils/logger';
import { splitArtistCredit } from './artistNames';

/** Where a resolved recording came from, so a decision can be explained. */
export type IsrcSource = 'isrc-registry' | 'deezer';

/**
 * The facts a source can give us about one recording.
 *
 * Everything except `isrc` and `source` is optional because the two sources know
 * different things: the MusicBrainz slice carries a title, an artist credit and
 * often a length, and nothing about the release it appeared on; Deezer carries
 * the release as well. `durationSec` is the only field that decides anything —
 * see {@link verifyIsrcClaim} — and a source that cannot supply it cannot verify
 * a claim at all.
 *
 * NO IMAGE FIELD, deliberately. Deezer's payload carries five cover URLs and the
 * shape a value cannot be stored in is the one that cannot be rehosted by
 * accident.
 */
export interface IsrcRecording {
  /** Normalised, so it is comparable with `Track.externalIds.isrc`. */
  isrc: string;
  source: IsrcSource;
  title?: string;
  /** The credited artist as the source writes it, joins and all. */
  artistName?: string;
  albumName?: string;
  /** As stated, at the granularity stated — `2026-06-26` or `1998`. */
  releaseDate?: string;
  /** How many tracks the release carries. Known to Deezer, not to the slice. */
  totalTracks?: number;
  /** The release's genres, as the source names them. Deezer only. */
  genres?: string[];
  durationSec?: number;
}

/**
 * `found` — a source resolved the code.
 * `not-found` — every source was asked and none knows it. A real negative.
 * `unavailable` — nothing could be asked. NOT a negative result.
 */
export type IsrcLookupResult =
  | { status: 'found'; recording: IsrcRecording }
  | { status: 'not-found' }
  | { status: 'unavailable'; reason: string };

/**
 * Discovery can answer a weaker question than lookup can.
 *
 * `attributed` means a registered recording agrees on title AND artist but not
 * on length: WHO made this is established, WHICH recording it is is not. The
 * distinction exists because editions are real and because the search that finds
 * them is incomplete — see the note at the fallback in `discoverIsrc`.
 */
export type IsrcDiscoveryResult = IsrcLookupResult | { status: 'attributed' };

// ── Deezer ──────────────────────────────────────────────────────────────────

/**
 * The endpoint. A constant with the code appended, never a URL built from
 * anything else in an uploaded file — and the code is checked against
 * {@link ISRC_PATTERN} before it is appended, so the only characters that can
 * reach the path are `A-Z` and `0-9`.
 */
const DEEZER_TRACK_BY_ISRC_URL = 'https://api.deezer.com/track/isrc:';
const DEEZER_ALBUM_URL = 'https://api.deezer.com/album/';

/** Identifies Syra with a contact URL, as the other outbound clients do. */
const DEEZER_USER_AGENT = 'SyraCatalogEnrichment/1.0 (+https://syra.fm)';

/**
 * Deezer publishes a limit of 50 requests per 5 seconds. 200 ms between requests
 * is 5/s — half the permitted rate, which is the margin that matters for a limit
 * measured over a WINDOW rather than per request: a burst that respects the
 * average can still exceed the window, and there is nothing to gain here from
 * being close to the ceiling. An upload asks at most twice (the track, then its
 * release).
 */
export const DEEZER_MIN_REQUEST_INTERVAL_MS = 200;

/**
 * The longest a caller waits for a slot before giving up.
 *
 * Same discipline as `acoustid.ts`: the answer is needed BEFORE the upload is
 * accepted or refused, so the call is inline by necessity and the protection is
 * that it is bounded. Past the bound no request is made and the caller gets
 * `unavailable`, which refuses the claim rather than trusting it.
 */
export const DEEZER_MAX_QUEUE_WAIT_MS = 1_500;

/** A single request's own ceiling, on top of any queue wait. */
const DEEZER_REQUEST_TIMEOUT_MS = 5_000;

/** How long a resolved (or definitively unresolved) code stays cached. */
export const ISRC_LOOKUP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Cap on cached codes, so a long-running process cannot grow without bound. */
const ISRC_LOOKUP_CACHE_MAX_ENTRIES = 2_000;

let nextRequestSlotAt = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Claim the next slot, or refuse when it is further away than a caller with an
 * upload waiting on it can afford. Returns the milliseconds to wait first.
 */
function reserveRequestSlot(): number | undefined {
  const now = Date.now();
  const startAt = Math.max(now, nextRequestSlotAt);
  const wait = startAt - now;
  if (wait > DEEZER_MAX_QUEUE_WAIT_MS) return undefined;
  nextRequestSlotAt = startAt + DEEZER_MIN_REQUEST_INTERVAL_MS;
  return wait;
}

/**
 * The network call, behind a swappable reference — the seam `acoustid.ts` and
 * `enrichmentHttp.ts` both expose, for the same reason: the parser has to face
 * the payload shape this API really produces without the test suite making
 * requests to a service that owes us nothing.
 *
 * Resolves to `undefined` for "this source has nothing" (a 404, a rate-limit
 * response, a body that is not JSON) and REJECTS for a transport failure, so the
 * caller can tell a negative answer from no answer.
 */
export type DeezerFetch = (url: string) => Promise<unknown | undefined>;

let deezerFetch: DeezerFetch | undefined;

export function setDeezerFetchForTests(implementation?: DeezerFetch): void {
  deezerFetch = implementation;
  resetIsrcLookupForTests();
}

/** Drop every cached answer and every rate-limit reservation. */
export function resetIsrcLookupForTests(): void {
  cache.clear();
  nextRequestSlotAt = 0;
}

async function requestDeezer(url: string): Promise<unknown | undefined> {
  if (deezerFetch) return deezerFetch(url);

  const wait = reserveRequestSlot();
  if (wait === undefined) {
    throw new Error(
      `Deezer's ${DEEZER_MIN_REQUEST_INTERVAL_MS} ms request interval is already booked beyond ` +
        `the ${DEEZER_MAX_QUEUE_WAIT_MS} ms an upload may wait`,
    );
  }
  if (wait > 0) await delay(wait);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEEZER_REQUEST_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': DEEZER_USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      logger.warn('[isrc] Deezer responded with an error status', { status: response.status });
      return undefined;
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ── Payload readers ─────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Deezer answers a code it does not know with `200 OK` and an error OBJECT
 * (`{"error":{"type":"DataException","message":"no data","code":800}}`), not
 * with a 404. Reading the presence of `error` rather than the HTTP status is
 * therefore what distinguishes "no such recording" from "here is the recording",
 * and a parser that trusted the status would report every unknown code as a
 * successful resolution of a track with no fields.
 */
export function parseDeezerTrack(payload: unknown, isrc: string): IsrcRecording | undefined {
  const root = asRecord(payload);
  if (!root || asRecord(root.error)) return undefined;

  // The code echoed back is the authority over the one we asked with: Deezer
  // resolves through its own catalogue, and a payload that names a different
  // code is not an answer to this question.
  const resolved = asString(root.isrc);
  if (!resolved || normalizeIsrc(resolved) !== isrc) return undefined;

  const album = asRecord(root.album);
  const title = asString(root.title);
  const artistName = asString(asRecord(root.artist)?.name);
  const albumName = asString(album?.title);
  // The track's own release date, falling back to the release's. Deezer states
  // both at day granularity; neither is widened or narrowed here.
  const releaseDate = asString(root.release_date) ?? asString(album?.release_date);
  const durationSec = asPositiveNumber(root.duration);

  return {
    isrc,
    source: 'deezer',
    ...(title && { title }),
    ...(artistName && { artistName }),
    ...(albumName && { albumName }),
    ...(releaseDate && { releaseDate }),
    ...(durationSec !== undefined && { durationSec }),
  };
}

/** The album id carried on a track payload, when there is one to follow. */
function deezerAlbumId(payload: unknown): string | undefined {
  const id = asRecord(asRecord(payload)?.album)?.id;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? String(id) : undefined;
}

/**
 * `nb_tracks` off the release.
 *
 * Worth a second request because of what it prevents rather than what it adds:
 * `classifyAlbumType` reads "under thirty minutes" as EP-shaped, and a
 * contributed release with no track count has already been mis-typed that way
 * once. A file that declares its own `TRCK` total never reaches here — the
 * gap-filling rule is that the file always wins.
 */
export function parseDeezerAlbumTrackCount(payload: unknown): number | undefined {
  const root = asRecord(payload);
  if (!root || asRecord(root.error)) return undefined;
  const count = asPositiveNumber(root.nb_tracks);
  return count !== undefined && Number.isInteger(count) ? count : undefined;
}

/**
 * The release's genres.
 *
 * Deezer states these on the RELEASE, not the track, which is why they are read
 * from the same payload the track count comes from rather than costing a third
 * request. Metadata, like everything else taken from this source — the artwork
 * URLs alongside them are licensed per work and are not read.
 *
 * Worth recovering because a file frequently carries no genre tag at all, and
 * `/browse` is built ENTIRELY from the genres of the tracks in the catalogue:
 * a catalogue of ungenred tracks renders an empty browse screen no matter how
 * much music is in it.
 */
export function parseDeezerAlbumGenres(payload: unknown): string[] {
  const root = asRecord(payload);
  if (!root || asRecord(root.error)) return [];
  const container = asRecord(root.genres);
  if (!container || !Array.isArray(container.data)) return [];

  const names: string[] = [];
  for (const entry of container.data) {
    const name = asString(asRecord(entry)?.name);
    // Deezer repeats a genre across a release's sub-entries; the catalogue wants
    // it once.
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// ── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  expiresAt: number;
  result: IsrcLookupResult;
}

/**
 * Keyed by the normalised code. Caches `found` AND `not-found`, and never
 * `unavailable`: a transient failure that stuck for a day would refuse every
 * later upload of a recording that resolves perfectly well, while a code that
 * genuinely resolves nowhere is exactly the one a frustrated uploader retries.
 */
const cache = new Map<string, CacheEntry>();

function readCache(isrc: string): IsrcLookupResult | undefined {
  const entry = cache.get(isrc);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(isrc);
    return undefined;
  }
  // Refresh insertion order, so eviction is least-recently-USED.
  cache.delete(isrc);
  cache.set(isrc, entry);
  return entry.result;
}

function writeCache(isrc: string, result: IsrcLookupResult): void {
  if (result.status === 'unavailable') return;
  cache.set(isrc, { expiresAt: Date.now() + ISRC_LOOKUP_CACHE_TTL_MS, result });
  while (cache.size > ISRC_LOOKUP_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** The MusicBrainz slice, which is a point query on a unique index. */
async function resolveFromRegistry(isrc: string): Promise<IsrcRecording | undefined> {
  const row = await IsrcRegistryModel.findOne({ isrc })
    .select('isrc title artistCredit lengthMs')
    .lean();
  if (!row) return undefined;

  return {
    isrc,
    source: 'isrc-registry',
    ...(row.title && { title: row.title }),
    ...(row.artistCredit && { artistName: row.artistCredit }),
    // Milliseconds in the dump, seconds everywhere in this pipeline.
    ...(row.lengthMs !== undefined && row.lengthMs > 0 && { durationSec: row.lengthMs / 1000 }),
  };
}

async function resolveFromDeezer(isrc: string): Promise<IsrcLookupResult> {
  let payload: unknown;
  try {
    payload = await requestDeezer(`${DEEZER_TRACK_BY_ISRC_URL}${isrc}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('[isrc] Deezer lookup failed', { reason });
    return { status: 'unavailable', reason: `Deezer lookup failed: ${reason}` };
  }

  if (payload === undefined) {
    return { status: 'unavailable', reason: 'Deezer returned no usable response' };
  }

  const recording = parseDeezerTrack(payload, isrc);
  if (!recording) return { status: 'not-found' };

  /**
   * The release's track count, best-effort. A failure here leaves the recording
   * exactly as it is: nothing about VERIFICATION depends on it, so a second
   * request that does not come back must not cost the uploader a resolution the
   * first request already produced.
   */
  const albumId = deezerAlbumId(payload);
  if (albumId) {
    try {
      const albumPayload = await requestDeezer(`${DEEZER_ALBUM_URL}${albumId}`);
      const totalTracks = parseDeezerAlbumTrackCount(albumPayload);
      const genres = parseDeezerAlbumGenres(albumPayload);
      if (totalTracks !== undefined || genres.length > 0) {
        return {
          status: 'found',
          recording: {
            ...recording,
            ...(totalTracks !== undefined && { totalTracks }),
            ...(genres.length > 0 && { genres }),
          },
        };
      }
    } catch (err) {
      logger.debug('[isrc] Deezer release lookup failed; the recording still resolved', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { status: 'found', recording };
}

/**
 * Resolve an ISRC to the recording it names.
 *
 * The registry is asked first because it is local and unlimited. It does NOT end
 * the search on its own, though: a row with no `lengthMs` identifies the
 * recording without being able to corroborate anything about the audio, and the
 * duration is the only field that can (see {@link verifyIsrcClaim}). So a
 * registry hit that cannot answer the length falls through to Deezer, and the
 * registry row is kept only as the fallback for a Deezer that has nothing to
 * say. This is the difference between "we know of this code" and "we can check
 * this code", and only the second is worth a network request.
 */
export async function resolveIsrc(rawIsrc: string): Promise<IsrcLookupResult> {
  const isrc = normalizeIsrc(rawIsrc);
  if (!ISRC_PATTERN.test(isrc)) {
    // Unreachable from the API — `isrcSchema` rejects a malformed code with a
    // 400 long before this. Handled rather than thrown so that a future caller
    // that forgets the schema fails CLOSED, and so the URL below can only ever
    // be built from `[A-Z0-9]`.
    logger.warn('[isrc] refusing to resolve a malformed code');
    return { status: 'not-found' };
  }

  const cached = readCache(isrc);
  if (cached) return cached;

  const registryRecording = await resolveFromRegistry(isrc);
  if (registryRecording?.durationSec !== undefined) {
    const result: IsrcLookupResult = { status: 'found', recording: registryRecording };
    writeCache(isrc, result);
    return result;
  }

  const deezer = await resolveFromDeezer(isrc);
  if (deezer.status === 'found') {
    writeCache(isrc, deezer);
    return deezer;
  }

  if (registryRecording) {
    const result: IsrcLookupResult = { status: 'found', recording: registryRecording };
    writeCache(isrc, result);
    return result;
  }

  writeCache(isrc, deezer);
  return deezer;
}

// ── Verification ────────────────────────────────────────────────────────────

/**
 * How far the uploaded audio's measured length may sit from the length the
 * resolved recording reports.
 *
 * Three seconds, and it is a budget rather than a round number:
 *
 *  - **1 s for the report's own resolution.** Deezer states whole seconds
 *    (`duration: 191` for a file `ffprobe` measures at 191.92 s), so up to a
 *    second is lost before any real disagreement exists.
 *  - **~2 s for master-to-master variation.** The same recording released twice
 *    differs by the lead-in and fade the mastering engineer trimmed, plus
 *    encoder delay and the padding a lossy encoder appends. This is the part
 *    that cannot be measured away.
 *
 * The reason it is not wider: this check is the ONLY one in the verification
 * that reads something nobody typed. The title and the artist come from the
 * file's tags, which whoever supplied the claim can also edit; the duration
 * comes from `ffprobe` reading the audio. So the tolerance is what decides how
 * many recordings a fabricated code could plausibly be attached to, and the
 * realistic near-miss — an alternate take, a radio edit, a live version, all of
 * which share the title and the artist — is tens of seconds away, not three.
 *
 * The cost of being wrong in each direction is asymmetric, which settles it: too
 * tight refuses a legitimate uploader, who can still keep the file privately;
 * too loose writes another artist's identifier onto a track, which
 * `resolveArtist` tier 1 then turns into a HIGH-confidence link to that artist's
 * profile.
 */
export const ISRC_DURATION_TOLERANCE_SEC = 3;

/** What the uploaded file itself says, as distinct from what the uploader typed. */
export interface IsrcClaimEvidence {
  /** `ffprobe`'s measurement of the audio. Measured, not declared. */
  durationSec: number;
  /** The file's own title tag. */
  title?: string;
  /** The file's own artist tag, credit string and all. */
  artistName?: string;
  /** The file's own albumartist tag, which differs on compilations and features. */
  albumArtistName?: string;
}

/** Which part of the claim contradicted the file. */
export type IsrcClaimDisagreement = 'duration' | 'title' | 'artist';

/**
 * A resolved recording whose length is known.
 *
 * The distinction is load-bearing rather than pedantic: a source that cannot
 * state a length cannot verify anything, so a verdict of `verified` or
 * `mismatch` is only ever reached with the duration in hand. Saying so in the
 * type is what lets a caller quote the length in a refusal without inventing a
 * fallback for a case that cannot occur.
 */
export type MeasurableIsrcRecording = IsrcRecording & { durationSec: number };

/**
 * `verified` — the recording named by the code is the audio that was uploaded.
 * `mismatch` — it resolved, and it is a different recording. `disagreed` names
 *   the fields that said so, so a mistyped character reads differently from a
 *   code copied off the wrong row.
 * `unverifiable` — nothing could check it: no source knows the code, or the one
 *   that does cannot state a length.
 */
export type IsrcClaimVerdict =
  | { status: 'verified'; recording: MeasurableIsrcRecording }
  | { status: 'mismatch'; recording: MeasurableIsrcRecording; disagreed: IsrcClaimDisagreement[] }
  | { status: 'unverifiable'; reason: string };

/**
 * Every spelling of a name that should count as the same name.
 *
 * A credit and its principal artist are the same artist — `Nadia Ortiz feat.
 * Kofi Mensah` in the file against `Nadia Ortiz` in the registry is an agreement
 * — so `splitArtistCredit` (the codebase's one credit splitter) contributes the
 * principal alongside the whole string. Empty keys are dropped: a file with no
 * artist tag must not match a recording with no artist credit by both being
 * blank.
 */
function nameKeys(...values: Array<string | undefined>): Set<string> {
  const keys = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const candidate of [value, splitArtistCredit(value).primary]) {
      const key = normalizeNameKey(candidate);
      if (key) keys.add(key);
    }
  }
  return keys;
}

function anyKeyInCommon(left: Set<string>, right: Set<string>): boolean {
  for (const key of left) {
    if (right.has(key)) return true;
  }
  return false;
}

/**
 * Is the uploader's claimed ISRC consistent with the file they uploaded?
 *
 * The rule, and why it is two conditions rather than one:
 *
 *  - the DURATION must agree, within {@link ISRC_DURATION_TOLERANCE_SEC}. This
 *    is the load-bearing half, because it is the only comparison against
 *    something measured from the audio rather than read out of a text field.
 *  - AND the title OR the artist must agree, after `normalizeNameKey`. Either,
 *    not both: a Spanish release routinely carries the artist's name spelled one
 *    way in the file and another in a distributor's database, and a compilation
 *    credits the album's artist where the recording credits the performer.
 *    Requiring both would refuse correct codes for a formatting difference.
 *
 * The names are read from the FILE'S OWN TAGS and never from the uploader's
 * override fields, which is the point of the second condition: a value typed on
 * the same form as the claim corroborates nothing, because it is the same person
 * asserting the same thing twice.
 *
 * A file that declares neither a title nor an artist has nothing to corroborate
 * with and is refused as a mismatch rather than accepted on the duration alone —
 * the tolerance admits a window that thousands of unrelated recordings sit in,
 * and "this is about three minutes long" is not an identification.
 */
export async function verifyIsrcClaim(
  isrc: string,
  evidence: IsrcClaimEvidence,
): Promise<IsrcClaimVerdict> {
  const lookup = await resolveIsrc(isrc);

  if (lookup.status === 'unavailable') {
    return { status: 'unverifiable', reason: lookup.reason };
  }
  if (lookup.status === 'not-found') {
    return {
      status: 'unverifiable',
      reason: 'no source knows this ISRC',
    };
  }

  const { durationSec } = lookup.recording;
  if (durationSec === undefined) {
    return {
      status: 'unverifiable',
      reason:
        `${lookup.recording.source} knows this ISRC but states no length ` +
        'to check the audio against',
    };
  }
  const recording: MeasurableIsrcRecording = { ...lookup.recording, durationSec };

  const disagreed: IsrcClaimDisagreement[] = [];

  if (Math.abs(durationSec - evidence.durationSec) > ISRC_DURATION_TOLERANCE_SEC) {
    disagreed.push('duration');
  }

  const titleAgrees = anyKeyInCommon(nameKeys(evidence.title), nameKeys(recording.title));
  const artistAgrees = anyKeyInCommon(
    nameKeys(evidence.artistName, evidence.albumArtistName),
    nameKeys(recording.artistName),
  );
  if (!titleAgrees && !artistAgrees) {
    // Both are reported, because neither one alone is what failed: the rule is
    // that either would have sufficed, so the uploader is owed both names to
    // compare against what their file says.
    disagreed.push('title', 'artist');
  }

  if (disagreed.length > 0) return { status: 'mismatch', recording, disagreed };
  return { status: 'verified', recording };
}

// ── Discovery ───────────────────────────────────────────────────────────────

/**
 * Deezer's search endpoint, used ONLY to turn a file's own tags back into the
 * recording identifier that names it.
 *
 * This is the metadata half of what Deezer's terms permit, and deliberately not
 * the other half: the response also carries `cover_*` artwork URLs, which are
 * licensed per work and are never read here or anywhere downstream. What is
 * taken is the ISRC — an identifier the file's rights-holder was assigned and
 * that no one licenses.
 */
export const DEEZER_SEARCH_URL = 'https://api.deezer.com/search?q=';
const DEEZER_TRACK_BY_ID_URL = 'https://api.deezer.com/track/';

/**
 * How many search hits are considered before giving up.
 *
 * Deezer orders by its own relevance, and a recording that is not in the first
 * few hits for its own exact title and artist is not going to be identified
 * correctly by looking further down — past that point the extra hits are other
 * recordings, and every one of them is a chance to attach the WRONG code.
 */
export const ISRC_DISCOVERY_MAX_CANDIDATES = 5;

/** A search hit, reduced to the fields discovery is allowed to judge it on. */
export interface DeezerSearchCandidate {
  id: string;
  title?: string;
  artistName?: string;
  durationSec?: number;
}

export function parseDeezerSearchCandidates(payload: unknown): DeezerSearchCandidate[] {
  const root = asRecord(payload);
  if (!root || asRecord(root.error) || !Array.isArray(root.data)) return [];

  const candidates: DeezerSearchCandidate[] = [];
  for (const entry of root.data.slice(0, ISRC_DISCOVERY_MAX_CANDIDATES)) {
    const record = asRecord(entry);
    if (!record) continue;
    // Deezer states ids as numbers; anything else is not addressable and is
    // dropped rather than coerced into a URL path.
    const id = asPositiveNumber(record.id);
    if (id === undefined) continue;
    const title = asString(record.title);
    const artistName = asString(asRecord(record.artist)?.name);
    const durationSec = asPositiveNumber(record.duration);
    candidates.push({
      id: String(id),
      ...(title && { title }),
      ...(artistName && { artistName }),
      ...(durationSec !== undefined && { durationSec }),
    });
  }
  return candidates;
}

/**
 * Does this search hit describe the SAME recording as the uploaded file?
 *
 * Both names AND the duration must agree — deliberately stricter than
 * {@link verifyIsrcClaim}, which accepts either name. The two answer different
 * questions. Verification starts from a code a human typed and asks whether the
 * file contradicts it; a disagreeing title with an agreeing artist is a
 * plausible tagging difference there. Discovery starts from nothing and ASSIGNS
 * a code on this evidence alone, so a single agreeing field is not enough: a
 * prolific artist has many recordings and matching only the artist would pick
 * one at random and stamp its identifier onto a different song. A wrong code
 * links the track to a stranger's artist profile at high confidence.
 */
function namesAgree(candidate: DeezerSearchCandidate, evidence: IsrcClaimEvidence): boolean {
  if (!anyKeyInCommon(nameKeys(evidence.title), nameKeys(candidate.title))) return false;
  return anyKeyInCommon(
    nameKeys(evidence.artistName, evidence.albumArtistName),
    nameKeys(candidate.artistName),
  );
}

function candidateMatches(candidate: DeezerSearchCandidate, evidence: IsrcClaimEvidence): boolean {
  if (candidate.durationSec === undefined) return false;
  if (Math.abs(candidate.durationSec - evidence.durationSec) > ISRC_DURATION_TOLERANCE_SEC) {
    return false;
  }
  return namesAgree(candidate, evidence);
}

/**
 * Find the ISRC of an uploaded recording from what the file already says.
 *
 * The fourth tier, and the one that removes the last routine reason to refuse a
 * legitimate upload. Tags supply the code, AcoustID supplies it for anything
 * ever fingerprinted, the uploader can type it — and this covers the case all
 * three miss together: a real commercial release, tagged with its title and
 * artist but no `TSRC`, that nobody has submitted to AcoustID. That is not an
 * edge case; it is what a file downloaded from a stream ripper looks like, and
 * it was making the public path demand a code the uploader had no way to know.
 *
 * `not-found` here is a real negative and the caller may still refuse; the
 * point is that it now refuses files that genuinely cannot be identified rather
 * than files that merely arrived without a tag.
 */
export async function discoverIsrc(evidence: IsrcClaimEvidence): Promise<IsrcDiscoveryResult> {
  if (!evidence.title || !(evidence.artistName ?? evidence.albumArtistName)) {
    return {
      status: 'unavailable',
      reason: 'the file states no title and artist to search a recording by',
    };
  }

  // Deezer's advanced syntax, so the terms are matched as the fields they are
  // rather than as loose text. Both values are quoted and URL-encoded: they come
  // from an uploaded file's tags and are the one part of this URL that is not a
  // constant.
  const artist = evidence.artistName ?? evidence.albumArtistName ?? '';
  const query = `artist:"${artist.replace(/"/g, '')}" track:"${evidence.title.replace(/"/g, '')}"`;

  let candidates: DeezerSearchCandidate[];
  try {
    candidates = parseDeezerSearchCandidates(await requestDeezer(DEEZER_SEARCH_URL + encodeURIComponent(query)));
  } catch (error: unknown) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : 'the recording search could not be reached',
    };
  }

  const match = candidates.find((candidate) => candidateMatches(candidate, evidence));
  if (!match) {
    /**
     * Nothing matched on all three, but a hit agreeing on title AND artist has
     * still established WHO made this — and that is the question the public path
     * actually needs answered.
     *
     * A release exists in editions: album cut, single, live, remix, each its own
     * recording with its own length. Two files from one album went different ways
     * here purely because one happened to match the edition Deezer's search
     * surfaced first — and that search is demonstrably incomplete, so which
     * edition it returns is not a fact about the music. Refusing on it published
     * one track and rejected its neighbour.
     *
     * So the artist is reported without a code. The caller may attribute; nothing
     * may claim this audio is a recording measured at another length.
     */
    return candidates.some((candidate) => namesAgree(candidate, evidence))
      ? { status: 'attributed' }
      : { status: 'not-found' };
  }

  // The search result does not carry the code — only the track resource does —
  // so identifying the recording and reading its identifier are two calls.
  let recording: IsrcRecording | undefined;
  try {
    const payload = asRecord(await requestDeezer(DEEZER_TRACK_BY_ID_URL + encodeURIComponent(match.id)));
    const isrc = payload && !asRecord(payload.error) ? asString(payload.isrc) : undefined;
    recording = isrc ? parseDeezerTrack(payload, normalizeIsrc(isrc)) : undefined;
  } catch (error: unknown) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : 'the recording could not be read',
    };
  }

  if (!recording) return { status: 'not-found' };
  return { status: 'found', recording };
}
