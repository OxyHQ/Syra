import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import os from 'os';
import multer from 'multer';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { isLiveEntityId, uuidv7 } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import type { HlsRendition, SourceProvenance, Track, TrackCredit } from '@syra/shared-types';
import { updateTrackRequestSchema } from '@syra/shared-types';
import { getDb, isPostgresConnected } from '../db/postgres';
import {
  albums,
  catalogEntities,
  trackHlsRenditions,
  trackSources,
  tracks,
} from '../db/schema/catalog';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import { descNullsLast } from '../db/catalog/containers';
import { textSearch } from '../db/catalog/search';
import { loadTrackCredits, toTrackDtos } from '../db/catalog/hydrate';
import { findOwnedArtist } from '../db/catalog/ownership';
import type { PublicTrackRow } from '../db/catalog/serialize';
import { playableTrackFilter } from '../db/catalog/visibility';
import { env } from '../config/env';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId as getAuthenticatedUserId } from '@oxyhq/core/server';
import { uploadTrackAudio } from '../services/audioStorageService';
import { logger } from '../utils/logger';
import { getStoredImageColors } from '../utils/imageColors';
import { enqueueIngest } from '../services/ingest/ingestQueue';
import {
  AUDIO_UPLOAD_REJECTED_MESSAGE,
  MAX_AUDIO_UPLOAD_BYTES,
  audioFormatFor,
  isAllowedAudioMime,
} from '../config/audioUpload';
import { probeAudio } from '../services/ingest/probeAudio';
import type { ProbedAudio } from '../services/ingest/probeAudio';
import { getErrorMessage, getErrorStack, getHttpStatus } from '../utils/error';
import { getParam, parseBoundedLimit, parseOffset } from '../utils/reqParams';
import { describeErrorSafely } from '../utils/error';

interface AudioUploadRequest extends AuthRequest {
  file?: Express.Multer.File;
}

/** The public columns of `tracks` — no `sha256`, no `images`. */
const publicTrackColumns = () => publicColumns(tracks, PROTECTED_COLUMNS_BY_TABLE);

/**
 * GET /api/tracks
 * Get all tracks with pagination
 */
export const getTracks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const limit = parseBoundedLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);

    const [rows, [totals]] = await Promise.all([
      getDb()
        .select(publicTrackColumns())
        .from(tracks)
        .where(playableTrackFilter())
        .orderBy(descNullsLast(tracks.createdAt))
        .offset(offset)
        .limit(limit),
      getDb().select({ total: count() }).from(tracks).where(playableTrackFilter()),
    ]);

    const total = totals?.total ?? 0;

    res.json({
      tracks: await toTrackDtos(rows),
      total,
      hasMore: offset + limit < total,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * The child collections only the single-track surface renders.
 *
 * `credits`, `sources` and the HLS ladder were EMBEDDED arrays on the Mongo
 * document, so `toApiFormat`'s spread put all three on `GET /api/tracks/:id`
 * for free. They are child tables now and `toTrackDto` is an allowlist, so a
 * port that did not ask for them would have dropped three live fields with
 * nothing to notice — an allowlist omits in silence, which is what makes this
 * the dangerous direction. Three bounded reads, and only for the one endpoint
 * that renders them: `toTrackDtos` deliberately loads none of them for a page.
 */
async function loadTrackDetail(trackId: string): Promise<{
  credits: TrackCredit[];
  sources: SourceProvenance[];
  hlsRenditions: HlsRendition[];
}> {
  const [creditsByTrack, sourceRows, renditionRows] = await Promise.all([
    // The SAME loader the listings use. This endpoint used to name its own
    // three columns here and omitted `catalogEntityId`, so one credit came back
    // linked from a listing and unlinked from the detail view.
    loadTrackCredits([trackId]),
    getDb()
      .select({
        provider: trackSources.provider,
        externalId: trackSources.externalId,
        importedAt: trackSources.importedAt,
        fields: trackSources.fields,
      })
      .from(trackSources)
      .where(eq(trackSources.trackId, trackId))
      .orderBy(asc(trackSources.position)),
    getDb()
      .select({
        manifestKey: trackHlsRenditions.manifestKey,
        bitrateKbps: trackHlsRenditions.bitrateKbps,
        encrypted: trackHlsRenditions.encrypted,
      })
      .from(trackHlsRenditions)
      .where(eq(trackHlsRenditions.trackId, trackId))
      // `position`, not `bitrateKbps`: the stored order is the one the ladder
      // was written in, and a read must not invent a different one.
      .orderBy(asc(trackHlsRenditions.position)),
  ]);

  return {
    credits: creditsByTrack.get(trackId) ?? [],
    sources: sourceRows.map((row) => ({
      provider: row.provider,
      externalId: row.externalId,
      importedAt: row.importedAt.toISOString(),
      fields: row.fields,
    })),
    hlsRenditions: renditionRows,
  };
}

/**
 * Serialize ONE track: the page serializer plus the three child collections it
 * deliberately leaves out.
 *
 * Built on `toTrackDtos` rather than on `toTrackDto` directly so the album
 * cover-art fallback, the image-variant lookup and the HLS count behind
 * `previewAvailable` are the SAME code the listings run. A hand-rolled
 * single-row path would be a second implementation of the fallback, free to
 * drift from the one every list surface uses.
 */
async function toTrackResponse(row: PublicTrackRow): Promise<Track> {
  const [[dto], detail] = await Promise.all([toTrackDtos([row]), loadTrackDetail(row.id)]);
  if (!dto) throw new Error('toTrackResponse: the serializer returned no DTO');

  return {
    ...dto,
    credits: detail.credits,
    sources: detail.sources,
    hls: detail.hlsRenditions,
  };
}

/**
 * GET /api/tracks/:id
 * Get track by ID
 */
export const getTrackById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const id = getParam(req, 'id');

    if (!isLiveEntityId(id)) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const [track] = await getDb()
      .select(publicTrackColumns())
      .from(tracks)
      .where(and(eq(tracks.id, id), playableTrackFilter()))
      .limit(1);

    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    res.json(await toTrackResponse(track));
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/tracks/search
 * Search tracks
 *
 * `search_vector @@ websearch_to_tsquery(…)` with a prefix on the final term —
 * see `db/catalog/search.ts` for the ruling, what it gains (a GIN index, and
 * stemming) and what it deliberately loses (infix: "love" no longer finds
 * "Glove"). This site and `search.controller`'s five moved together.
 *
 * It also ends the ReDoS this endpoint shipped with. `new RegExp(req.query.q,
 * 'i')` compiled a raw query-string parameter on a PUBLIC route and ran it
 * against every track; `main`'s PR #84 fixed it by escaping the pattern. There
 * is no regex ENGINE here any more, so there is nothing left to escape and no
 * backtracking to exploit — see the report on retiring #84's source assertions
 * with the code they guard.
 */
export const searchTracks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const query = (req.query.q as string) || '';
    const limit = parseBoundedLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);

    if (!query.trim()) {
      return res.json({
        tracks: [],
        total: 0,
        hasMore: false,
      });
    }

    const matches = and(playableTrackFilter(), textSearch(tracks.searchVector, query));

    const [rows, [totals]] = await Promise.all([
      getDb()
        .select(publicTrackColumns())
        .from(tracks)
        .where(matches)
        .orderBy(descNullsLast(tracks.popularity), descNullsLast(tracks.createdAt))
        .offset(offset)
        .limit(limit),
      getDb().select({ total: count() }).from(tracks).where(matches),
    ]);

    const total = totals?.total ?? 0;

    res.json({
      tracks: await toTrackDtos(rows),
      total,
      hasMore: offset + limit < total,
    });
  } catch (error) {
    next(error);
  }
};

// Configure multer for audio file uploads.
//
// Disk storage, not memory: ffprobe (duration/bitrate), fpcalc (fingerprint) and
// music-metadata (tags) all read a path, and holding a 200MB Buffer per in-flight
// request does not survive consumer upload volume. Multer removes the temp file
// itself when the multipart parse fails (filter rejection, size limit); every
// path AFTER a successful parse is cleaned up in `uploadTrack`'s `finally`.
//
// The cap and the allowlist come from `config/audioUpload` so this controller and
// the listener-upload controller cannot drift on what Syra accepts.
const audioUpload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: {
    fileSize: MAX_AUDIO_UPLOAD_BYTES,
  },
  fileFilter: (req, file, cb) => {
    if (isAllowedAudioMime(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(AUDIO_UPLOAD_REJECTED_MESSAGE));
    }
  },
}).single('audioFile');

/**
 * POST /api/tracks/upload
 * Upload a new track (authenticated, requires artist profile)
 */
export const uploadTrack = async (req: AuthRequest, res: Response, next: NextFunction) => {
  // Handle file upload
  audioUpload(req, res, async (err) => {
    if (err) {
      logger.error('[TracksController] Multer upload error:', { err: describeErrorSafely(err) });
      return res.status(400).json({ error: 'Upload error', message: err.message });
    }

    // Multer has written the upload to a temp file. It must be removed on every
    // exit path below — validation rejection, thrown error, and success alike.
    const tempPath = (req as AudioUploadRequest).file?.path;

    try {
      logger.debug('[TracksController] Starting track upload process...');
      if (!isPostgresConnected()) {
        return res.status(503).json({ error: 'Database not available' });
      }

      const userId = getAuthenticatedUserId(req);
      const file = (req as AudioUploadRequest).file;

      if (!file) {
        return res.status(400).json({ error: 'Missing file', message: 'Audio file is required' });
      }

      // Get form data
      const { title, artistId, albumId, coverArt, genre, isExplicit } = req.body;

      if (!title || !artistId) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'Title and artistId are required'
        });
      }

      // Ownership from the authenticated user plus the STORED artist row.
      const artist = await findOwnedArtist(artistId, userId);

      if (!artist) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'You do not own this artist profile'
        });
      }

      // Check if uploads are disabled due to strikes
      if (artist.uploadsDisabled) {
        return res.status(403).json({
          error: 'Uploads disabled',
          message: 'Uploads are disabled due to copyright strikes. Please contact support for more information.'
        });
      }

      // Validate album if provided
      let album: { id: string; title: string } | null = null;
      if (albumId) {
        const [found] = await getDb()
          .select({ id: albums.id, title: albums.title })
          .from(albums)
          .where(and(eq(albums.id, albumId), eq(albums.artistId, artistId)))
          .limit(1);

        if (!found) {
          return res.status(404).json({
            error: 'Album not found',
            message: 'Album does not exist or does not belong to this artist'
          });
        }
        album = found;
      }

      // Determine audio format from file
      // Non-null by construction: multer's fileFilter already refused anything
      // not on the allowlist, and both sides read the same table.
      const format = audioFormatFor(file.mimetype) ?? 'mp3';

      // Duration and bitrate come from the file, never from the client. A
      // hand-typed duration was both a bad user experience and unenforceable.
      let probed: ProbedAudio;
      try {
        probed = await probeAudio(file.path);
      } catch (probeError: unknown) {
        logger.warn('[TracksController] ffprobe rejected the uploaded audio', {
          message: getErrorMessage(probeError),
        });
        return res.status(400).json({
          error: 'Unreadable audio',
          message: 'The audio file could not be read. Please upload a valid audio file.',
        });
      }

      // Validate coverArt if provided - must be the id of an already-uploaded asset
      if (coverArt) {
        // Reject blob URLs, http/https URLs, or any other format
        if (coverArt.startsWith('blob:') || coverArt.startsWith('http://') || coverArt.startsWith('https://') || coverArt.startsWith('/api/')) {
          return res.status(400).json({
            error: 'Invalid coverArt',
            message: 'coverArt must be a valid image ID. Images must be uploaded first using /api/images/upload.'
          });
        }

        // Both live id shapes — `image_assets.id` is a uuid v7 for anything
        // uploaded since the cutover, so an ObjectId-only check would reject
        // the id the upload endpoint had just minted.
        if (!isLiveEntityId(coverArt)) {
          return res.status(400).json({
            error: 'Invalid coverArt',
            message: 'coverArt must be a valid image ID. Images must be uploaded first using /api/images/upload.'
          });
        }

      }

      const coverArtColors = coverArt ? await getStoredImageColors(coverArt) : undefined;

      /**
       * The id is minted before the upload, and that ordering is load-bearing:
       * the S3 key embeds it (`getTrackS3Key`), so the object cannot be written
       * until the id exists. An upload that succeeds and an insert that then
       * fails leaves an orphaned object with no row — the safe direction, and
       * the same trade `services/imageAssetService.ts` documents. `new
       * mongoose.Types.ObjectId()` did exactly this job before.
       */
      const trackId = uuidv7();
      const metadataGenre = genre ? (Array.isArray(genre) ? genre : [genre]) : undefined;
      const explicit = isExplicit === 'true' || isExplicit === true;
      const audioSourceUrl = `/api/audio/${trackId}`;

      logger.debug('[TracksController] Starting S3 upload...');
      // Streamed from the temp file rather than buffered: the S3 client derives
      // Content-Length from the fs.ReadStream's path, so nothing is held in memory.
      await uploadTrackAudio(
        {
          id: trackId,
          artistId,
          albumId: albumId || undefined,
          title,
          audioSource: {
            url: audioSourceUrl,
            format,
            bitrate: probed.bitrateKbps,
            duration: probed.durationSec,
          },
        },
        fs.createReadStream(file.path),
      );
      logger.debug('[TracksController] S3 upload completed, saving track to database...');

      logger.debug('[TracksController] Attempting to save track to database', { trackId });
      /**
       * One transaction for the track and both counters. In Mongo these were
       * three independent writes, so a failed `$inc` left the catalogue with a
       * track the artist's `stats.tracks` did not count.
       */
      const saved = await getDb().transaction(async (tx) => {
        const [row] = await tx
          .insert(tracks)
          .values({
            id: trackId,
            title,
            artistId,
            artistName: artist.name,
            albumId: albumId || undefined,
            albumName: album?.title,
            duration: probed.durationSec,
            audioSourceUrl,
            audioSourceFormat: format,
            audioSourceBitrate: probed.bitrateKbps,
            audioSourceDuration: probed.durationSec,
            coverArtId: coverArt || undefined,
            primaryColor: coverArtColors?.primaryColor,
            secondaryColor: coverArtColors?.secondaryColor,
            metadataGenre,
            metadataExplicit: explicit,
            isExplicit: explicit,
            isAvailable: true,
            playCount: 0,
            popularity: 0,
            source: 'upload',
            status: 'processing',
          })
          .returning(publicTrackColumns());

        if (!row) throw new Error('uploadTrack: insert returned no row');

        await tx
          .update(catalogEntities)
          .set({ statsTracks: sql`${catalogEntities.statsTracks} + 1` })
          .where(eq(catalogEntities.id, artistId));

        if (albumId) {
          await tx
            .update(albums)
            .set({
              totalTracks: sql`${albums.totalTracks} + 1`,
              totalDuration: sql`${albums.totalDuration} + ${probed.durationSec}`,
            })
            .where(eq(albums.id, albumId));
        }

        return row;
      });
      logger.debug('[TracksController] Track saved to database successfully', { trackId });

      // Hand the track to durable ingest; status transitions processing→ready|failed.
      // Awaited so the 201 is only sent once the job is recorded, but it never
      // waits for the transcode itself.
      await enqueueIngest(trackId);

      logger.debug('[TracksController] Formatting response...');
      const finalTrack = await toTrackResponse(saved);
      logger.debug('[TracksController] Sending response', { trackId: finalTrack.id });

      // Ensure response is sent
      if (!res.headersSent) {
        res.status(201).json(finalTrack);
      } else {
        logger.warn('[TracksController] Response already sent, cannot send track data');
      }
    } catch (error: unknown) {
      logger.error('[TracksController] Error uploading track:', {
        message: getErrorMessage(error),
        stack: getErrorStack(error),
        name: error instanceof Error ? error.name : 'UnknownError',
      });

      if (!res.headersSent) {
        res.status(getHttpStatus(error)).json({
          error: getErrorMessage(error) || 'Internal Server Error',
          ...(env.NODE_ENV === 'development' && { details: getErrorStack(error) }),
        });
      } else {
        logger.error('[TracksController] Error occurred but response already sent');
      }
    } finally {
      if (tempPath) {
        // `force` makes an already-removed file a no-op; any other failure is a
        // real disk problem and is logged rather than swallowed.
        await fs.promises.rm(tempPath, { force: true }).catch((rmError: unknown) =>
          logger.warn('[TracksController] Failed to remove upload temp file', {
            tempPath,
            message: getErrorMessage(rmError),
          }),
        );
      }
    }
  });
};

/**
 * PATCH /api/tracks/:id
 * Edit a track you own. Only the fields in `updateTrackRequestSchema` are accepted —
 * the request body is parsed, never spread — so a caller cannot reach `artistId`,
 * `source`, play counts, or the copyright-takedown fields through this endpoint.
 */
export const updateTrack = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const trackId = getParam(req, 'id');

    if (!isLiveEntityId(trackId)) {
      return res.status(400).json({ error: 'Invalid track id' });
    }

    const parsed = updateTrackRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const [track] = await getDb()
      .select({
        id: tracks.id,
        artistId: tracks.artistId,
        copyrightRemoved: tracks.copyrightRemoved,
      })
      .from(tracks)
      .where(eq(tracks.id, trackId))
      .limit(1);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    // Ownership comes from the STORED track's artistId, never from the request body.
    if (!(await findOwnedArtist(track.artistId, userId))) {
      return res.status(403).json({ error: 'Forbidden', message: 'You do not own this track' });
    }

    // A copyright takedown is not a creator-reversible state: editing must not be a way
    // to put a removed track back in the catalog.
    if (track.copyrightRemoved) {
      return res.status(409).json({
        error: 'Track removed',
        message: 'This track was removed for copyright and cannot be edited',
      });
    }

    const updates = parsed.data;

    if (updates.albumId !== undefined) {
      const [album] = await getDb()
        .select({ artistId: albums.artistId })
        .from(albums)
        .where(eq(albums.id, updates.albumId))
        .limit(1);
      if (!album || album.artistId !== track.artistId) {
        return res.status(400).json({
          error: 'Invalid albumId',
          message: 'Album not found or not owned by this artist',
        });
      }
    }

    // Explicit field-by-field assignment — the parsed object is never spread
    // into the `set`.
    const set: Partial<typeof tracks.$inferInsert> = {};
    if (updates.title !== undefined) set.title = updates.title;
    if (updates.albumId !== undefined) set.albumId = updates.albumId;
    if (updates.trackNumber !== undefined) set.trackNumber = updates.trackNumber;
    if (updates.discNumber !== undefined) set.discNumber = updates.discNumber;
    if (updates.coverArt !== undefined) set.coverArtId = updates.coverArt;
    if (updates.isAvailable !== undefined) set.isAvailable = updates.isAvailable;
    /**
     * `metadata` was a subdocument merged with `{ ...track.metadata, ...updates.metadata }`
     * — the keys the caller sent overwrite, the rest survive. Six flat columns
     * give exactly that: a key absent from `updates.metadata` is absent from the
     * `set` and its column is not written.
     */
    if (updates.metadata !== undefined) {
      const metadata = updates.metadata;
      if (metadata.genre !== undefined) set.metadataGenre = metadata.genre;
      if (metadata.bpm !== undefined) set.metadataBpm = metadata.bpm;
      if (metadata.key !== undefined) set.metadataKey = metadata.key;
      if (metadata.explicit !== undefined) set.metadataExplicit = metadata.explicit;
      if (metadata.language !== undefined) set.metadataLanguage = metadata.language;
      if (metadata.copyright !== undefined) set.metadataCopyright = metadata.copyright;
      if (metadata.publisher !== undefined) set.metadataPublisher = metadata.publisher;
    }

    const [updated] = Object.keys(set).length
      ? await getDb()
          .update(tracks)
          .set(set)
          .where(eq(tracks.id, track.id))
          .returning(publicTrackColumns())
      : await getDb()
          .select(publicTrackColumns())
          .from(tracks)
          .where(eq(tracks.id, track.id))
          .limit(1);

    if (!updated) {
      return res.status(404).json({ error: 'Track not found' });
    }

    res.json(await toTrackResponse(updated));
  } catch (error) {
    next(error);
  }
};
