/**
 * Who made this recording?
 *
 * The normal case is that the file does not say — most audio files carry a plain
 * text name and nothing else, and plenty carry not even that. So this is a chain
 * of signals ordered by how much each one can be trusted, and what a caller may
 * DO with the answer depends on that confidence:
 *
 *  - **high** — a strong identifier resolved. `linkedArtistId` is populated and
 *    may be written to `Track.artistId`, and a contributed artist profile may be
 *    created from the name.
 *  - **medium** — a plain name, normalised. Displayed as text. If an existing
 *    artist happens to carry the same `nameKey` it is reported as
 *    `matchedArtistId` so the contribution policy can see whose page this would
 *    land on, but it is NEVER written as the track's artist: two different people
 *    genuinely share a name, and a wrong link is an accusation.
 *  - **low** — guessed from a filename or folder layout. Feeds the review screen
 *    and waits for a human. Never links, never creates.
 *  - **none** — nothing usable. Valid for the private locker ("Unknown artist");
 *    the public path must refuse, because without attribution there is no
 *    claimable profile and nobody to send a takedown to.
 *
 * The single hard rule underneath all of it: a denylisted placeholder name
 * (`Unknown Artist`, `Various Artists`, …) resolves to nothing at any confidence.
 * That is the one path by which a catalog fills with irreversible garbage, since
 * every untagged upload afterwards attaches itself to the same fake row and the
 * recordings underneath can never be told apart again.
 */

import { isDenylistedArtistName, normalizeNameKey } from '@syra/shared-types';
import type { IArtist } from '../../models/CatalogEntity';
import { ArtistModel } from '../../models/CatalogEntity';
import { IsrcRegistryModel } from '../../models/IsrcRegistry';
import { TrackModel } from '../../models/Track';
import { enqueueArtistEnrichment } from '../ingest/ingestQueue';
import { splitArtistCredit } from './artistNames';

// ── Vocabulary ──────────────────────────────────────────────────────────────

export type ArtistConfidence = 'high' | 'medium' | 'low' | 'none';

/** Which signal produced the answer — recorded so a decision can be explained. */
export type ArtistSignal =
  | 'isrc-catalog-track'
  | 'isrc-registry'
  | 'fingerprint-catalog-track'
  | 'musicbrainz-artist-id'
  | 'artist-tag'
  | 'albumartist-tag'
  | 'filename'
  | 'folder-structure'
  | 'none';

export interface ArtistResolution {
  confidence: ArtistConfidence;
  signal: ArtistSignal;
  /** The artist's name as it should be displayed. Absent only when nothing resolved. */
  name?: string;
  /** {@link name} through `normalizeNameKey`. */
  nameKey?: string;
  /**
   * An existing catalog artist the signal points at, at ANY confidence.
   * Informational: the contribution policy reads it to see whether the artist is
   * already present and claimed. Not a licence to write it anywhere.
   */
  matchedArtistId?: string;
  /**
   * The artist id that may be written to `Track.artistId`.
   *
   * Populated ONLY at high confidence — the field is simply absent otherwise, so
   * a caller cannot write a medium-confidence guess by forgetting to check
   * `confidence`. Deliberately not the same field as {@link matchedArtistId}.
   */
  linkedArtistId?: string;
  /** Featured performers split out of the credit, kept as text. */
  featured: string[];
}

/** Everything the chain can read. Every field is optional — that is the point. */
export interface ArtistResolutionInput {
  isrc?: string;
  musicbrainzArtistId?: string;
  /** `TPE1` / `ARTIST` / `©ART`, raw and unsplit. */
  artistName?: string;
  /** `TPE2` / `ALBUMARTIST` / `aART`. */
  albumArtistName?: string;
  /**
   * A catalog track this audio already matched acoustically.
   *
   * Passed in rather than recomputed: the fingerprint search is the most
   * expensive step in the pipeline and `matchCatalog` has already run it.
   */
  fingerprintMatch?: { artistId: string; artistName: string };
  /** The uploaded file's own name, e.g. `01 - Nadia Ortiz - Midnight Ferry.mp3`. */
  fileName?: string;
  /** Relative path within a multi-file upload, e.g. `Nadia Ortiz/Harbour Lights/01 Midnight Ferry.mp3`. */
  relativePath?: string;
}

const NOTHING: ArtistResolution = { confidence: 'none', signal: 'none', featured: [] };

// ── Filename and folder guesses (tier 7) ────────────────────────────────────

/**
 * `01 - Artist - Title.mp3`, `01. Artist - Title.flac`, `Artist - Title.m4a`.
 *
 * Requires at least two ` - ` separated parts after any leading track number,
 * because `Title.mp3` on its own names no artist and guessing one from a title
 * is how a catalog gets a track by an artist called "Live At Wembley".
 */
function artistFromFileName(fileName: string): string | undefined {
  const withoutExtension = fileName.replace(/\.[a-z0-9]{2,5}$/i, '');
  const withoutTrackNumber = withoutExtension.replace(/^\s*\d{1,3}\s*[-._)]\s*/, '');
  const parts = withoutTrackNumber.split(/\s+-\s+/);
  if (parts.length < 2) return undefined;
  const candidate = parts[0].trim();
  return candidate.length > 0 ? candidate : undefined;
}

/** `Artist/Album/01 Title.mp3` — the first of at least three path segments. */
function artistFromRelativePath(relativePath: string): string | undefined {
  const segments = relativePath.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 3) return undefined;
  const candidate = segments[0].trim();
  return candidate.length > 0 ? candidate : undefined;
}

// ── Lookups ─────────────────────────────────────────────────────────────────

async function findArtistByNameKey(nameKey: string): Promise<IArtist | null> {
  return ArtistModel.findOne({ nameKey });
}

async function findArtistByMusicBrainzId(musicbrainzArtistId: string): Promise<IArtist | null> {
  return ArtistModel.findOne({ 'externalIds.musicbrainzArtistId': musicbrainzArtistId });
}

/**
 * Build a resolution from a name, at the confidence the SIGNAL earned.
 *
 * A high-confidence signal links to an existing artist when one carries the same
 * `nameKey`; when none does, it stays high confidence with no id — the caller may
 * then create the contributed profile through {@link ensureContributedArtist}.
 */
async function resolveFromName(
  rawName: string,
  confidence: Exclude<ArtistConfidence, 'none'>,
  signal: ArtistSignal,
  featured: string[],
): Promise<ArtistResolution> {
  const credit = splitArtistCredit(rawName);
  const primary = credit.primary;
  if (!primary || isDenylistedArtistName(primary)) return NOTHING;

  const nameKey = normalizeNameKey(primary);
  const existing = await findArtistByNameKey(nameKey);
  // De-duplicated: when the resolved name IS the file's artist tag, both lists
  // are the same split of the same string. When it came from the registry or a
  // fingerprint instead, the file's own featured performers still travel.
  const allFeatured = [...new Set([...featured, ...credit.featured])];

  return {
    confidence,
    signal,
    name: primary,
    nameKey,
    featured: allFeatured,
    ...(existing && { matchedArtistId: existing._id.toString() }),
    ...(existing && confidence === 'high' && { linkedArtistId: existing._id.toString() }),
  };
}

function resolutionFromArtist(
  artist: Pick<IArtist, 'name'> & { _id: { toString(): string } },
  signal: ArtistSignal,
  featured: string[],
): ArtistResolution {
  const id = artist._id.toString();
  return {
    confidence: 'high',
    signal,
    name: artist.name,
    nameKey: normalizeNameKey(artist.name),
    matchedArtistId: id,
    linkedArtistId: id,
    featured,
  };
}

// ── The chain ───────────────────────────────────────────────────────────────

/**
 * Resolve the artist for one uploaded file.
 *
 * Tiers run in order and the first that produces anything wins; a tier that
 * yields a denylisted placeholder does not fall through to a weaker tier with a
 * better-looking name, it abstains, because "the file says Various Artists" is
 * information and a folder called `Various Artists` is not a correction.
 */
export async function resolveArtist(input: ArtistResolutionInput): Promise<ArtistResolution> {
  // The featured performers come from whichever credit string exists, and travel
  // with every outcome — they are text either way, so no tier has to earn them.
  const featured = splitArtistCredit(input.artistName ?? '').featured;

  // ── 1: ISRC → an existing catalog track → its artist ──
  //
  // Reachable even though `matchCatalog` also matches on ISRC: that chain only
  // considers PLAYABLE tracks, so a recording taken down for copyright does not
  // dedup the upload but does still tell us, authoritatively, who it is by.
  if (input.isrc) {
    const track = await TrackModel.findOne({ 'externalIds.isrc': input.isrc.toUpperCase() })
      .select('artistId artistName')
      .lean();
    if (track?.artistId) {
      const artist = await ArtistModel.findById(track.artistId).select('name').lean();
      if (artist) return resolutionFromArtist(artist, 'isrc-catalog-track', featured);
    }
  }

  // ── 2: ISRC → IsrcRegistry → the credited artist ──
  if (input.isrc) {
    const row = await IsrcRegistryModel.findOne({ isrc: input.isrc.toUpperCase() })
      .select('artistCredit')
      .lean();
    if (row?.artistCredit) {
      const resolved = await resolveFromName(row.artistCredit, 'high', 'isrc-registry', featured);
      if (resolved.confidence !== 'none') return resolved;
    }
  }

  // ── 3: the audio matched a catalog recording ──
  if (input.fingerprintMatch) {
    const artist = await ArtistModel.findById(input.fingerprintMatch.artistId).select('name').lean();
    if (artist) return resolutionFromArtist(artist, 'fingerprint-catalog-track', featured);
  }

  // ── 4: MusicBrainz artist id ──
  if (input.musicbrainzArtistId) {
    const artist = await findArtistByMusicBrainzId(input.musicbrainzArtistId);
    if (artist) return resolutionFromArtist(artist, 'musicbrainz-artist-id', featured);
    // The identifier is strong even with nobody in our catalog carrying it yet,
    // but a name is still needed to create anything, so it upgrades whichever
    // name the file provides rather than standing on its own.
    const name = input.artistName ?? input.albumArtistName;
    if (name) {
      const resolved = await resolveFromName(name, 'high', 'musicbrainz-artist-id', featured);
      if (resolved.confidence !== 'none') return resolved;
    }
  }

  // ── 5: the artist tag, as plain text ──
  if (input.artistName) {
    const resolved = await resolveFromName(input.artistName, 'medium', 'artist-tag', featured);
    if (resolved.confidence !== 'none') return resolved;
  }

  // ── 6: the album artist, when there is no track artist ──
  if (input.albumArtistName) {
    const resolved = await resolveFromName(
      input.albumArtistName,
      'medium',
      'albumartist-tag',
      featured,
    );
    if (resolved.confidence !== 'none') return resolved;
  }

  // ── 7: the filename, then the folder layout — suggestions only ──
  const guessed = input.fileName ? artistFromFileName(input.fileName) : undefined;
  if (guessed) {
    const resolved = await resolveFromName(guessed, 'low', 'filename', featured);
    if (resolved.confidence !== 'none') return resolved;
  }
  const fromFolder = input.relativePath ? artistFromRelativePath(input.relativePath) : undefined;
  if (fromFolder) {
    const resolved = await resolveFromName(fromFolder, 'low', 'folder-structure', featured);
    if (resolved.confidence !== 'none') return resolved;
  }

  return { ...NOTHING, featured };
}

// ── Creating a contributed profile ──────────────────────────────────────────

export interface ContributedArtistInput {
  name: string;
  /** From `MUSICBRAINZ_ARTISTID`, when the file carried one. */
  musicbrainzArtistId?: string;
  genres?: string[];
  /**
   * Image asset id for the artist's photo. A contributed profile is created
   * WITH one or not at all — the caller enforces that, because a bare profile
   * is the state nothing ever goes back to fix.
   */
  image?: string;
}

/**
 * Find or create the claimable artist profile a contribution attaches to.
 *
 * Separate from {@link resolveArtist} on purpose: resolution is a read and runs
 * for every upload including private ones, creation is a write and must happen
 * only on the public path. Wiring creation into the chain would mean every
 * private locker upload quietly seeding the public catalog with artist rows.
 *
 * `claimable: true` and `origin: 'contributed'` are what make the profile
 * reclaimable later by the real artist. Nothing here ever auto-grants ownership.
 *
 * Returns `null` for a denylisted or empty name rather than throwing: callers
 * reach here having already decided the name is good enough to publish under, and
 * this is the last gate before a permanent row exists.
 */
export async function ensureContributedArtist(
  input: ContributedArtistInput,
): Promise<IArtist | null> {
  const primary = splitArtistCredit(input.name).primary;
  if (!primary || isDenylistedArtistName(primary)) return null;

  const nameKey = normalizeNameKey(primary);
  const existing = await findArtistByNameKey(nameKey);
  if (existing) return existing;

  try {
    const created = await ArtistModel.create({
      name: primary,
      ...(input.image ? { image: input.image } : {}),
      nameKey,
      source: 'upload',
      origin: 'contributed',
      claimable: true,
      acceptsContributions: false,
      ...(input.genres?.length && { genres: input.genres }),
      ...(input.musicbrainzArtistId && {
        externalIds: { musicbrainzArtistId: input.musicbrainzArtistId },
      }),
    });

    /**
     * A profile born from an MP3's tags has a name and nothing else. This is
     * where it gets a photograph and a biography — queued, never awaited: the
     * enrichment sources are rate limited to about one request a second, and the
     * upload that triggered this must not wait behind them.
     *
     * `deliver` never rejects (it falls back to running in-process when Redis is
     * absent), so nothing here can turn a successful artist creation into a
     * failed upload. Enrichment itself refuses any artist without a verified
     * MusicBrainz id, so a name-only profile costs one indexed read.
     */
    // Gated on the MBID rather than enqueued unconditionally: enrichment refuses
    // any artist without one, so queueing a name-only profile schedules work that
    // is guaranteed to do nothing.
    if (input.musicbrainzArtistId) {
      void enqueueArtistEnrichment(created._id.toString());
    }
    return created;
  } catch (err) {
    // The unique partial index on `nameKey` is the arbiter when two uploads name
    // the same new artist at once. The loser reads the winner's row rather than
    // leaving a duplicate that no later write could ever merge.
    if ((err as { code?: number }).code === 11000) {
      const winner = await findArtistByNameKey(nameKey);
      if (winner) return winner;
    }
    throw err;
  }
}
