import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { AlbumModel, type IAlbum } from '../models/Album';
import { TrackModel } from '../models/Track';
import { ArtistModel } from '../models/CatalogEntity';
import { formatTracksWithCoverArt, formatAlbumWithCoverArt, formatAlbumsWithCoverArt } from '../utils/musicHelpers';
import { isDatabaseConnected } from '../utils/database';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId as getAuthenticatedUserId } from '@oxyhq/core/server';
import { getParam, parseBoundedLimit, parseOffset } from '../utils/reqParams';
import { CreateAlbumRequest, updateAlbumRequestSchema } from '@syra/shared-types';
import { findOwnedArtist } from '../utils/catalogOwnership';
import { getStoredImageColors } from '../utils/imageColors';
import { logger } from '../utils/logger';
import { withImageFirstSort } from '../utils/imageFirstSort';
import {
  getRequestUserId,
  playableTrackFilter,
} from '../utils/catalogVisibility';
import {
  countAlbumsWithPlayableTracks,
  findAlbumsWithPlayableTracks,
  findOneAlbumWithPlayableTracks,
} from '../utils/playableContainers';

/**
 * GET /api/albums
 * Get all albums
 */
export const getAlbums = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const limit = parseBoundedLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);

    const [albums, total] = await Promise.all([
      findAlbumsWithPlayableTracks({}, {
        sort: withImageFirstSort('album', { releaseDate: -1, createdAt: -1 }),
        offset,
        limit,
      }),
      countAlbumsWithPlayableTracks({}),
    ]);

    const formattedAlbums = formatAlbumsWithCoverArt(albums);

    res.json({
      albums: formattedAlbums,
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
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const id = getParam(req, 'id');
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Album not found' });
    }

    const album = await findOneAlbumWithPlayableTracks(id);

    if (!album) {
      return res.status(404).json({ error: 'Album not found' });
    }

    const formattedAlbum = formatAlbumWithCoverArt(album);
    res.json(formattedAlbum);
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
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const id = getParam(req, 'id');
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Album not found' });
    }
    
    // Verify album exists
    const album = await findOneAlbumWithPlayableTracks(id);
    if (!album) {
      return res.status(404).json({ error: 'Album not found' });
    }

    // Fetch tracks for this album, sorted by track number
    const tracks = await TrackModel.find(playableTrackFilter({ albumId: id }))
      .sort({ discNumber: 1, trackNumber: 1 })
      .lean();

    const formattedTracks = await formatTracksWithCoverArt(tracks);

    res.json({
      tracks: formattedTracks,
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
    if (!isDatabaseConnected()) {
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

    // Verify user owns the artist
    const artist = await ArtistModel.findOne({ 
      _id: data.artistId,
      ownerOxyUserId: userId 
    }).lean();

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

    // Validate coverArt - must be a valid MongoDB ObjectId string
    if (!data.coverArt) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        message: 'coverArt is required' 
      });
    }

    // Reject blob URLs, http/https URLs, or any other format
    if (data.coverArt.startsWith('blob:') || data.coverArt.startsWith('http://') || data.coverArt.startsWith('https://') || data.coverArt.startsWith('/api/')) {
      return res.status(400).json({ 
        error: 'Invalid coverArt', 
        message: 'coverArt must be a valid image ID (MongoDB ObjectId). Images must be uploaded first using /api/images/upload.' 
      });
    }

    // Validate ObjectId format (24 hex characters)
    if (!mongoose.Types.ObjectId.isValid(data.coverArt)) {
      return res.status(400).json({ 
        error: 'Invalid coverArt', 
        message: 'coverArt must be a valid MongoDB ObjectId string (24 hex characters). Images must be uploaded first using /api/images/upload.' 
      });
    }

    const colors = await getStoredImageColors(data.coverArt);

    // Create album
    const album = new AlbumModel({
      title: data.title,
      artistId: data.artistId,
      artistName: artist.name,
      releaseDate: data.releaseDate,
      coverArt: data.coverArt,
      genre: data.genre || [],
      type: data.type || 'album',
      label: data.label,
      copyright: data.copyright,
      isExplicit: data.isExplicit || false,
      totalTracks: 0,
      totalDuration: 0,
      primaryColor: colors?.primaryColor,
      secondaryColor: colors?.secondaryColor,
      popularity: 0,
    });

    await album.save();

    // Update artist stats
    await ArtistModel.updateOne(
      { _id: data.artistId },
      { $inc: { 'stats.albums': 1 } }
    );

    const formattedAlbum = formatAlbumWithCoverArt(album);
    res.status(201).json(formattedAlbum);
  } catch (error: unknown) {
    logger.error('[AlbumsController] Error creating album:', error);
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
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const albumId = getParam(req, 'id');

    if (!mongoose.Types.ObjectId.isValid(albumId)) {
      return res.status(400).json({ error: 'Invalid album id' });
    }

    const parsed = updateAlbumRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const album = await AlbumModel.findById(albumId);
    if (!album) {
      return res.status(404).json({ error: 'Album not found' });
    }

    // Ownership comes from the STORED album's artistId, never from the request body.
    if (!(await findOwnedArtist(album.artistId, userId))) {
      return res.status(403).json({ error: 'Forbidden', message: 'You do not own this album' });
    }

    const updates = parsed.data;

    // Explicit field-by-field assignment — the parsed object is never spread onto the doc.
    if (updates.title !== undefined) album.title = updates.title;
    if (updates.releaseDate !== undefined) album.releaseDate = updates.releaseDate;
    if (updates.coverArt !== undefined) album.coverArt = updates.coverArt;
    if (updates.genre !== undefined) album.genre = updates.genre;
    if (updates.type !== undefined) album.type = updates.type;
    if (updates.label !== undefined) album.label = updates.label;
    if (updates.copyright !== undefined) album.copyright = updates.copyright;

    await album.save();

    const formattedAlbum = formatAlbumWithCoverArt(album.toObject());
    res.json(formattedAlbum);
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
): Promise<IAlbum | null> => {
  const userId = getAuthenticatedUserId(req);
  const albumId = getParam(req, 'id');

  if (!mongoose.Types.ObjectId.isValid(albumId)) {
    res.status(400).json({ error: 'Invalid album id' });
    return null;
  }

  const album = await AlbumModel.findById(albumId);
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
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const album = await loadOwnedAlbumOrRespond(req, res);
    if (!album) return;

    album.isAvailable = false;
    await album.save();

    res.json(formatAlbumWithCoverArt(album.toObject()));
  } catch (error) {
    next(error);
  }
};

/** POST /api/albums/:id/publish — undo `unpublishAlbum`. */
export const publishAlbum = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const album = await loadOwnedAlbumOrRespond(req, res);
    if (!album) return;

    album.isAvailable = true;
    await album.save();

    res.json(formatAlbumWithCoverArt(album.toObject()));
  } catch (error) {
    next(error);
  }
};
