import type { ExternalTrack, CatalogSource, SourceProvenance, TrackImage } from '@syra/shared-types';
import { TrackModel } from '../../models/Track';
import type { ITrack } from '../../models/Track';
import { ArtistModel } from '../../models/Artist';
import { upsertArtist } from './upsertArtist';
import { playCountToPopularity } from './popularity';

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

/** Merge external images into an existing array, deduplicating by URL. */
function mergeImages(
  existing: TrackImage[] | undefined,
  incoming: TrackImage[] | undefined,
): TrackImage[] {
  const base = existing ?? [];
  if (!incoming?.length) return base;
  const seen = new Set(base.map((img) => img.url));
  return [...base, ...incoming.filter((img) => !seen.has(img.url))];
}

/** Derive the status for a newly-imported track based on its source. */
function statusForSource(source: CatalogSource): 'processing' | 'ready' {
  return source === 'cc' ? 'processing' : 'ready';
}

/**
 * Determine which fields the external payload is contributing (non-empty values
 * that will actually be written). Used to populate SourceProvenance.fields.
 */
function contributedFields(external: ExternalTrack): string[] {
  const fields: string[] = ['title'];
  if (external.durationSec) fields.push('duration');
  if (external.isrc) fields.push('isrc');
  if (external.images?.length) fields.push('images');
  if (external.streamUrl) fields.push('streamUrl');
  if (external.downloadUrl) fields.push('downloadUrl');
  if (external.album?.name) fields.push('albumName');
  if (external.artists.length > 1) fields.push('artistIds');
  if (external.genre) fields.push('genre');
  if (external.mood) fields.push('mood');
  if (external.tags?.length) fields.push('tags');
  if (external.releaseDate) fields.push('releaseDate');
  if (external.popularity) fields.push('popularity');
  return fields;
}

/** Parse a provider release-date string to a Date, or undefined if invalid. */
function parseReleaseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Union a new genre into an artist's `genres` array (case-sensitive, exact).
 * No-op when the genre is empty or already present. Persists via $addToSet so
 * concurrent track imports for the same artist never lose a genre.
 */
async function rollGenreUpToArtist(artistId: string, genre: string | undefined): Promise<void> {
  if (!genre) return;
  await ArtistModel.updateOne({ _id: artistId }, { $addToSet: { genres: genre } });
}

function buildProvenance(
  source: CatalogSource,
  externalId: string,
  fields: string[],
): SourceProvenance {
  return {
    provider: source,
    externalId,
    importedAt: new Date().toISOString(),
    fields,
  };
}

/**
 * Find an existing track by ISRC (tier 1).
 */
async function findByIsrc(isrc: string): Promise<ITrack | null> {
  return TrackModel.findOne({ 'externalIds.isrc': isrc });
}

/**
 * Find an existing track by provenance — same provider + externalId recorded
 * in sources[], or by audiusId for Audius tracks (tier 2).
 */
async function findByProvenance(
  source: CatalogSource,
  externalId: string,
): Promise<ITrack | null> {
  if (source === 'audius') {
    const byAudiusId = await TrackModel.findOne({ 'externalIds.audiusId': externalId });
    if (byAudiusId) return byAudiusId;
  }
  return TrackModel.findOne({
    sources: { $elemMatch: { provider: source, externalId } },
  });
}

/**
 * Find an existing track by fuzzy key: normalized title + normalized primary
 * artist name + duration within ±2 seconds (tier 3).
 *
 * NOTE: The fuzzy match stores `artistName` as plain text, so we compare the
 * normalized form of the stored `artistName` against the normalized incoming
 * artist name in-process after a narrow duration range query.
 */
async function findByFuzzy(
  title: string,
  artistName: string,
  durationSec: number,
): Promise<ITrack | null> {
  const normTitle = normalizeForFuzzy(title);
  const normArtist = normalizeForFuzzy(artistName);

  // Pull candidates within the ±2s window; normalize and compare in-process.
  // The duration window keeps the candidate set small.
  const candidates = await TrackModel.find({
    duration: { $gte: durationSec - 2, $lte: durationSec + 2 },
  }).lean();

  for (const c of candidates) {
    if (
      normalizeForFuzzy(c.title) === normTitle &&
      normalizeForFuzzy(c.artistName) === normArtist
    ) {
      // Return the live (non-lean) doc so callers can mutate and save.
      return TrackModel.findById(c._id);
    }
  }
  return null;
}

/**
 * Upsert an external track into the catalog.
 *
 * Dedup order:
 *  1. ISRC (`externalIds.isrc`) — strongest global identifier.
 *  2. Provenance match — same provider + externalId in sources[], or audiusId.
 *  3. Fuzzy — normalized title + primary artistName + duration ±2s.
 *
 * The primary artist is resolved (and upserted) via `upsertArtist` so that
 * `artistId` is always a real Mongo ObjectId.
 */
export async function upsertTrack(
  external: ExternalTrack,
  source: CatalogSource,
): Promise<{ track: ITrack; created: boolean }> {
  if (!external.artists.length) {
    throw new Error('upsertTrack: external.artists must contain at least one entry');
  }

  const primaryExternal = external.artists[0];
  const { artist } = await upsertArtist(primaryExternal, source);
  const artistId = artist._id.toString();
  const artistName = artist.name;

  const fields = contributedFields(external);
  const provenance = buildProvenance(source, external.externalId, fields);

  // --- Tier 1: ISRC ---
  let existing: ITrack | null = null;
  if (external.isrc) {
    existing = await findByIsrc(external.isrc);
  }

  // --- Tier 2: Provenance ---
  if (!existing) {
    existing = await findByProvenance(source, external.externalId);
  }

  // --- Tier 3: Fuzzy ---
  if (!existing) {
    existing = await findByFuzzy(external.title, artistName, external.durationSec);
  }

  const releaseDate = parseReleaseDate(external.releaseDate);
  const playCount = external.popularity?.playCount;

  // --- Create ---
  if (!existing) {
    const track = await TrackModel.create({
      title: external.title,
      artistId,
      artistName,
      duration: external.durationSec,
      albumName: external.album?.name,
      source,
      status: statusForSource(source),
      isExplicit: false,
      isAvailable: true,
      externalIds: {
        ...(external.isrc ? { isrc: external.isrc } : {}),
        ...(source === 'audius' ? { audiusId: external.externalId } : {}),
      },
      images: external.images ?? [],
      streamUrl: external.streamUrl,
      genre: external.genre,
      mood: external.mood,
      tags: external.tags ?? [],
      releaseDate,
      ...(playCount !== undefined ? { playCount, popularity: playCountToPopularity(playCount) } : {}),
      ...(external.popularity?.favoriteCount !== undefined
        ? { favoriteCount: external.popularity.favoriteCount }
        : {}),
      ...(external.popularity?.repostCount !== undefined
        ? { repostCount: external.popularity.repostCount }
        : {}),
      sources: [provenance],
    });
    await rollGenreUpToArtist(artistId, external.genre);
    return { track, created: true };
  }

  // --- Update: merge without clobbering ---
  // Always append provenance.
  existing.sources = [...(existing.sources ?? []), provenance];

  if (external.title) existing.title = external.title;
  if (external.durationSec) existing.duration = external.durationSec;
  if (external.album?.name && !existing.albumName) {
    existing.albumName = external.album.name;
  }
  // Merge images — never shrink an existing non-empty array to empty.
  existing.images = mergeImages(existing.images, external.images);
  // Only set streamUrl if not already present.
  if (external.streamUrl && !existing.streamUrl) {
    existing.streamUrl = external.streamUrl;
  }
  // Merge externalIds without clobbering.
  if (external.isrc && !existing.externalIds?.isrc) {
    existing.externalIds = { ...(existing.externalIds ?? {}), isrc: external.isrc };
  }
  if (source === 'audius' && external.externalId && !existing.externalIds?.audiusId) {
    existing.externalIds = {
      ...(existing.externalIds ?? {}),
      audiusId: external.externalId,
    };
  }

  // Provider metadata — only set when incoming has a value AND existing lacks one,
  // so a later import that omits a field never clobbers a previously-synced value.
  if (external.genre && !existing.genre) existing.genre = external.genre;
  if (external.mood && !existing.mood) existing.mood = external.mood;
  if (external.tags?.length && !existing.tags?.length) existing.tags = external.tags;
  if (releaseDate && !existing.releaseDate) existing.releaseDate = releaseDate;
  // Popularity signals reflect live counts — refresh upward when the new value
  // is larger (counts are monotonic), never downward.
  if (playCount !== undefined && playCount > (existing.playCount ?? 0)) {
    existing.playCount = playCount;
    existing.popularity = playCountToPopularity(playCount);
  }
  if (
    external.popularity?.favoriteCount !== undefined &&
    external.popularity.favoriteCount > (existing.favoriteCount ?? 0)
  ) {
    existing.favoriteCount = external.popularity.favoriteCount;
  }
  if (
    external.popularity?.repostCount !== undefined &&
    external.popularity.repostCount > (existing.repostCount ?? 0)
  ) {
    existing.repostCount = external.popularity.repostCount;
  }

  const track = await existing.save();
  await rollGenreUpToArtist(artistId, external.genre);
  return { track, created: false };
}
