import { Request, Response, NextFunction } from 'express';
import { eq, sql } from 'drizzle-orm';
import { isLiveEntityId } from '@oxyhq/db';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId as getAuthenticatedUserId } from '@oxyhq/core/server';
import { CreateAlbumRequest, updateAlbumRequestSchema } from '@syra/shared-types';
import { publicColumns } from '@oxyhq/db/assert';
import { getDb, isPostgresConnected } from '../db/postgres';
import { albums, catalogEntities, tracks } from '../db/schema/catalog';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import {
  ALBUM_TRACK_ORDER,
  descNullsLast,
  countAlbumsWithPlayableTracks,
  findAlbumsWithPlayableTracks,
  findOneAlbumWithPlayableTracks,
  playableAlbumTracksWhere,
} from '../db/catalog/containers';
import { albumGenreNames, setAlbumGenres } from '../db/catalog/genres';
import { loadImageVariants, toAlbumDtos, toTrackDtos } from '../db/catalog/hydrate';
import { toAlbumDto, type AlbumRow } from '../db/catalog/serialize';
import { findOwnedArtist } from '../db/catalog/ownership';
import { getParam, parseBoundedLimit, parseOffset } from '../utils/reqParams';
import { getStoredImageColors } from '../utils/imageColors';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';

/**
 * How the public album listing is ordered.
 *
 * The Mongo sort was `withImageFirstSort('album', { releaseDate: -1, createdAt: -1 })`,
 * which prepended `{ coverArt: -1 }`. There is no `imageFirst(albums.coverArtId)`
 * term here and its absence is a decision: `albums.cover_art_id` is `NOT NULL`
 * (an album is not created at all without real cover art), so "has an image
 * first" is a constant for every row and sorts nothing. What the Mongo term DID
 * do was order the rows by the lexical value of their cover-art id BEFORE
 * `releaseDate` — an arbitrary tie-break that took precedence over the ordering
 * the caller actually asked for. Dropping it is what makes release date the
 * primary key of this listing, which is what the call site says it wants.
 */
const ALBUM_LISTING_ORDER = [descNullsLast(albums.releaseDate), descNullsLast(albums.createdAt)];

/**
 * Serialize ONE album, with the genres only the detail surface renders.
 *
 * `toAlbumDtos` deliberately does not load `album_genres` — a listing would pay
 * a join per page for a field nothing shows. A single album does show it, and
 * `Album.genre` was an array ON the Mongo document, so a port that skipped this
 * would drop a live field silently: `toAlbumDto` is an allowlist, and an
 * allowlist that is not asked for a field simply omits it.
 */
async function toAlbumResponse(row: AlbumRow) {
  const [lookup, genres] = await Promise.all([
    loadImageVariants([
      row.coverArtId,
      row.coverArtSizesSmallId,
      row.coverArtSizesMediumId,
      row.coverArtSizesLargeId,
      row.coverArtSizesXlargeId,
      row.coverArtSizesXxlargeId,
      row.coverArtSizesOriginalId,
    ]),
    albumGenreNames(row.id),
  ]);
  return toAlbumDto(row, lookup, { genres });
}

/**
 * GET /api/albums
 * Get all albums
 */
export const getAlbums = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const limit = parseBoundedLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);

    const [rows, total] = await Promise.all([
      findAlbumsWithPlayableTracks(undefined, {
        orderBy: ALBUM_LISTING_ORDER,
        offset,
        limit,
      }),
      countAlbumsWithPlayableTracks(),
    ]);

    res.json({
      albums: await toAlbumDtos(rows),
      total,
      hasMore: offset + limit < total,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/albums/:id
 * Get album by ID
 */
export const getAlbumById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const id = getParam(req, 'id');

    /**
     * BOTH live id shapes, not the 24-hex one alone. `albums.id` is
     * `generatedId()` — a uuid v7 — so a `mongoose.Types.ObjectId.isValid`
     * guard here would 404 every album created after the cutover while the
     * create endpoint that minted it returned 201.
     */
    if (!isLiveEntityId(id)) {
      return res.status(404).json({ error: 'Album not found' });
    }

    const album = await findOneAlbumWithPlayableTracks(id);

    if (!album) {
      return res.status(404).json({ error: 'Album not found' });
    }

    res.json(await toAlbumResponse(album));
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/albums/:id/tracks
 * Get tracks in album
 */
export const getAlbumTracks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const id = getParam(req, 'id');

    if (!isLiveEntityId(id)) {
      return res.status(404).json({ error: 'Album not found' });
    }

    // Verify album exists
    const album = await findOneAlbumWithPlayableTracks(id);
    if (!album) {
      return res.status(404).json({ error: 'Album not found' });
    }

    const rows = await getDb()
      .select(publicColumns(tracks, PROTECTED_COLUMNS_BY_TABLE))
      .from(tracks)
      .where(playableAlbumTracksWhere(id))
      .orderBy(...ALBUM_TRACK_ORDER);

    res.json({
      tracks: await toTrackDtos(rows),
      albumId: id,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/albums
 * Create a new album (authenticated, requires artist profile)
 */
export const createAlbum = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const data: CreateAlbumRequest = req.body;

    if (!data.title || !data.artistId || !data.releaseDate || !data.coverArt) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Title, artistId, releaseDate, and coverArt are required'
      });
    }

    // Ownership from the authenticated user plus the STORED artist row.
    const artist = await findOwnedArtist(data.artistId, userId);

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

    // Reject blob URLs, http/https URLs, or any other format
    if (data.coverArt.startsWith('blob:') || data.coverArt.startsWith('http://') || data.coverArt.startsWith('https://') || data.coverArt.startsWith('/api/')) {
      return res.status(400).json({
        error: 'Invalid coverArt',
        message: 'coverArt must be a valid image ID. Images must be uploaded first using /api/images/upload.'
      });
    }

    // Both live id shapes — see `getAlbumById`. The message no longer promises
    // "24 hex characters", which stopped being true when `image_assets.id`
    // became a uuid v7.
    if (!isLiveEntityId(data.coverArt)) {
      return res.status(400).json({
        error: 'Invalid coverArt',
        message: 'coverArt must be a valid image ID. Images must be uploaded first using /api/images/upload.'
      });
    }

    const colors = await getStoredImageColors(data.coverArt);

    /**
     * One transaction for three writes, because `album_genres` is a child table
     * now: the album row, its genre links, and the artist's album counter. In
     * Mongo `genre` was an array on the document and the counter a separate
     * `updateOne` that could fail on its own; here a half-created album with no
     * genres is representable and a transaction is what makes it unreachable.
     */
    const created = await getDb().transaction(async (tx) => {
      const [row] = await tx
        .insert(albums)
        .values({
          title: data.title,
          artistId: data.artistId,
          artistName: artist.name,
          releaseDate: data.releaseDate,
          coverArtId: data.coverArt,
          type: data.type || 'album',
          label: data.label,
          copyright: data.copyright,
          isExplicit: data.isExplicit || false,
          totalTracks: 0,
          totalDuration: 0,
          primaryColor: colors?.primaryColor,
          secondaryColor: colors?.secondaryColor,
          popularity: 0,
        })
        .returning();

      if (!row) throw new Error('createAlbum: insert returned no row');

      await setAlbumGenres(tx, row.id, data.genre ?? []);
      await tx
        .update(catalogEntities)
        .set({ statsAlbums: sql`${catalogEntities.statsAlbums} + 1` })
        .where(eq(catalogEntities.id, data.artistId));

      return row;
    });

    res.status(201).json(await toAlbumResponse(created));
  } catch (error: unknown) {
    logger.error('[AlbumsController] Error creating album:', { error: describeErrorSafely(error) });
    next(error);
  }
};

/**
 * PATCH /api/albums/:id
 * Edit an album you own. Only the fields in `updateAlbumRequestSchema` are accepted —
 * the body is parsed, never spread — so `artistId`, play counts, and provenance
 * (`source`, `sources`, `externalIds`) are unreachable through this endpoint.
 */
export const updateAlbum = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const albumId = getParam(req, 'id');

    if (!isLiveEntityId(albumId)) {
      return res.status(400).json({ error: 'Invalid album id' });
    }

    const parsed = updateAlbumRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const album = await loadOwnedAlbumOrRespond(req, res);
    if (!album) return;

    const updates = parsed.data;

    // Explicit field-by-field assignment — the parsed object is never spread
    // into the `set`, so no key the schema does not declare can reach a column.
    const set: Partial<typeof albums.$inferInsert> = {};
    if (updates.title !== undefined) set.title = updates.title;
    if (updates.releaseDate !== undefined) set.releaseDate = updates.releaseDate;
    if (updates.coverArt !== undefined) set.coverArtId = updates.coverArt;
    if (updates.type !== undefined) set.type = updates.type;
    if (updates.label !== undefined) set.label = updates.label;
    if (updates.copyright !== undefined) set.copyright = updates.copyright;

    const updated = await getDb().transaction(async (tx) => {
      // `genre` is a child table, so it is never part of the `set`; an
      // empty `set` with only genres supplied must still not issue a bare
      // `update` with nothing to write, which drizzle rejects at runtime.
      const [row] = Object.keys(set).length
        ? await tx.update(albums).set(set).where(eq(albums.id, album.id)).returning()
        : [album];
      if (!row) throw new Error('updateAlbum: update returned no row');
      if (updates.genre !== undefined) await setAlbumGenres(tx, row.id, updates.genre);
      return row;
    });

    res.json(await toAlbumResponse(updated));
  } catch (error) {
    next(error);
  }
};

/**
 * Load an album the caller owns, or send the matching error response.
 * Returns null once a response has been sent, so callers `if (!album) return;`.
 */
const loadOwnedAlbumOrRespond = async (
  req: AuthRequest,
  res: Response,
): Promise<AlbumRow | null> => {
  const userId = getAuthenticatedUserId(req);
  const albumId = getParam(req, 'id');

  if (!isLiveEntityId(albumId)) {
    res.status(400).json({ error: 'Invalid album id' });
    return null;
  }

  const [album] = await getDb().select().from(albums).where(eq(albums.id, albumId)).limit(1);
  if (!album) {
    res.status(404).json({ error: 'Album not found' });
    return null;
  }

  // Ownership comes from the STORED album's artistId, never from the request body.
  if (!(await findOwnedArtist(album.artistId, userId))) {
    res.status(403).json({ error: 'Forbidden', message: 'You do not own this album' });
    return null;
  }

  return album;
};

/** Flip an owned album's `isAvailable`, and answer with the album. */
async function setAlbumAvailability(
  req: AuthRequest,
  res: Response,
  isAvailable: boolean,
): Promise<void> {
  const album = await loadOwnedAlbumOrRespond(req, res);
  if (!album) return;

  const [updated] = await getDb()
    .update(albums)
    .set({ isAvailable })
    .where(eq(albums.id, album.id))
    .returning();

  if (!updated) throw new Error('setAlbumAvailability: update returned no row');
  res.json(await toAlbumResponse(updated));
}

/**
 * POST /api/albums/:id/unpublish — hide the album as a container.
 *
 * Soft, and deliberately container-only: `isAvailable:false` drops the album out of
 * `findAlbumsWithPlayableTracks`, but its tracks stay individually discoverable in
 * search and on the artist page. "Retire this album" and "unpublish these ten songs"
 * are different creator intents — unpublishing the tracks is a separate action per track.
 * Nothing is deleted, so republishing is lossless.
 */
export const unpublishAlbum = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    await setAlbumAvailability(req, res, false);
  } catch (error) {
    next(error);
  }
};

/** POST /api/albums/:id/publish — undo `unpublishAlbum`. */
export const publishAlbum = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    await setAlbumAvailability(req, res, true);
  } catch (error) {
    next(error);
  }
};
