/**
 * Read everything an uploaded audio file knows about itself.
 *
 * Two sources, with a fixed precedence between them:
 *
 *  - **ffprobe is authoritative for technical facts** — duration, codec,
 *    bitrate, sample rate, channels. It demuxes the actual stream, so it cannot
 *    be lied to by a tag. Today's creator upload form asks a human to TYPE the
 *    duration into a text box validated only with `> 0`
 *    (`packages/studio/app/music/upload.tsx`); everything downstream that trusts
 *    `Track.duration` — the ±2 s fuzzy dedup window, the fingerprint candidate
 *    bucket, the player's scrubber — inherits whatever they typed.
 *  - **Tags are authoritative for descriptive facts** — title, artists, album,
 *    identifiers, credits, lyrics. ffprobe surfaces some of these too, but only
 *    the subset its own tag mapping covers.
 *
 * Nothing here is inferred, estimated or invented. BPM and key are copied when
 * the file carries them and left absent when it does not; no signal analysis
 * fills a gap. A field that is absent from the file is absent from the result.
 */

import crypto from 'crypto';
import fs from 'fs';
import { probeAudio } from '../ingest/probeAudio';
import { splitArtistCredit } from './artistNames';

/**
 * `music-metadata` v11 is ESM-only and this package compiles to CommonJS under
 * `module: Node16`, where a static import fails with TS1479. A dynamic `import()`
 * is the supported bridge — Node16 emits it verbatim instead of degrading it to
 * `require` — and the module is memoized so a burst of uploads pays the load
 * once. The type is taken with an explicit import-resolution mode so the
 * type-only reference does not itself trip TS1542.
 */
type MusicMetadataModule = typeof import('music-metadata', { with: { 'resolution-mode': 'import' } });

let musicMetadataModule: Promise<MusicMetadataModule> | undefined;

function loadMusicMetadata(): Promise<MusicMetadataModule> {
  musicMetadataModule ??= import('music-metadata');
  return musicMetadataModule;
}

// ── Result shapes ───────────────────────────────────────────────────────────

/**
 * A credit role, drawn from the tag vocabulary rather than invented.
 *
 * `artist` covers featured performers split out of the main artist string;
 * every other value corresponds to a specific frame or comment
 * (`TCOM`/`COMPOSER`, `TEXT`/`LYRICIST`, the `TIPL`/`IPLS` involved-people list,
 * …). Mirrors the role vocabulary the plan defines for `Track.credits[]`.
 */
export type CreditRole =
  | 'artist'
  | 'albumartist'
  | 'composer'
  | 'lyricist'
  | 'conductor'
  | 'remixer'
  | 'arranger'
  | 'engineer'
  | 'producer'
  | 'mixer'
  | 'djmixer';

export interface ExtractedCredit {
  name: string;
  role: CreditRole;
}

/** An embedded image, with the picture type the container declared for it. */
export interface ExtractedPicture {
  /** e.g. `Cover (front)`, `Cover (back)`, `Artist/performer`. */
  type?: string;
  mimeType: string;
  description?: string;
  data: Buffer;
}

export interface ExtractedReplayGain {
  trackDb?: number;
  albumDb?: number;
  trackPeak?: number;
}

export interface ExtractedSyncedLyric {
  text: string;
  timestampMs: number;
}

export interface ExtractedLyrics {
  text: string;
  language?: string;
  /** Present only for `SYLT`-style synchronised lyrics. */
  synced?: ExtractedSyncedLyric[];
}

export interface ExtractedMusicBrainzIds {
  recordingId?: string;
  trackId?: string;
  releaseId?: string;
  releaseGroupId?: string;
  artistId?: string;
  albumArtistId?: string;
}

/**
 * Technical truth about the stream — measured, never declared.
 *
 * ALL of it comes from `probeAudio` (ffprobe), the backend's single ffprobe
 * authority. This used to take sample rate, channels and container from
 * `music-metadata`'s format block because `ProbedAudio` did not carry them;
 * ingest has since added all three, so there is now one source rather than two
 * that could disagree.
 *
 * `container` is ffmpeg's DEMUXER FAMILY, not a file extension — an m4a reports
 * `mov,mp4,m4a,3gp,3g2,mj2` and an mp3 reports `mp3`. It is passed through
 * verbatim rather than narrowed, because picking one member of that list would
 * invent information ffprobe did not give. Anything needing a canonical
 * container string should derive it from `codec`, not parse this.
 */
export interface AudioTechnicals {
  /** Seconds, as decoded — never a human-entered number. */
  durationSec: number;
  /** ffprobe `codec_name`, e.g. `mp3`, `aac`, `flac`, `pcm_s16le`. */
  codec?: string;
  bitrateKbps?: number;
  sampleRate?: number;
  channels?: number;
  /** e.g. `MPEG`, `FLAC`, `WAVE`, `MPEG-4/M4A`. */
  container?: string;
}

/**
 * One native tag exactly as the container declared it.
 *
 * The provenance scorer works from these — not from the normalized view — because
 * the markers it looks for (`apID`, `CUESHEET`, `MUSICBRAINZ_*`) are precisely
 * the tags no normalizer maps, and a normalized view would drop them silently.
 */
export interface NativeTag {
  /** `ID3v2.4`, `iTunes`, `vorbis`, `APEv2`, … */
  tagType: string;
  id: string;
  /** Rendered form; binary payloads become a `[binary …]` descriptor. */
  value: string;
}

/**
 * The capped dump persisted alongside an upload.
 *
 * Entries are DROPPED to fit the cap rather than the serialized form being cut
 * mid-string, so a stored dump is always valid JSON and can be re-parsed years
 * later to answer a DMCA question without asking for the file again. Never
 * served to a client.
 */
export interface RawTagDump {
  json: string;
  truncated: boolean;
  /**
   * Size of the dump BEFORE anything was dropped, so a reviewer can see how much
   * of the file's tagging the stored copy represents. Matches the field
   * `UserUpload.rawTags` and `ContributionAttestation` persist.
   */
  originalByteLength: number;
}

export interface ExtractedMetadata {
  /** Lowercase hex SHA-256 of the file bytes — tier 1 of the dedup chain. */
  sha256: string;
  sizeBytes: number;
  technical: AudioTechnicals;

  title?: string;
  /** The main artist string as declared, before any `feat.` split. */
  artistName?: string;
  /** Every artist string the file declares, in declaration order. */
  artists: string[];
  albumArtistName?: string;
  albumName?: string;

  trackNumber?: number;
  totalTracks?: number;
  discNumber?: number;
  totalDiscs?: number;

  year?: number;
  releaseDate?: string;
  originalReleaseDate?: string;

  genres: string[];
  isrc?: string;
  /** `BARCODE` — the UPC/EAN of the release. */
  upc?: string;
  catalogNumber?: string;
  label?: string;
  /** `CD`, `Vinyl`, `Digital Media`, … */
  media?: string;
  releaseCountry?: string;

  bpm?: number;
  key?: string;
  language?: string;
  copyright?: string;
  publisher?: string;
  comment?: string;
  isExplicit?: boolean;
  compilation?: boolean;

  credits: ExtractedCredit[];
  lyrics?: ExtractedLyrics;
  replayGain?: ExtractedReplayGain;
  musicbrainz: ExtractedMusicBrainzIds;
  acoustidId?: string;
  asin?: string;
  encodedBy?: string;
  encoderSettings?: string;
  pictures: ExtractedPicture[];

  nativeTags: NativeTag[];
  rawTags: RawTagDump;
}

/** Cap for the persisted raw-tag dump, per the plan's storage budget. */
export const RAW_TAGS_MAX_BYTES = 32 * 1024;

// ── SHA-256 ─────────────────────────────────────────────────────────────────

/** Stream the file rather than buffering it — uploads run to 200 MB. */
export function hashFile(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      sizeBytes += buffer.length;
      hash.update(buffer);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), sizeBytes }));
  });
}

// ── Native tag rendering ────────────────────────────────────────────────────

function isBinaryLike(value: unknown): value is { data: Uint8Array; format?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    (value as { data: unknown }).data instanceof Uint8Array
  );
}

function renderTagValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Uint8Array) return `[binary ${value.length} bytes]`;
  if (isBinaryLike(value)) {
    return `[binary ${value.format ?? 'unknown'} ${value.data.length} bytes]`;
  }
  return JSON.stringify(value);
}

function collectNativeTags(native: Record<string, Array<{ id: string; value: unknown }>>): NativeTag[] {
  const tags: NativeTag[] = [];
  for (const [tagType, entries] of Object.entries(native)) {
    for (const entry of entries) {
      // Every tag is kept, including one whose value renders empty: the presence
      // of the tag is itself evidence, and dropping empties would hide it.
      tags.push({ tagType, id: entry.id, value: renderTagValue(entry.value) });
    }
  }
  return tags;
}

/**
 * Serialize the native tags, dropping whole entries from the end until the JSON
 * fits the cap. Largest-first would keep more entries, but tag order carries
 * meaning for an auditor (it is the order the tagger wrote them), so the dump
 * preserves it and truncates the tail.
 */
export function buildRawTagDump(tags: ReadonlyArray<NativeTag>): RawTagDump {
  const kept = [...tags];
  let json = JSON.stringify(kept);
  const originalByteLength = Buffer.byteLength(json, 'utf8');

  while (Buffer.byteLength(json, 'utf8') > RAW_TAGS_MAX_BYTES && kept.length > 0) {
    kept.pop();
    json = JSON.stringify(kept);
  }

  return { json, truncated: kept.length < tags.length, originalByteLength };
}

// ── Credits ─────────────────────────────────────────────────────────────────

/**
 * Roles readable straight off the normalized view, plus the raw involved-people
 * list that no normalizer covers.
 *
 * `TIPL`/`IPLS` has to be read from the native tags: `music-metadata` parses the
 * frame into a role→names map but its ID3 mapper only reaches the roles through
 * synthetic `TIPL:<role>` ids that the native dictionary never emits, so the
 * normalized view of an ID3-tagged file carries no producer, engineer or mixer
 * at all. Verified against `__fixtures__/indie-id3v2.mp3`, whose TIPL frame
 * names four people and whose `common` names none of them.
 */
type ParsedCommonTags = Awaited<ReturnType<MusicMetadataModule['parseFile']>>['common'];

const COMMON_CREDIT_ROLES: ReadonlyArray<
  readonly [CreditRole, (common: ParsedCommonTags) => ReadonlyArray<string> | undefined]
> = [
  ['composer', (common) => common.composer],
  ['lyricist', (common) => common.lyricist],
  ['lyricist', (common) => common.writer],
  ['conductor', (common) => common.conductor],
  ['remixer', (common) => common.remixer],
  ['arranger', (common) => common.arranger],
  ['engineer', (common) => common.engineer],
  ['producer', (common) => common.producer],
  ['mixer', (common) => common.mixer],
  ['djmixer', (common) => common.djmixer],
];

/** Involved-people-list role strings → our vocabulary. */
const INVOLVED_PEOPLE_ROLES: Readonly<Record<string, CreditRole>> = {
  producer: 'producer',
  engineer: 'engineer',
  mix: 'mixer',
  mixer: 'mixer',
  arranger: 'arranger',
  'dj-mix': 'djmixer',
  djmixer: 'djmixer',
  composer: 'composer',
  lyricist: 'lyricist',
  conductor: 'conductor',
  remixer: 'remixer',
};

function pushCredit(credits: ExtractedCredit[], name: string, role: CreditRole): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  if (credits.some((credit) => credit.name === trimmed && credit.role === role)) return;
  credits.push({ name: trimmed, role });
}

function creditsFromInvolvedPeople(tags: NativeTag[]): ExtractedCredit[] {
  const credits: ExtractedCredit[] = [];
  for (const tag of tags) {
    if (tag.id !== 'TIPL' && tag.id !== 'IPLS' && tag.id !== 'TMCL') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(tag.value);
    } catch {
      // A tagger that wrote the frame as one flat string carries no role→name
      // pairing to recover; the names are still in the raw dump for an auditor.
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    for (const [rawRole, names] of Object.entries(parsed as Record<string, unknown>)) {
      const role = INVOLVED_PEOPLE_ROLES[rawRole.toLowerCase()];
      if (!role) continue;
      const list = Array.isArray(names) ? names : [names];
      for (const name of list) {
        if (typeof name === 'string') pushCredit(credits, name, role);
      }
    }
  }
  return credits;
}

// ── Explicitness ────────────────────────────────────────────────────────────

/**
 * Apple's `rtng` advisory: 1 and 4 both mean explicit, 2 means a clean edit, 0
 * means the release carries no advisory at all. `ITUNESADVISORY` is the same
 * value written as text by taggers that cannot emit the atom.
 */
function readExplicit(tags: NativeTag[]): boolean | undefined {
  for (const tag of tags) {
    const id = tag.id.trim().toUpperCase();
    if (id !== 'RTNG' && id !== 'TXXX:ITUNESADVISORY' && id !== 'ITUNESADVISORY') continue;
    const advisory = Number(tag.value);
    if (!Number.isFinite(advisory)) continue;
    if (advisory === 1 || advisory === 4) return true;
    if (advisory === 2) return false;
  }
  return undefined;
}

// ── Entry point ─────────────────────────────────────────────────────────────

function firstString(values: ReadonlyArray<string> | undefined): string | undefined {
  const first = values?.find((value) => value.trim().length > 0);
  return first?.trim();
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Extract everything from one file: technical truth, descriptive tags, credits,
 * embedded art and the capped raw dump.
 *
 * Rejects a file ffprobe cannot measure; tolerates a file with no tags at all
 * (the untagged-WAV case), which extracts to technical facts plus empty
 * descriptive fields rather than an error.
 */
export async function extractMetadata(filePath: string): Promise<ExtractedMetadata> {
  const [{ parseFile }, probed, { sha256, sizeBytes }] = await Promise.all([
    loadMusicMetadata(),
    probeAudio(filePath),
    hashFile(filePath),
  ]);

  const parsed = await parseFile(filePath, { duration: false });
  const { common } = parsed;
  const nativeTags = collectNativeTags(parsed.native);

  const technical: AudioTechnicals = {
    durationSec: probed.durationSec,
    codec: probed.codec,
    bitrateKbps: probed.bitrateKbps,
    sampleRate: probed.sampleRate,
    channels: probed.channels,
    container: probed.container,
  };

  const credits: ExtractedCredit[] = [];

  // Featured performers split out of the main artist string become `artist`
  // credits; the primary name stays in `artistName` untouched.
  const artistCredit = splitArtistCredit(common.artist ?? '');
  for (const featured of artistCredit.featured) {
    pushCredit(credits, featured, 'artist');
  }
  if (common.albumartist) {
    pushCredit(credits, common.albumartist, 'albumartist');
  }
  for (const [role, read] of COMMON_CREDIT_ROLES) {
    for (const name of read(common) ?? []) {
      pushCredit(credits, name, role);
    }
  }
  for (const credit of creditsFromInvolvedPeople(nativeTags)) {
    pushCredit(credits, credit.name, credit.role);
  }

  // `ILyricsTag.syncText` is declared non-optional but is genuinely absent on a
  // plain `USLT` frame — verified against `__fixtures__/indie-id3v2.mp3`, whose
  // unsynchronised lyrics parse to an object with no `syncText` at all. The
  // coalesce is not defensive noise; without it every ID3 file with lyrics
  // throws.
  const lyricsTag = common.lyrics?.find((entry) => entry.text || entry.syncText?.length);
  const syncedLines = lyricsTag?.syncText ?? [];
  const lyrics: ExtractedLyrics | undefined = lyricsTag
    ? {
        text: lyricsTag.text ?? syncedLines.map((line) => line.text).join('\n'),
        language: nonEmpty(lyricsTag.language),
        synced: syncedLines.length
          ? syncedLines.map((line) => ({ text: line.text, timestampMs: line.timestamp ?? 0 }))
          : undefined,
      }
    : undefined;

  const replayGain: ExtractedReplayGain | undefined =
    common.replaygain_track_gain || common.replaygain_album_gain || common.replaygain_track_peak
      ? {
          trackDb: common.replaygain_track_gain?.dB,
          albumDb: common.replaygain_album_gain?.dB,
          trackPeak: common.replaygain_track_peak?.ratio,
        }
      : undefined;

  const pictures: ExtractedPicture[] = (common.picture ?? []).map((picture) => ({
    type: nonEmpty(picture.type),
    mimeType: picture.format,
    description: nonEmpty(picture.description),
    data: Buffer.from(picture.data),
  }));

  return {
    sha256,
    sizeBytes,
    technical,

    title: nonEmpty(common.title),
    artistName: nonEmpty(common.artist),
    artists: (common.artists ?? []).map((value) => value.trim()).filter(Boolean),
    albumArtistName: nonEmpty(common.albumartist),
    albumName: nonEmpty(common.album),

    trackNumber: common.track.no ?? undefined,
    totalTracks: common.track.of ?? undefined,
    discNumber: common.disk.no ?? undefined,
    totalDiscs: common.disk.of ?? undefined,

    year: common.year,
    releaseDate: nonEmpty(common.date),
    originalReleaseDate: nonEmpty(common.originaldate),

    genres: (common.genre ?? []).map((value) => value.trim()).filter(Boolean),
    isrc: firstString(common.isrc),
    upc: nonEmpty(common.barcode),
    catalogNumber: firstString(common.catalognumber),
    label: firstString(common.label),
    media: nonEmpty(common.media),
    releaseCountry: nonEmpty(common.releasecountry),

    bpm: common.bpm,
    key: nonEmpty(common.key),
    language: nonEmpty(common.language),
    copyright: nonEmpty(common.copyright),
    publisher: firstString(common.label),
    comment: nonEmpty(common.comment?.[0]?.text),
    isExplicit: readExplicit(nativeTags),
    compilation: common.compilation,

    credits,
    lyrics,
    replayGain,
    musicbrainz: {
      recordingId: nonEmpty(common.musicbrainz_recordingid),
      trackId: nonEmpty(common.musicbrainz_trackid),
      releaseId: nonEmpty(common.musicbrainz_albumid),
      releaseGroupId: nonEmpty(common.musicbrainz_releasegroupid),
      artistId: firstString(common.musicbrainz_artistid),
      albumArtistId: firstString(common.musicbrainz_albumartistid),
    },
    acoustidId: nonEmpty(common.acoustid_id),
    asin: nonEmpty(common.asin),
    encodedBy: nonEmpty(common.encodedby),
    encoderSettings: nonEmpty(common.encodersettings),
    pictures,

    nativeTags,
    rawTags: buildRawTagDump(nativeTags),
  };
}
