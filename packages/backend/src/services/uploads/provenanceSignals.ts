/**
 * Tag forensics: what does this file's own metadata say about where it came from?
 *
 * This is the cheap screen that runs before anything is published. It does not
 * listen to the audio — `fingerprint.ts` and `matchCatalog.ts` do that — it reads
 * what taggers, rippers and stores left behind, which is often decisive and
 * always free.
 *
 * THE CENTRAL SEMANTIC, and the one easiest to get wrong: **a bare ISRC is not
 * evidence of anything.** Indie distributors assign ISRCs as a matter of course,
 * so every legitimate independent artist uploading their own record arrives
 * carrying one. Treating the identifier as a marker would block exactly the
 * users this feature exists for. What is evidence is the ISRC *resolving* — in
 * `IsrcRegistry`, to a MusicBrainz recording that has releases behind it. The
 * identifier is not the signal; the resolution is.
 *
 * Weights and thresholds are stated as constants below with the arithmetic
 * worked through, because a scoring function whose thresholds are unexplained is
 * a scoring function nobody can safely change.
 */

import type {
  ProvenanceMarker,
  ProvenanceMarkerWeight,
  ProvenanceReport,
  ProvenanceVerdict,
} from '@syra/shared-types';
import { normalizeNameKey } from '@syra/shared-types';
import type { ExtractedMetadata, NativeTag } from './extractMetadata';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { isrcRegistry } from '../../db/schema/catalog';
import { splitArtistCredit } from './artistNames';

// ── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * The marker codes this scorer can emit.
 *
 * `ProvenanceMarker.code` is a plain `string` in the shared contract — it has to
 * be, since it crosses the wire and an appeal quotes it years later — but every
 * code produced HERE comes from this union, so a typo in an emitter is a compile
 * error rather than a marker no test ever asserts on.
 */
export type ProvenanceMarkerCode =
  | 'itunes.purchase-atoms'
  | 'store.asin'
  | 'store.xid-vendor'
  | 'isrc.resolves-to-release'
  | 'isrc.resolves-to-recording'
  | 'isrc.metadata-mismatch'
  | 'musicbrainz.tagged'
  | 'cdrip.cuesheet'
  | 'cdrip.album-replaygain'
  | 'cdrip.encoder'
  | 'fingerprint.other-artist'
  | 'fingerprint.copyright-removed'
  | 'acoustid.commercial-release'
  | 'acoustid.known-recording'
  | 'tags.stripped-commercial-encoding';

/**
 * A marker as this module emits it: the shared shape, with the code narrowed to
 * the known vocabulary and `detail` mandatory. `detail` is optional in the
 * contract for callers that receive one; a marker this module PRODUCES always
 * carries its evidence, because a block that cannot be explained is a block that
 * cannot be appealed.
 */
export interface ScreeningMarker extends ProvenanceMarker {
  code: ProvenanceMarkerCode;
  detail: string;
}

/** A {@link ProvenanceReport} whose markers came from this module. */
export interface ScreeningReport extends ProvenanceReport {
  markers: ScreeningMarker[];
}

// ── Scoring ─────────────────────────────────────────────────────────────────

const WEIGHT_POINTS: Readonly<Record<ProvenanceMarkerWeight, number>> = {
  blocking: 100,
  high: 50,
  medium: 20,
  low: 5,
};

/**
 * At or above this score the file is declared a commercial release.
 *
 * 80 is chosen so that, given the point table above:
 *  - any single `blocking` marker (100) decides on its own;
 *  - two `high` markers (100) decide — e.g. a resolving ISRC plus a fingerprint
 *    hit on our own catalog under a different artist;
 *  - one `high` plus two `medium` (90) decides;
 *  - four `medium` markers (80) decide — the full CD-rip shape: MusicBrainz
 *    tags, a cuesheet, album ReplayGain and a ripper's encoder string;
 *  - three `medium` markers (60) do NOT. Three is where an enthusiast tagging
 *    their own release with Picard starts to look like a rip, and getting that
 *    wrong blocks a legitimate artist. It lands in `suspect`, which asks for an
 *    attestation rather than refusing.
 */
export const COMMERCIAL_SCORE_THRESHOLD = 80;

/**
 * At or above this score the file is `suspect`. Equal to the `low` weight, so
 * ANY marker at all is enough to stop a file being called clean — the verdict
 * only says "clean" when the forensics found literally nothing.
 */
export const SUSPECT_SCORE_THRESHOLD = WEIGHT_POINTS.low;

/**
 * A `blocking` marker decides on its own, independent of the score.
 *
 * The arithmetic happens to agree today (100 ≥ 80), but the two must not be
 * coupled: `blocking` means the file names its buyer or its store, and no
 * rebalancing of the point table should ever be able to let that through. The
 * check is written separately so a future tuning pass cannot quietly undo it.
 */
function verdictFor(markers: ReadonlyArray<ProvenanceMarker>, score: number): ProvenanceVerdict {
  if (markers.some((marker) => marker.weight === 'blocking')) return 'commercial';
  if (score >= COMMERCIAL_SCORE_THRESHOLD) return 'commercial';
  if (score >= SUSPECT_SCORE_THRESHOLD) return 'suspect';
  return 'clean';
}

// ── Marker detection ────────────────────────────────────────────────────────

/**
 * The atoms the iTunes Store stamps into a purchased file. `apID` and `ownr`
 * carry the buyer's Apple ID and account name; `purd` the purchase date; `cnID`,
 * `atID` and `sfID` the store's content, album and storefront ids. None of them
 * has any reason to exist in a file an artist exported from their own session.
 */
const ITUNES_PURCHASE_ATOMS = ['apID', 'cnID', 'atID', 'sfID', 'purd', 'ownr', 'xid'] as const;

/** Ripper signatures, matched against encoder strings. */
const RIPPER_ENCODERS = /exact audio copy|\bEAC\b|dBpoweramp|\bXLD\b|whipper|rubyripper|cdparanoia|\bCDex\b|Morituri/i;

function tagId(tag: NativeTag): string {
  return tag.id.trim();
}

function findTags(tags: ReadonlyArray<NativeTag>, ids: ReadonlyArray<string>): NativeTag[] {
  const wanted = new Set(ids.map((id) => id.toLowerCase()));
  return tags.filter((tag) => wanted.has(tagId(tag).toLowerCase()));
}

function detectItunesPurchase(metadata: ExtractedMetadata): ScreeningMarker | undefined {
  const found = findTags(metadata.nativeTags, ITUNES_PURCHASE_ATOMS);
  if (found.length === 0) return undefined;
  const named = found.map((tag) => `${tagId(tag)}=${tag.value}`).join(', ');
  return {
    code: 'itunes.purchase-atoms',
    weight: 'blocking',
    detail: `iTunes Store purchase atoms present: ${named}`,
  };
}

function detectAsin(metadata: ExtractedMetadata): ScreeningMarker | undefined {
  if (!metadata.asin) return undefined;
  return {
    code: 'store.asin',
    weight: 'blocking',
    detail: `Amazon ASIN ${metadata.asin} — the file carries a retail product identifier`,
  };
}

/**
 * An `xid` names the vendor that issued the identifier, in `vendor:scheme:id`
 * form — `Longwave Recordings:isrc:GBAHT1600042`. The vendor half is a label.
 */
function detectXidVendor(metadata: ExtractedMetadata): ScreeningMarker | undefined {
  const xid = findTags(metadata.nativeTags, ['xid'])[0];
  const vendor = xid?.value.split(':')[0]?.trim();
  if (!vendor) return undefined;
  return {
    code: 'store.xid-vendor',
    weight: 'blocking',
    detail: `xid issued by "${vendor}" (${xid.value})`,
  };
}

function detectMusicBrainzTagging(metadata: ExtractedMetadata): ScreeningMarker | undefined {
  const evidence: string[] = [];
  const { musicbrainz } = metadata;
  if (musicbrainz.recordingId) evidence.push(`recording ${musicbrainz.recordingId}`);
  if (musicbrainz.releaseId) evidence.push(`release ${musicbrainz.releaseId}`);
  if (musicbrainz.releaseGroupId) evidence.push(`release group ${musicbrainz.releaseGroupId}`);
  if (musicbrainz.artistId) evidence.push(`artist ${musicbrainz.artistId}`);
  if (metadata.acoustidId) evidence.push(`AcoustID ${metadata.acoustidId}`);
  if (evidence.length === 0) return undefined;
  return {
    code: 'musicbrainz.tagged',
    weight: 'medium',
    detail: `Tagged against MusicBrainz — ${evidence.join(', ')}`,
  };
}

function detectCuesheet(metadata: ExtractedMetadata): ScreeningMarker | undefined {
  const cuesheet = findTags(metadata.nativeTags, ['CUESHEET', 'TXXX:CUESHEET'])[0];
  if (!cuesheet) return undefined;
  const firstLine = cuesheet.value.split('\n', 1)[0];
  return {
    code: 'cdrip.cuesheet',
    weight: 'medium',
    detail: `CUESHEET present (${cuesheet.value.length} bytes, starts "${firstLine}")`,
  };
}

/**
 * Album ReplayGain can only be computed over a whole album, so its presence says
 * the file arrived as part of a complete release rather than on its own.
 */
function detectAlbumReplayGain(metadata: ExtractedMetadata): ScreeningMarker | undefined {
  const albumDb = metadata.replayGain?.albumDb;
  if (albumDb === undefined) return undefined;
  return {
    code: 'cdrip.album-replaygain',
    weight: 'medium',
    detail: `Album ReplayGain ${albumDb} dB — computed across a full release`,
  };
}

function detectRipperEncoder(metadata: ExtractedMetadata): ScreeningMarker | undefined {
  const candidates = [metadata.encodedBy, metadata.encoderSettings].filter(
    (value): value is string => typeof value === 'string',
  );
  const hit = candidates.find((value) => RIPPER_ENCODERS.test(value));
  if (!hit) return undefined;
  return {
    code: 'cdrip.encoder',
    weight: 'medium',
    detail: `Encoded by a CD ripper: "${hit}"`,
  };
}

/**
 * Commercial encoding quality, for the "somebody stripped every tag" marker.
 *
 * Stripping tags is only suspicious when what is left is a full-quality copy of
 * something. A 22 kHz mono voice memo with no tags is a voice memo; a 44.1 kHz
 * stereo lossless file with no tags is a rip somebody scrubbed. Lossy is judged
 * on bitrate because that is the only quality dimension a transcode preserves.
 */
function hasCommercialEncodingQuality(metadata: ExtractedMetadata): boolean {
  const { sampleRate, channels, bitrateKbps, codec } = metadata.technical;
  if (sampleRate === undefined || sampleRate < 44100) return false;
  if (channels === undefined || channels < 2) return false;
  const lossless = codec !== undefined && /^(flac|alac|pcm_|wavpack|ape)/i.test(codec);
  if (lossless) return true;
  return bitrateKbps !== undefined && bitrateKbps >= 192;
}

/**
 * The identifiers a released record carries, whoever released it.
 *
 * Every one of these is written by the pipeline that PUBLISHES a recording — a
 * distributor's ISRC, a label's barcode and catalogue number, the copyright
 * line, the MusicBrainz ids a tagger added. An independent artist's own export
 * arrives with several of them; a file somebody laundered arrives with none,
 * because removing them is the entire point of laundering it.
 */
function hasReleaseIdentity(metadata: ExtractedMetadata): boolean {
  const { musicbrainz } = metadata;
  return Boolean(
    metadata.isrc ||
      metadata.upc ||
      metadata.catalogNumber ||
      metadata.label ||
      metadata.copyright ||
      metadata.publisher ||
      metadata.asin ||
      metadata.acoustidId ||
      musicbrainz.recordingId ||
      musicbrainz.trackId ||
      musicbrainz.releaseId ||
      musicbrainz.releaseGroupId ||
      musicbrainz.artistId ||
      musicbrainz.albumArtistId,
  );
}

/**
 * Album names that name no album.
 *
 * `Unknown Album` is what a ripper writes when it had no release to write, and
 * it is the reason this marker cannot simply test `albumName === undefined`: the
 * file that prompted this signal carries the string, so a presence check would
 * read it as a named release and let the file through.
 *
 * Deliberately NOT `isDenylistedArtistName`. That list guards a different thing —
 * the artist rows a catalogue can be permanently poisoned by — and its entries
 * (`va`, `none`, `null`) are keys chosen for that job. Reusing it here would tie
 * two unrelated policies together, so an entry added for one silently changes
 * the other. Keys, not spellings: compared through `normalizeNameKey`, the same
 * normalisation every other name comparison in this pipeline uses.
 */
const PLACEHOLDER_ALBUM_NAME_KEYS: ReadonlySet<string> = new Set([
  '',
  'unknown',
  'unknown album',
  'album unknown',
  'untitled',
  'untitled album',
  'no album',
  'album desconocido',
  'sin album',
  'none',
  'null',
  'undefined',
]);

function namesARelease(albumName: string | undefined): boolean {
  if (!albumName) return false;
  return !PLACEHOLDER_ALBUM_NAME_KEYS.has(normalizeNameKey(albumName));
}

/**
 * Somebody removed this file's provenance.
 *
 * ## Why this weighs `medium` rather than `low`
 *
 * The scorer only weighs markers that are PRESENT, which means an absence costs
 * nothing — and every other marker here is a presence. A file whose tags were
 * deliberately erased therefore scores CLEANER than an honest one: the indie
 * artist who exported with a label, a copyright line and a distributor's ISRC
 * accumulates points for saying so, while the rip that had all three stripped
 * accumulates none. That is the scoring function rewarding the laundering, and
 * the weight is the correction.
 *
 * ## Why it can never decide on its own
 *
 * Absence is weak evidence. A genuine home recording has no label, no ISRC and
 * no album either, and it is exactly the upload this platform exists for. At
 * `medium` the marker lands the file in `suspect`, which asks for an attestation;
 * reaching `commercial` needs 80 points, so this marker requires three more
 * independent findings before it contributes to a refusal. It cannot block, and
 * it must not: the point is that it CONTRIBUTES.
 *
 * ## What it actually tests
 *
 * All three of: release-grade audio, no release identity of any kind, and no
 * album name that names a release. The three together are the shape — somebody
 * had a finished commercial master and removed everything that said where it
 * came from. Any one of them alone is ordinary.
 *
 * Embedded artwork is reported in the detail rather than required. A file with a
 * cover but no album name is the sharpest form of the pattern (somebody kept the
 * picture and dropped the provenance), but the fully-stripped file — no tags at
 * all, which is what this marker originally tested — carries no artwork either
 * and is the plainest case there is.
 */
function detectStrippedTags(metadata: ExtractedMetadata): ScreeningMarker | undefined {
  if (!hasCommercialEncodingQuality(metadata)) return undefined;
  if (hasReleaseIdentity(metadata)) return undefined;
  if (namesARelease(metadata.albumName)) return undefined;

  const { codec, sampleRate, channels, bitrateKbps } = metadata.technical;
  const quality = [
    codec,
    sampleRate === undefined ? undefined : `${sampleRate} Hz`,
    channels === undefined ? undefined : `${channels} ch`,
    bitrateKbps === undefined ? undefined : `${bitrateKbps} kbps`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(', ');

  const observed = [
    metadata.nativeTags.length === 0
      ? 'no tags of any kind'
      : `${metadata.nativeTags.length} tag(s), none identifying a release`,
    metadata.albumName ? `album named "${metadata.albumName}"` : 'no album name',
    ...(metadata.pictures.length > 0 ? ['embedded artwork'] : []),
  ].join('; ');

  return {
    code: 'tags.stripped-commercial-encoding',
    weight: 'medium',
    detail: `Release-grade encoding (${quality}) with no release identity — ${observed}`,
  };
}

// ── External facts the scorer is given rather than fetches ──────────────────

/** The `IsrcRegistry` row an ISRC resolved to, narrowed to what scoring reads. */
export interface IsrcRegistryMatch {
  isrc: string;
  recordingMbid: string;
  title: string;
  artistCredit: string;
  lengthMs?: number;
  releaseCount: number;
}

/** A catalog recording this audio acoustically is, which was not deduped against. */
export interface ForeignFingerprintMatch {
  trackId: string;
  artistName: string;
  /** Bit error rate of the match, for the audit trail. */
  bitErrorRate: number;
  /**
   * The matched recording was removed from the catalog for copyright.
   *
   * The strongest signal in this file. Everything else infers commercial origin
   * from tags a determined uploader can strip; this is Syra having already
   * judged this exact audio infringing and taken it down. Re-uploading it is not
   * a case for review.
   */
  copyrightRemoved?: boolean;
}

/**
 * The recording AcoustID says this audio IS.
 *
 * Distinct from {@link ForeignFingerprintMatch}, which is a match against Syra's
 * own catalogue. This one reaches the world's index, so it answers for a file
 * whose recording Syra has never hosted — which is most of them.
 */
export interface AcousticIdentityMatch {
  recordingMbid: string;
  /** AcoustID's bit-agreement score for the match, for the audit trail. */
  score: number;
  title?: string;
  artistName?: string;
  /** How many MusicBrainz release entities carry this recording. */
  releaseCount: number;
}

export interface ProvenanceContext {
  isrcRegistryMatch?: IsrcRegistryMatch;
  foreignFingerprintMatch?: ForeignFingerprintMatch;
  acousticIdentityMatch?: AcousticIdentityMatch;
}

/**
 * How far the file's own duration may differ from the registry's before it is
 * recorded as a discrepancy. Two seconds is the same tolerance the fuzzy dedup
 * tier uses, so "same recording" means the same thing in both places.
 */
const ISRC_DURATION_TOLERANCE_SEC = 2;

function detectIsrcResolution(
  metadata: ExtractedMetadata,
  match: IsrcRegistryMatch,
): ScreeningMarker[] {
  const markers: ScreeningMarker[] = [];

  if (match.releaseCount > 0) {
    markers.push({
      code: 'isrc.resolves-to-release',
      weight: 'blocking',
      detail:
        `ISRC ${match.isrc} resolves to MusicBrainz recording ${match.recordingMbid} ` +
        `("${match.title}" by ${match.artistCredit}) carried on ${match.releaseCount} release(s)`,
    });
  } else {
    markers.push({
      code: 'isrc.resolves-to-recording',
      weight: 'high',
      detail:
        `ISRC ${match.isrc} resolves to MusicBrainz recording ${match.recordingMbid} ` +
        `("${match.title}" by ${match.artistCredit}), no releases recorded`,
    });
  }

  // Compared through `normalizeNameKey`, and on the PRIMARY artist rather than
  // the raw credit string. A file tagged `Nadia Ortiz feat. Kofi Mensah` against
  // a registry credit of `Nadia Ortiz` is the same artist written two ways, and
  // reporting that as a discrepancy would fire this marker on most collaborations
  // — noise that makes the real signal, a genuinely different artist, worthless.
  // The detail still quotes the raw strings, because that is what a reviewer
  // needs to see.
  const differences: string[] = [];
  if (metadata.title && normalizeNameKey(metadata.title) !== normalizeNameKey(match.title)) {
    differences.push(`title "${metadata.title}" vs "${match.title}"`);
  }
  if (metadata.artistName) {
    const fileArtist = normalizeNameKey(splitArtistCredit(metadata.artistName).primary);
    const registryArtist = normalizeNameKey(splitArtistCredit(match.artistCredit).primary);
    if (fileArtist !== registryArtist) {
      differences.push(`artist "${metadata.artistName}" vs "${match.artistCredit}"`);
    }
  }
  if (match.lengthMs !== undefined) {
    const registrySec = match.lengthMs / 1000;
    if (Math.abs(metadata.technical.durationSec - registrySec) > ISRC_DURATION_TOLERANCE_SEC) {
      differences.push(
        `duration ${metadata.technical.durationSec.toFixed(1)}s vs ${registrySec.toFixed(1)}s`,
      );
    }
  }
  if (differences.length > 0) {
    markers.push({
      code: 'isrc.metadata-mismatch',
      weight: 'medium',
      detail: `File disagrees with the known release on ${differences.join('; ')}`,
    });
  }

  return markers;
}

/**
 * The audio was identified, by the audio.
 *
 * This is the marker no tagger can defeat. Every other commercial signal in this
 * file reads something written INTO the file — a purchase atom, a store id, an
 * ISRC frame — and all of them come off with a tag editor. The fingerprint does
 * not, so a file scrubbed clean of every identifier still resolves to the
 * recording it was made from.
 *
 * The split mirrors {@link detectIsrcResolution}, and for the same reason:
 *
 *  - **carried on a release → `blocking`.** A recording that MusicBrainz records
 *    as published is a recording somebody published. Whoever holds those rights,
 *    it is not a stranger uploading it to a listener's locker, and no amount of
 *    clean-looking metadata changes that. The public path refuses it; the private
 *    locker is untouched, which is what the locker is for.
 *  - **known but on no release → `high`.** The recording exists in MusicBrainz
 *    and somebody submitted its fingerprint, but nothing records it as released.
 *    That is genuinely ambiguous — an artist who catalogued their own unreleased
 *    work looks exactly like this — so it weighs heavily without deciding.
 *
 * The false positive this accepts, stated plainly: an artist who registered
 * their own released recording in MusicBrainz and AcoustID, then uploads their
 * own file here, is refused the public path. That is already true of the ISRC
 * marker above and it is the same answer — a creator publishes their own music
 * through the studio, where they own the artist profile, not through the
 * listener-contribution endpoint.
 */
function detectAcousticIdentity(match: AcousticIdentityMatch): ScreeningMarker {
  const named = [match.title && `"${match.title}"`, match.artistName && `by ${match.artistName}`]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  const describes = named ? ` (${named})` : '';
  const scored = `AcoustID score ${match.score.toFixed(3)}`;

  if (match.releaseCount > 0) {
    return {
      code: 'acoustid.commercial-release',
      weight: 'blocking',
      detail:
        `The audio itself identifies as MusicBrainz recording ${match.recordingMbid}${describes}, ` +
        `carried on ${match.releaseCount} release entit${match.releaseCount === 1 ? 'y' : 'ies'} ` +
        `— a commercially released recording (${scored})`,
    };
  }

  return {
    code: 'acoustid.known-recording',
    weight: 'high',
    detail:
      `The audio itself identifies as MusicBrainz recording ${match.recordingMbid}${describes}, ` +
      `with no release recorded (${scored})`,
  };
}

function detectForeignFingerprint(match: ForeignFingerprintMatch): ScreeningMarker {
  if (match.copyrightRemoved) {
    return {
      code: 'fingerprint.copyright-removed',
      weight: 'blocking',
      detail:
        `Acoustically matches track ${match.trackId} ("${match.artistName}"), which Syra REMOVED ` +
        `for copyright (bit error rate ${match.bitErrorRate.toFixed(4)})`,
    };
  }
  return {
    code: 'fingerprint.other-artist',
    weight: 'high',
    detail:
      `Acoustically matches catalog track ${match.trackId}, credited to ${match.artistName} ` +
      `(bit error rate ${match.bitErrorRate.toFixed(4)})`,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Score a file from its extracted metadata plus any external facts already
 * established. Pure: no I/O, so it is testable against a fixture without a
 * database and reusable by any caller that already did the lookups.
 */
export function scoreProvenance(
  metadata: ExtractedMetadata,
  context: ProvenanceContext = {},
): ScreeningReport {
  const markers: ScreeningMarker[] = [];

  const push = (marker: ScreeningMarker | undefined): void => {
    if (marker) markers.push(marker);
  };

  push(detectItunesPurchase(metadata));
  push(detectAsin(metadata));
  push(detectXidVendor(metadata));
  if (context.isrcRegistryMatch) {
    markers.push(...detectIsrcResolution(metadata, context.isrcRegistryMatch));
  }
  if (context.foreignFingerprintMatch) {
    markers.push(detectForeignFingerprint(context.foreignFingerprintMatch));
  }
  if (context.acousticIdentityMatch) {
    markers.push(detectAcousticIdentity(context.acousticIdentityMatch));
  }
  push(detectMusicBrainzTagging(metadata));
  push(detectCuesheet(metadata));
  push(detectAlbumReplayGain(metadata));
  push(detectRipperEncoder(metadata));
  push(detectStrippedTags(metadata));

  const score = markers.reduce((total, marker) => total + WEIGHT_POINTS[marker.weight], 0);
  return { markers, score, verdict: verdictFor(markers, score) };
}

export interface ProvenanceSignalsResult {
  report: ScreeningReport;
  /**
   * The registry row the file's ISRC resolved to, if any. Returned so a caller
   * can fill GAPS in the file's own metadata from it — never overwrite them; a
   * disagreement is recorded as a marker, not silently resolved in either
   * direction.
   */
  isrcRegistryMatch?: IsrcRegistryMatch;
}

/**
 * Resolve the file's ISRC against `IsrcRegistry` and score.
 *
 * The fingerprint side is passed in rather than fetched: matching against the
 * catalog is `matchCatalog`'s job and it has already been done by the time an
 * upload is screened, so re-running it here would double the cost of the most
 * expensive step in the pipeline.
 */
export async function collectProvenanceSignals(
  metadata: ExtractedMetadata,
  context: Omit<ProvenanceContext, 'isrcRegistryMatch'> = {},
): Promise<ProvenanceSignalsResult> {
  let isrcRegistryMatch: IsrcRegistryMatch | undefined;

  if (metadata.isrc) {
    const [row] = await getDb()
      .select({
        isrc: isrcRegistry.isrc,
        recordingMbid: isrcRegistry.recordingMbid,
        title: isrcRegistry.title,
        artistCredit: isrcRegistry.artistCredit,
        lengthMs: isrcRegistry.lengthMs,
        releaseCount: isrcRegistry.releaseCount,
      })
      .from(isrcRegistry)
      .where(eq(isrcRegistry.isrc, metadata.isrc.toUpperCase()))
      .limit(1);
    if (row) {
      isrcRegistryMatch = {
        isrc: row.isrc,
        recordingMbid: row.recordingMbid,
        title: row.title,
        artistCredit: row.artistCredit,
        // `lengthMs` is nullable here; the DTO field is optional.
        lengthMs: row.lengthMs ?? undefined,
        releaseCount: row.releaseCount,
      };
    }
  }

  return {
    report: scoreProvenance(metadata, { ...context, isrcRegistryMatch }),
    isrcRegistryMatch,
  };
}
