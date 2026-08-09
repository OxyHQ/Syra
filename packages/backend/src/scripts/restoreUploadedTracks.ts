/**
 * Restore the creator-uploaded tracks the clean-start cutover left behind.
 *
 * The Postgres cutover did not migrate data, so `tracks` came up empty. Podcasts
 * rebuild themselves from RSS; uploads cannot — nobody but the creator has the
 * original. Three tracks were in production, their audio and HLS ladders are
 * still in S3 untouched, and their rows survive in the final Mongo archive.
 *
 * This reads a JSON export of those rows (`data/uploaded-tracks.json`, produced
 * from the archive) and writes them through drizzle, so `tsc` validates every
 * column name — the migration's own gate against a field that flattened
 * differently than its Mongo name suggests (`audioSource.url` -> `audioSourceUrl`,
 * `metadata.genre` -> `metadataGenre`, the `hls` array -> its own child table).
 *
 * Idempotent: every insert is `onConflictDoNothing`, so a partial run resumes by
 * being run again.
 *
 * **The HLS ladder is not optional.** `stream.controller` refuses to resolve a
 * track unless it is `ready`, carries an `hlsMasterKey` AND has at least one
 * rendition row — otherwise it answers 422 and the track is listed but unplayable.
 * Restoring the track without its renditions would look like success and fail at
 * the tap.
 *
 * Usage:  bun run src/scripts/restoreUploadedTracks.ts
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { connectPostgres, closePostgres, getDb } from '../db/postgres';
import {
  catalogEntities,
  albums,
  tracks,
  trackHlsRenditions,
  imageAssets,
  type CATALOG_ENTITY_TYPES,
  type CATALOG_SOURCES,
  type TRACK_STATUSES,
  type ALBUM_TYPES,
  type AUDIO_FORMATS,
  type IMAGE_ASSET_OWNER_TYPES,
} from '../db/schema/catalog';
import { describeErrorSafely } from '../utils/error';
import { logger } from '../utils/logger';

/**
 * The enums the schema narrows to, restated as the export's own types.
 *
 * `tsc` rejected a plain `string` here, which is the gate working: `source` is
 * `'upload' | 'cc'`, not free text, and an archive row carrying anything else is
 * data this schema will not accept. Narrowing the INTERFACE rather than casting
 * at the insert means a bad value fails at the parse, naming the field, instead
 * of at the database with a CHECK violation.
 */
type CatalogSource = (typeof CATALOG_SOURCES)[number];
type CatalogEntityType = (typeof CATALOG_ENTITY_TYPES)[number];
type TrackStatus = (typeof TRACK_STATUSES)[number];
type AlbumType = (typeof ALBUM_TYPES)[number];
type AudioFormat = (typeof AUDIO_FORMATS)[number];
type ImageOwnerType = (typeof IMAGE_ASSET_OWNER_TYPES)[number];

/** The shape the export carries — Mongo documents, not the Postgres row type. */
interface ExportedTrack {
  _id: string;
  title: string;
  artistId: string;
  artistName: string;
  albumId?: string;
  albumName?: string;
  duration: number;
  audioSource?: { url?: string; format?: AudioFormat; bitrate?: number; duration?: number };
  coverArt?: string;
  metadata?: { genre?: string[]; explicit?: boolean };
  tags?: string[];
  isExplicit?: boolean;
  popularity?: number;
  playCount?: number;
  favoriteCount?: number;
  repostCount?: number;
  isAvailable?: boolean;
  copyrightRemoved?: boolean;
  source: CatalogSource;
  status: TrackStatus;
  hlsMasterKey?: string;
  loudnessLufs?: number;
  hls?: Array<{ manifestKey: string; bitrateKbps: number; encrypted?: boolean }>;
  createdAt?: string;
  updatedAt?: string;
}

interface ExportedAlbum {
  _id: string;
  title: string;
  artistId: string;
  artistName: string;
  /** `NOT NULL` and a restrict-FK to `imageAssets` — see `ExportedImage`. */
  coverArt: string;
  /** `NOT NULL` in Postgres — an archive row without it cannot be restored. */
  releaseDate: string;
  type?: AlbumType;
  totalTracks?: number;
  isAvailable?: boolean;
  source: CatalogSource;
}

interface ExportedEntity {
  _id: string;
  name: string;
  nameKey: string;
  type: CatalogEntityType;
  source: CatalogSource;
  popularity?: number;
  verified?: boolean;
  claimable?: boolean;
}

/**
 * Cover art is a real foreign key with `onDelete: 'restrict'`, and `coverArtId` is
 * NOT NULL on both albums and tracks — so the image rows go in FIRST or the whole
 * restore is rejected with 23503. Three images cover all three tracks.
 */
interface ExportedImage {
  _id: string;
  /** The S3 object key — the row is a pointer, and this is what it points at. */
  s3Key: string;
  filename: string;
  contentType: string;
  byteSize: number;
  width?: number;
  height?: number;
  ownerType: ImageOwnerType;
  uploadedBy?: string;
}

interface Export {
  images: ExportedImage[];
  tracks: ExportedTrack[];
  albums: ExportedAlbum[];
  entities: ExportedEntity[];
}

function toDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Find `data/` by walking UP from this module, not by counting `..`.
 *
 * The compiled layout is not the source layout: `tsc` emits this file to
 * `dist/src/scripts/`, while it lives at `src/scripts/`. A fixed
 * `join(__dirname, '..', '..', 'data')` therefore resolves correctly when run
 * from source and lands on `dist/data` — which does not exist — inside the image.
 * The failure surfaces only in production, after a deploy has already reported
 * success, which is exactly the kind a local run cannot catch.
 */
function resolveDataDir(): string {
  let dir = __dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, 'data');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`Could not locate a data/ directory above ${__dirname}`);
}

async function main(): Promise<void> {
  const file = path.join(resolveDataDir(), 'uploaded-tracks.json');
  const data = JSON.parse(await readFile(file, 'utf8')) as Export;

  logger.info(
    `Restoring ${data.images.length} image(s), ${data.entities.length} artist(s), ` +
      `${data.albums.length} album(s), ${data.tracks.length} track(s)`
  );

  await connectPostgres();
  try {
    const db = getDb();

    // Order matters, and it is a chain rather than a pair: images -> artists ->
    // albums -> tracks -> renditions. Every link is a real foreign key now, so a
    // row inserted out of order is rejected with 23503 rather than orphaned.
    for (const image of data.images) {
      await db
        .insert(imageAssets)
        .values([{
          id: image._id,
          s3Key: image.s3Key,
          filename: image.filename,
          contentType: image.contentType,
          byteSize: image.byteSize,
          width: image.width,
          height: image.height,
          ownerType: image.ownerType,
          uploadedBy: image.uploadedBy,
        }])
        .onConflictDoNothing();
    }

    for (const entity of data.entities) {
      await db
        .insert(catalogEntities)
        .values([{
          id: entity._id,
          type: entity.type,
          name: entity.name,
          nameKey: entity.nameKey,
          source: entity.source,
          popularity: entity.popularity ?? 0,
          verified: entity.verified ?? false,
          claimable: entity.claimable ?? false,
        }])
        .onConflictDoNothing();
    }

    for (const album of data.albums) {
      await db
        .insert(albums)
        .values([{
          id: album._id,
          title: album.title,
          artistId: album.artistId,
          artistName: album.artistName,
          coverArtId: album.coverArt,
          releaseDate: album.releaseDate,
          // `albums.artistId` is a real foreign key now, so the artist above must
          // already exist — which is why entities are inserted first.
          type: album.type,
          totalTracks: album.totalTracks,
          isAvailable: album.isAvailable ?? true,
          source: album.source,
        }])
        .onConflictDoNothing();
    }

    for (const track of data.tracks) {
      await db
        .insert(tracks)
        .values([{
          id: track._id,
          title: track.title,
          artistId: track.artistId,
          artistName: track.artistName,
          albumId: track.albumId,
          albumName: track.albumName,
          duration: track.duration,
          audioSourceUrl: track.audioSource?.url,
          audioSourceFormat: track.audioSource?.format,
          audioSourceBitrate: track.audioSource?.bitrate,
          audioSourceDuration: track.audioSource?.duration,
          coverArtId: track.coverArt,
          metadataGenre: track.metadata?.genre,
          metadataExplicit: track.metadata?.explicit,
          tags: track.tags ?? [],
          isExplicit: track.isExplicit ?? false,
          popularity: track.popularity ?? 0,
          playCount: track.playCount ?? 0,
          favoriteCount: track.favoriteCount ?? 0,
          repostCount: track.repostCount ?? 0,
          isAvailable: track.isAvailable ?? true,
          copyrightRemoved: track.copyrightRemoved ?? false,
          source: track.source,
          status: track.status,
          hlsMasterKey: track.hlsMasterKey,
          loudnessLufs: track.loudnessLufs,
          createdAt: toDate(track.createdAt),
          updatedAt: toDate(track.updatedAt),
        }])
        .onConflictDoNothing();

      // The ladder, in ladder order — `position` is what orders it, and the
      // resolver counts these rows before it will hand out a stream token.
      const ladder = track.hls ?? [];
      for (const [position, rendition] of ladder.entries()) {
        await db
          .insert(trackHlsRenditions)
          .values([{
            trackId: track._id,
            position,
            manifestKey: rendition.manifestKey,
            bitrateKbps: rendition.bitrateKbps,
            encrypted: rendition.encrypted ?? true,
          }])
          .onConflictDoNothing();
      }
      logger.info(`restored "${track.title}" with ${ladder.length} rendition(s)`);
    }
  } finally {
    await closePostgres();
  }

  logger.info('Done.');
}

void main().catch((error: unknown) => {
  logger.error('Restore failed', { err: describeErrorSafely(error) });
  process.exitCode = 1;
});
