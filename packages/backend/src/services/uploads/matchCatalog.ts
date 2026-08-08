/**
 * "Is this already on Syra?" — the dedup chain, first hit wins.
 *
 * It answers two questions at once, and they route differently:
 *  - the bytes are already in the PUBLIC CATALOG → nothing is stored; the client
 *    adds the existing track to the library. Legally the cleanest outcome there
 *    is: playing catalog is playing catalog.
 *  - the bytes are already in the UPLOADER'S OWN LOCKER → a duplicate; point them
 *    at the copy they already have.
 *
 * Tiers, in strictly decreasing order of confidence:
 *
 *  1. `sha256` — the identical file, byte for byte. One indexed point query.
 *  2. `externalIds.isrc` — the same recording by its global identifier. The
 *     sparse-unique index already exists on `Track`.
 *  3. Chromaprint — the same audio, transcoded or retagged. Candidates come from
 *     a `TrackFingerprint` duration bucket, then each is verified by bit error
 *     rate; nothing matches on the bucket alone.
 *  4. Fuzzy — normalised title + normalised artist + duration within ±2 s. The
 *     weakest tier, and the only one that can be fooled by a cover version, so it
 *     runs last and only when everything stronger has abstained.
 *
 * Tier 4 and its `normalizeForFuzzy` are RECOVERED VERBATIM from the deleted
 * `services/catalog/upsertTrack.ts` (`git show 8e28464^`) rather than rewritten:
 * it is the same comparison, already reviewed and already tested, and a
 * re-derivation that normalised even slightly differently would make two code
 * paths disagree about whether two tracks are the same track.
 */

import { and, between, eq } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { trackFingerprints, tracks } from '../../db/schema/catalog';
import { isPlayableTrack, playableTrackFilter } from '../../db/catalog/visibility';
import { findUploadBySha256 } from '../../db/creators/uploads';
import { compareFingerprints, FINGERPRINT_MIN_OVERLAP_ITEMS } from './fingerprint';

/**
 * Normalize a string for fuzzy title/artist matching:
 * lowercase → Unicode NFC → strip diacritics → strip non-alphanumeric → collapse whitespace.
 */
export function normalizeForFuzzy(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Result ──────────────────────────────────────────────────────────────────

export type MatchTier = 'sha256' | 'isrc' | 'fingerprint' | 'fuzzy';

export interface CatalogTrackMatch {
  kind: 'track';
  trackId: string;
  tier: MatchTier;
  /** Present for a fingerprint match — the audit trail behind the decision. */
  bitErrorRate?: number;
  /**
   * The credited artist of the matched track. Carried so a caller can tell
   * "same recording, filed under someone else" — which is a provenance marker
   * and, for artist resolution, a high-confidence signal.
   */
  artistId: string;
  artistName: string;
}

export interface LockerMatch {
  kind: 'upload';
  uploadId: string;
  tier: MatchTier;
}

/**
 * A recording this audio acoustically IS, which was nonetheless not deduped
 * against — because it is not playable.
 *
 * The distinction is the whole point. `matchCatalog` narrows every catalog read
 * through `playableTrackFilter`, so a taken-down or unpublished recording can
 * never become a match: handing a listener a track they cannot play would be a
 * worse outcome than storing their upload. But the acoustic evidence is real and
 * throwing it away is what made the `fingerprint.other-artist` marker
 * unreachable — and, far worse, let somebody re-upload a recording Syra removed
 * for copyright and receive a completely clean screening report.
 *
 * So the match is declined and the evidence is kept, on the `none` arm, where it
 * feeds screening and artist resolution rather than deduplication.
 */
export interface AcousticNeighbour {
  trackId: string;
  artistId: string;
  artistName: string;
  bitErrorRate: number;
  /**
   * The recording was removed for copyright. This is the strongest provenance
   * signal the system has — we have already judged this exact audio infringing.
   */
  copyrightRemoved: boolean;
}

export type MatchResult =
  | CatalogTrackMatch
  | LockerMatch
  | { kind: 'none'; nearestFingerprint?: AcousticNeighbour };

/** What the chain needs to know about the file being screened. */
export interface MatchCandidate {
  sha256: string;
  durationSec: number;
  title?: string;
  artistName?: string;
  isrc?: string;
  /** Raw Chromaprint values, absent when `fpcalc` was unavailable. */
  fingerprint?: number[];
}

/**
 * Candidate window for the fingerprint bucket. Wider than the fuzzy tier's ±2 s
 * because a transcode can shift a duration by a frame or two at each end and the
 * bit error rate — not the bucket — is what actually decides the match.
 */
const FINGERPRINT_DURATION_WINDOW_SEC = 3;

/** Candidate window for the fuzzy tier, unchanged from the recovered implementation. */
const FUZZY_DURATION_WINDOW_SEC = 2;

/**
 * How many fingerprint candidates are compared before the tier gives up.
 *
 * A duration bucket in a large catalog holds thousands of recordings and each
 * comparison walks 81 alignments over a few hundred int32s. The cap bounds the
 * work per upload; the tier is a fast path, and tier 4 still runs behind it.
 */
const MAX_FINGERPRINT_CANDIDATES = 500;

// ── The columns every tier reads off a matched track ────────────────────────

/**
 * A catalog track, as this module needs it: an identity and its credited
 * artist, and nothing else.
 *
 * Named columns rather than the row. `tracks.sha256` is one of the two columns
 * `PROTECTED_COLUMNS_BY_TABLE` protects, and a whole-row read would carry it
 * into a `MatchResult` a controller hands onward. Matching ON it is unaffected
 * — a `WHERE` clause is not a projection.
 */
const MATCHED_TRACK_COLUMNS = {
  id: tracks.id,
  artistId: tracks.artistId,
  artistName: tracks.artistName,
} as const;

interface MatchedTrack {
  id: string;
  artistId: string;
  artistName: string;
}

// ── Tier 1: identical bytes ─────────────────────────────────────────────────

/**
 * The catalog half of tier 1: the same bytes already ingested publicly.
 *
 * Every track that predates the `sha256` field has no hash, so this tier simply
 * cannot answer for the back catalog. Tiers 2–4 cover those, which is why the
 * chain continues rather than concluding.
 */
async function findCatalogTrackByHash(sha256: string): Promise<MatchedTrack | null> {
  const [track] = await getDb()
    .select(MATCHED_TRACK_COLUMNS)
    .from(tracks)
    .where(and(eq(tracks.sha256, sha256), playableTrackFilter()))
    .limit(1);

  return track ?? null;
}

/**
 * The uploader's own locker — the only locker any match may look inside.
 *
 * The Mongo read spelled "not soft-deleted" as `deletedAt: { $exists: false }`
 * while `uploads.controller` spelled the same thing `deletedAt: null`. Those
 * are different predicates in Mongo and agreed only because nothing ever stored
 * an explicit null; `deleted_at is null` is both of them, so the divergence
 * disappears at the port rather than being carried forward.
 */
async function findOwnUploadByHash(
  sha256: string,
  ownerOxyUserId: string,
): Promise<LockerMatch | undefined> {
  const existing = await findUploadBySha256(ownerOxyUserId, sha256);
  return existing ? { kind: 'upload', uploadId: existing.id, tier: 'sha256' } : undefined;
}

// ── Tier 2: ISRC ────────────────────────────────────────────────────────────

async function findCatalogTrackByIsrc(isrc: string): Promise<MatchedTrack | null> {
  const [track] = await getDb()
    .select(MATCHED_TRACK_COLUMNS)
    .from(tracks)
    .where(and(eq(tracks.externalIsrc, isrc.toUpperCase()), playableTrackFilter()))
    .limit(1);

  return track ?? null;
}

// ── Tier 3: Chromaprint ─────────────────────────────────────────────────────

interface FingerprintOutcome {
  /** A playable catalog recording — a real dedup hit. */
  match?: { track: MatchedTrack; bitErrorRate: number };
  /** The same audio, in a recording nobody can play. Evidence, not a match. */
  neighbour?: AcousticNeighbour;
}

/**
 * Narrow by duration, then decide by bit error rate.
 *
 * Abstains — returns nothing, never a guess — when the upload has no fingerprint
 * (`fpcalc` unavailable) or when its fingerprint is too short to overlap a
 * candidate by {@link FINGERPRINT_MIN_OVERLAP_ITEMS} items. A short fingerprint
 * compared anyway produces confident false matches; see the measured table on
 * that constant.
 *
 * Only candidates that CROSS the match threshold are considered. A sub-threshold
 * "nearest" candidate is deliberately not reported: at BER 0.15 the two are
 * different recordings, and passing that to the provenance scorer as evidence
 * would manufacture a marker out of noise, on exactly the uploads least able to
 * argue with it.
 */
async function findCatalogTrackByFingerprint(
  candidate: MatchCandidate,
): Promise<FingerprintOutcome> {
  const { fingerprint } = candidate;
  if (!fingerprint || fingerprint.length < FINGERPRINT_MIN_OVERLAP_ITEMS) return {};

  const bucket = await getDb()
    .select({
      trackId: trackFingerprints.trackId,
      fingerprint: trackFingerprints.fingerprint,
    })
    .from(trackFingerprints)
    .where(
      between(
        trackFingerprints.fingerprintDurationSec,
        candidate.durationSec - FINGERPRINT_DURATION_WINDOW_SEC,
        candidate.durationSec + FINGERPRINT_DURATION_WINDOW_SEC
      )
    )
    .limit(MAX_FINGERPRINT_CANDIDATES);

  let best: { trackId: string; bitErrorRate: number } | undefined;
  for (const entry of bucket) {
    const comparison = compareFingerprints(fingerprint, entry.fingerprint);
    if (!comparison.matched || comparison.bitErrorRate === undefined) continue;
    if (!best || comparison.bitErrorRate < best.bitErrorRate) {
      best = { trackId: entry.trackId, bitErrorRate: comparison.bitErrorRate };
    }
  }
  if (!best) return {};

  // The fingerprint index is deliberately NOT visibility-aware: a takedown sets
  // `copyrightRemoved` on the track and leaves its fingerprint row in place,
  // because that row is how the same recording gets caught next time. So the
  // track is read WITHOUT the catalog predicate — the state is the answer, not a
  // reason to skip the read. That is also why the two playability columns are
  // selected here and nowhere else in this module: this is the one tier that
  // has to look at a track it may not match.
  const [track] = await getDb()
    .select({
      ...MATCHED_TRACK_COLUMNS,
      isAvailable: tracks.isAvailable,
      copyrightRemoved: tracks.copyrightRemoved,
    })
    .from(tracks)
    .where(eq(tracks.id, best.trackId))
    .limit(1);

  if (!track) return {};

  if (isPlayableTrack(track)) {
    return {
      match: {
        track: { id: track.id, artistId: track.artistId, artistName: track.artistName },
        bitErrorRate: best.bitErrorRate,
      },
    };
  }

  return {
    neighbour: {
      trackId: track.id,
      artistId: track.artistId,
      artistName: track.artistName,
      bitErrorRate: best.bitErrorRate,
      copyrightRemoved: track.copyrightRemoved,
    },
  };
}

// ── Tier 4: fuzzy ───────────────────────────────────────────────────────────

/**
 * Find an existing track by fuzzy key: normalized title + normalized primary
 * artist name + duration within ±2 seconds.
 *
 * NOTE: The fuzzy match stores `artistName` as plain text, so we compare the
 * normalized form of the stored `artistName` against the normalized incoming
 * artist name in-process after a narrow duration range query.
 */
async function findCatalogTrackByFuzzy(
  title: string,
  artistName: string,
  durationSec: number,
): Promise<MatchedTrack | null> {
  const normTitle = normalizeForFuzzy(title);
  const normArtist = normalizeForFuzzy(artistName);
  if (!normTitle || !normArtist) return null;

  // Pull candidates within the ±2s window; normalize and compare in-process.
  // The duration window keeps the candidate set small.
  const candidates = await getDb()
    .select({ ...MATCHED_TRACK_COLUMNS, title: tracks.title })
    .from(tracks)
    .where(
      and(
        between(
          tracks.duration,
          durationSec - FUZZY_DURATION_WINDOW_SEC,
          durationSec + FUZZY_DURATION_WINDOW_SEC
        ),
        playableTrackFilter()
      )
    );

  for (const c of candidates) {
    if (
      normalizeForFuzzy(c.title) === normTitle &&
      normalizeForFuzzy(c.artistName) === normArtist
    ) {
      // The row already carries everything a match needs. The Mongo version
      // re-read the document here "so callers can mutate and save" — no caller
      // ever did; `matchCatalog` hands the result straight to `asTrackMatch`.
      return { id: c.id, artistId: c.artistId, artistName: c.artistName };
    }
  }
  return null;
}

// ── The chain ───────────────────────────────────────────────────────────────

function asTrackMatch(
  track: MatchedTrack,
  tier: MatchTier,
  bitErrorRate?: number
): CatalogTrackMatch {
  return {
    kind: 'track',
    trackId: track.id,
    tier,
    artistId: track.artistId,
    artistName: track.artistName,
    ...(bitErrorRate !== undefined && { bitErrorRate }),
  };
}

/**
 * Run the dedup chain for one uploaded file.
 *
 * `ownerOxyUserId` scopes the locker half of tier 1 to the uploader. It is not a
 * convenience: matching against somebody else's locker would both leak that they
 * hold the file and hand this uploader an id they may not read.
 */
export async function matchCatalog(
  candidate: MatchCandidate,
  ownerOxyUserId: string,
): Promise<MatchResult> {
  // ── Tier 1: identical bytes ──
  const catalogByHash = await findCatalogTrackByHash(candidate.sha256);
  if (catalogByHash) return asTrackMatch(catalogByHash, 'sha256');

  const ownUpload = await findOwnUploadByHash(candidate.sha256, ownerOxyUserId);
  if (ownUpload) return ownUpload;

  // ── Tier 2: ISRC ──
  if (candidate.isrc) {
    const byIsrc = await findCatalogTrackByIsrc(candidate.isrc);
    if (byIsrc) return asTrackMatch(byIsrc, 'isrc');
  }

  // ── Tier 3: Chromaprint ──
  const acoustic = await findCatalogTrackByFingerprint(candidate);
  if (acoustic.match) {
    return asTrackMatch(acoustic.match.track, 'fingerprint', acoustic.match.bitErrorRate);
  }

  // ── Tier 4: fuzzy ──
  if (candidate.title && candidate.artistName) {
    const byFuzzy = await findCatalogTrackByFuzzy(
      candidate.title,
      candidate.artistName,
      candidate.durationSec,
    );
    if (byFuzzy) return asTrackMatch(byFuzzy, 'fuzzy');
  }

  // No match — but an acoustic neighbour, if one was found, travels with the
  // "no" so the caller can screen and attribute with it. This is the ONLY arm
  // that can carry it: when the fingerprint produces a real dedup hit the upload
  // is never stored, so neither screening nor artist resolution ever runs.
  return acoustic.neighbour
    ? { kind: 'none', nearestFingerprint: acoustic.neighbour }
    : { kind: 'none' };
}
