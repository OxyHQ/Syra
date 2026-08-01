import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { ArtistModel } from '../models/CatalogEntity';
import { AlbumModel } from '../models/Album';
import { TrackModel } from '../models/Track';
import { ArtistClaimModel, type IArtistClaim } from '../models/ArtistClaim';
import { ContributionAttestationModel } from '../models/ContributionAttestation';
import { CopyrightReportModel } from '../models/CopyrightReport';
import { takeDownTrack } from '../services/compliance/takedown';
import { mirrorCatalogImage } from '../services/catalog/catalogImageAssets';
import { logger } from '../utils/logger';
import { formatTracksWithCoverArt, formatAlbumWithCoverArt, formatArtistWithImage, formatArtistsWithImage } from '../utils/musicHelpers';
import { isDatabaseConnected } from '../utils/database';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId as getAuthenticatedUserId } from '@oxyhq/core/server';
import { getParam, parseBoundedLimit, parseOffset } from '../utils/reqParams';
import {
  CreateArtistRequest,
  ArtistInsights,
  ArtistDashboard,
  updateArtistRequestSchema,
  createArtistClaimRequestSchema,
  resolveArtistClaimRequestSchema,
  artistClaimStatusSchema,
  type ArtistClaim,
  type ArtistImageSuggestionsResponse,
} from '@syra/shared-types';
import { getStoredImageColors } from '../utils/imageColors';
import { withImageFirstSort } from '../utils/imageFirstSort';
import {
  getRequestUserId,
  playableTrackFilter,
} from '../utils/catalogVisibility';
import {
  countArtistsWithPlayableTracks,
  findAlbumsWithPlayableTracks,
  findArtistsWithPlayableTracks,
  findOneArtistWithPlayableTracks,
} from '../utils/playableContainers';

const ARTIST_ALBUMS_LIMIT = 100;
/** A claimant's own history — bounded, and far above the number anyone accumulates. */
const MAX_CLAIMS_PAGE = 50;

/**
 * GET /api/artists
 * Get all artists
 */
export const getArtists = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const limit = parseBoundedLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);

    const [artists, total] = await Promise.all([
      findArtistsWithPlayableTracks({}, {
        sort: withImageFirstSort('artist', { popularity: -1, 'stats.followers': -1 }),
        offset,
        limit,
      }),
      countArtistsWithPlayableTracks({}),
    ]);

    const formattedArtists = formatArtistsWithImage(artists);

    res.json({
      artists: formattedArtists,
      total,
      hasMore: offset + limit < total,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/artists/:id
 * Get artist by ID
 */
export const getArtistById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const id = getParam(req, 'id');
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const artist = await findOneArtistWithPlayableTracks(id);

    if (!artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const formattedArtist = formatArtistWithImage(artist);
    res.json(formattedArtist);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/artists/:id/albums
 * Get artist albums
 */
export const getArtistAlbums = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const id = getParam(req, 'id');
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Artist not found' });
    }
    
    // Verify artist exists
    const artist = await findOneArtistWithPlayableTracks(id);
    if (!artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    // Fetch albums for this artist, sorted by release date
    const albums = await findAlbumsWithPlayableTracks({ artistId: id }, {
      sort: withImageFirstSort('album', { releaseDate: -1 }),
      limit: ARTIST_ALBUMS_LIMIT,
    });

    const formattedAlbums = albums.map(album => formatAlbumWithCoverArt(album)).filter(Boolean);

    res.json({
      albums: formattedAlbums,
      artistId: id,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/artists/:id/tracks
 * Get artist tracks
 */
export const getArtistTracks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const id = getParam(req, 'id');
    const limit = parseBoundedLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Artist not found' });
    }
    
    // Verify artist exists
    const artist = await findOneArtistWithPlayableTracks(id);
    if (!artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    // Fetch tracks for this artist, sorted by popularity then date
    const [tracks, total] = await Promise.all([
      TrackModel.find(playableTrackFilter({ artistId: id }))
        .sort(withImageFirstSort('track', { popularity: -1, createdAt: -1 }))
        .skip(offset)
        .limit(limit)
        .lean(),
      TrackModel.countDocuments(playableTrackFilter({ artistId: id })),
    ]);

    const formattedTracks = await formatTracksWithCoverArt(tracks);

    res.json({
      tracks: formattedTracks,
      total,
      hasMore: offset + limit < total,
      artistId: id,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/artists/:id/follow
 * Follow artist (requires auth)
 */
export const followArtist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = getParam(req, 'id');
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Mock - just return success
    res.json({
      success: true,
      message: 'Artist followed',
      artistId: id,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/artists/:id/unfollow
 * Unfollow artist (requires auth)
 */
export const unfollowArtist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = getParam(req, 'id');
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Mock - just return success
    res.json({
      success: true,
      message: 'Artist unfollowed',
      artistId: id,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/artists/register
 * Register as an artist (create artist profile)
 */
export const registerAsArtist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const data: CreateArtistRequest = req.body;

    // Check if user already has an artist profile
    const existingArtist = await ArtistModel.findOne({ ownerOxyUserId: userId }).lean();
    if (existingArtist) {
      return res.status(400).json({ 
        error: 'Already registered',
        message: 'You already have an artist profile',
        artistId: existingArtist._id.toString(),
      });
    }

    // Check if artist name is already taken
    const nameExists = await ArtistModel.findOne({ name: data.name }).lean();
    if (nameExists) {
      return res.status(400).json({ 
        error: 'Name taken',
        message: 'This artist name is already taken',
      });
    }

    // Validate image if provided - must be a valid MongoDB ObjectId string
    let colors;
    if (data.image !== undefined && data.image !== null && data.image !== '') {
      // Reject blob URLs, http/https URLs, or any other format
      if (data.image.startsWith('blob:') || data.image.startsWith('http://') || data.image.startsWith('https://') || data.image.startsWith('/api/')) {
        return res.status(400).json({ 
          error: 'Invalid image', 
          message: 'image must be a valid image ID (MongoDB ObjectId). Images must be uploaded first using /api/images/upload.' 
        });
      }

      // Validate ObjectId format (24 hex characters)
      if (!mongoose.Types.ObjectId.isValid(data.image)) {
        return res.status(400).json({ 
          error: 'Invalid image', 
          message: 'image must be a valid MongoDB ObjectId string (24 hex characters). Images must be uploaded first using /api/images/upload.' 
        });
      }

      colors = await getStoredImageColors(data.image);
    }

    // Create artist profile
    const artist = new ArtistModel({
      name: data.name,
      bio: data.bio,
      image: data.image,
      genres: data.genres || [],
      verified: false, // Artists start unverified
      ownerOxyUserId: userId,
      primaryColor: colors?.primaryColor,
      secondaryColor: colors?.secondaryColor,
      stats: {
        followers: 0,
        albums: 0,
        tracks: 0,
        totalPlays: 0,
        monthlyListeners: 0,
      },
      source: 'upload',
    });

    await artist.save();

    const formattedArtist = formatArtistWithImage(artist);
    res.status(201).json(formattedArtist);
  } catch (error: unknown) {
    const mongoCode = error !== null && typeof error === 'object'
      ? (error as Record<string, unknown>)['code']
      : undefined;
    if (mongoCode === 11000) {
      // Duplicate key error
      return res.status(400).json({
        error: 'Name taken',
        message: 'This artist name is already taken',
      });
    }
    next(error);
  }
};

/**
 * GET /api/artists/me
 * Get current user's artist profile
 */
export const getMyArtistProfile = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);

    const artist = await ArtistModel.findOne({ ownerOxyUserId: userId }).lean();

    if (!artist) {
      return res.json(null);
    }

    const formattedArtist = formatArtistWithImage(artist);
    res.json(formattedArtist);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/artists/me/dashboard
 * Get artist dashboard data
 */
export const getArtistDashboard = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);

    // Get artist profile
    const artist = await ArtistModel.findOne({ ownerOxyUserId: userId }).lean();
    if (!artist) {
      return res.status(404).json({ 
        error: 'Not found',
        message: 'You do not have an artist profile',
      });
    }

    const artistId = artist._id.toString();

    // Get tracks and albums
    const [tracks, albums, copyrightRemovedTracks] = await Promise.all([
      TrackModel.find({ artistId }).sort({ createdAt: -1 }).limit(10).lean(),
      AlbumModel.find({ artistId }).sort({ createdAt: -1 }).limit(10).lean(),
      TrackModel.find({ artistId, copyrightRemoved: true })
        .sort({ removedAt: -1 })
        .limit(20)
        .lean(),
    ]);

    // Get counts
    const [totalTracks, totalAlbums] = await Promise.all([
      TrackModel.countDocuments({ artistId }),
      AlbumModel.countDocuments({ artistId }),
    ]);

    const totalPlays = tracks.reduce((sum, track) => sum + (track.playCount || 0), 0);

    const dashboard: ArtistDashboard = {
      artist: formatArtistWithImage(artist),
      totalTracks,
      totalAlbums,
      totalPlays,
      followers: artist.stats.followers || 0,
      strikeCount: artist.strikeCount || 0,
      uploadsDisabled: artist.uploadsDisabled || false,
      recentTracks: tracks.map(track => ({
        id: track._id.toString(),
        title: track.title,
        createdAt: track.createdAt?.toISOString() || new Date().toISOString(),
        playCount: track.playCount || 0,
      })),
      recentAlbums: albums.map(album => ({
        id: album._id.toString(),
        title: album.title,
        createdAt: album.createdAt?.toISOString() || new Date().toISOString(),
        totalTracks: album.totalTracks || 0,
      })),
      copyrightRemovedTracks: copyrightRemovedTracks.map(track => ({
        id: track._id.toString(),
        title: track.title,
        removedAt: track.removedAt?.toISOString() || new Date().toISOString(),
        removedReason: track.removedReason,
      })),
    };

    res.json(dashboard);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/artists/me/insights
 * Get artist insights/analytics
 */
export const getArtistInsights = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const period = (req.query.period as string) || 'alltime';

    // Get artist profile
    const artist = await ArtistModel.findOne({ ownerOxyUserId: userId }).lean();
    if (!artist) {
      return res.status(404).json({ 
        error: 'Not found',
        message: 'You do not have an artist profile',
      });
    }

    const artistId = artist._id.toString();

    // Get all tracks for this artist
    const allTracks = await TrackModel.find({ artistId }).lean();

    // Calculate total plays
    const totalPlays = allTracks.reduce((sum, track) => sum + (track.playCount || 0), 0);

    // Get top tracks by play count
    const topTracks = allTracks
      .map(track => ({
        trackId: track._id.toString(),
        title: track.title,
        playCount: track.playCount || 0,
      }))
      .sort((a, b) => b.playCount - a.playCount)
      .slice(0, 10);

    const insights: ArtistInsights = {
      totalPlays,
      monthlyListeners: artist.stats.monthlyListeners || 0,
      followers: artist.stats.followers || 0,
      topTracks,
      period: period as '7days' | '30days' | 'alltime',
    };

    res.json(insights);
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/artists/me
 * Edit the artist profile owned by the authenticated user. The profile is resolved by
 * `ownerOxyUserId` — there is no id in the path, so one creator cannot address another's
 * profile at all. The body is parsed, never spread, so ownership, strike state
 * (`uploadsDisabled`, `strikes`, `terminated`) and stats stay unreachable.
 */
export const updateMyArtistProfile = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);

    const parsed = updateArtistRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const artist = await ArtistModel.findOne({ ownerOxyUserId: userId });
    if (!artist) {
      return res.status(404).json({ error: 'Artist profile not found' });
    }

    const updates = parsed.data;

    // Explicit field-by-field assignment — the parsed object is never spread onto the doc.
    if (updates.name !== undefined) artist.name = updates.name;
    if (updates.bio !== undefined) artist.bio = updates.bio;
    if (updates.image !== undefined) artist.image = updates.image;
    if (updates.genres !== undefined) artist.genres = updates.genres;

    await artist.save();

    const formattedArtist = formatArtistWithImage(artist.toObject());
    res.json(formattedArtist);
  } catch (error) {
    next(error);
  }
};

// ── Artist claims ─────────────────────────────────────────────────────────────

/**
 * Claiming a contributed artist profile.
 *
 * The podcast twin of this flow (`claimPodcast`) grants on the spot, and that is
 * right there: a podcast is claimed against a feed its publisher controls, so
 * possession of the feed is the proof. An artist profile created from the tags of
 * a file a stranger uploaded has no such anchor — the name in an MP3 proves
 * nothing about who is asking. Granting on request would hand anyone the page of
 * any artist not yet on Syra, together with every recording other people have
 * contributed to it.
 *
 * So this path NEVER writes ownership. It records a pending {@link ArtistClaim}
 * and stops. Approval is a separate, reviewer-only decision, and approval is the
 * only thing that writes `ownerOxyUserId` / `claimedByOxyUserId` / `claimable`.
 */

type ArtistClaimRecord = Pick<
  IArtistClaim,
  'artistId' | 'oxyUserId' | 'evidence' | 'status' | 'resolvedAt' | 'resolvedBy' | 'resolutionNote'
> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

function serializeArtistClaim(claim: ArtistClaimRecord): ArtistClaim {
  return {
    id: claim._id.toString(),
    artistId: claim.artistId,
    oxyUserId: claim.oxyUserId,
    evidence: claim.evidence,
    status: claim.status,
    resolvedAt: claim.resolvedAt?.toISOString(),
    resolvedBy: claim.resolvedBy,
    resolutionNote: claim.resolutionNote,
    createdAt: claim.createdAt.toISOString(),
    updatedAt: claim.updatedAt.toISOString(),
  };
}

/**
 * POST /api/artists/:id/claim
 *
 * Only a claimable, unowned profile can be claimed. A claim on an artist somebody
 * already holds is REFUSED rather than queued: there is no decision left for a
 * reviewer to make, and a queue full of unanswerable requests is how the real
 * ones get missed.
 */
export const createArtistClaim = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const id = getParam(req, 'id');

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const parsed = createArtistClaimRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const artist = await ArtistModel.findById(id)
      .select('claimable ownerOxyUserId claimedByOxyUserId')
      .lean();
    if (!artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    if (artist.claimable !== true || artist.ownerOxyUserId || artist.claimedByOxyUserId) {
      return res.status(409).json({
        error: 'Not claimable',
        message: 'This artist profile already belongs to someone',
      });
    }

    /**
     * One artist profile per account, checked here and again at approval.
     *
     * `registerAsArtist` and `getMyArtistProfile` both resolve a creator's profile
     * with `findOne({ ownerOxyUserId })`, so a second owned profile would make
     * which one they see arbitrary. Refusing at submission is what lets the
     * claimant read a real reason instead of waiting for a review that could only
     * ever be rejected.
     */
    const existingProfile = await ArtistModel.findOne({ ownerOxyUserId: userId })
      .select('_id')
      .lean();
    if (existingProfile) {
      return res.status(409).json({
        error: 'Already an artist',
        message:
          'You already have an artist profile. Contact support to merge it with this one.',
        artistId: existingProfile._id.toString(),
      });
    }

    try {
      const claim = await ArtistClaimModel.create({
        artistId: id,
        oxyUserId: userId,
        evidence: parsed.data.evidence.trim(),
        status: 'pending',
      });

      logger.info(`[Artists] Artist claim ${claim._id.toString()} opened on ${id} by ${userId}`);
      return res.status(201).json({ claim: serializeArtistClaim(claim) });
    } catch (error: unknown) {
      // The partial unique index is the authority on "one OPEN claim per claimant
      // per artist": a read-then-write leaves exactly the window two taps land in.
      const mongoCode = error !== null && typeof error === 'object'
        ? (error as Record<string, unknown>)['code']
        : undefined;
      if (mongoCode === 11000) {
        return res.status(409).json({
          error: 'Claim pending',
          message: 'You already have a claim awaiting review on this artist',
        });
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
};

/** GET /api/artist-claims/mine — the claimant's own claims, newest first. */
export const listMyArtistClaims = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const claims = await ArtistClaimModel.find({ oxyUserId: userId })
      .sort({ createdAt: -1 })
      .limit(MAX_CLAIMS_PAGE)
      .lean();

    res.json({ claims: claims.map(serializeArtistClaim) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/artist-claims — the review queue (reviewers only), oldest first. */
export const listArtistClaims = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const statusFilter = artistClaimStatusSchema.safeParse(req.query.status ?? 'pending');
    if (!statusFilter.success) {
      return res.status(400).json({ error: 'Invalid status filter' });
    }
    const status = statusFilter.data;

    const limit = parseBoundedLimit(req.query.limit, 50);
    const offset = parseOffset(req.query.offset);

    const [claims, total] = await Promise.all([
      ArtistClaimModel.find({ status })
        .sort({ createdAt: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      ArtistClaimModel.countDocuments({ status }),
    ]);

    res.json({
      claims: claims.map(serializeArtistClaim),
      total,
      hasMore: offset + claims.length < total,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/artist-claims/:id/resolve — a reviewer approves or rejects (reviewers only).
 *
 * Approval is the ONLY place ownership of a contributed profile is written, and it
 * is written with a conditional update rather than a read-then-save: two reviewers
 * working the queue at the same time must not both hand out the same profile. The
 * filter is the precondition, so the loser sees `modifiedCount: 0` and is told the
 * artist was taken.
 */
export const resolveArtistClaim = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const reviewerId = getAuthenticatedUserId(req);
    const id = getParam(req, 'id');

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Claim not found' });
    }

    const parsed = resolveArtistClaimRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const claim = await ArtistClaimModel.findById(id);
    if (!claim) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    if (claim.status !== 'pending') {
      return res.status(409).json({
        error: 'Already resolved',
        message: `This claim was already ${claim.status}`,
      });
    }

    if (parsed.data.status === 'approved') {
      const conflictingProfile = await ArtistModel.findOne({ ownerOxyUserId: claim.oxyUserId })
        .select('_id')
        .lean();
      if (conflictingProfile) {
        return res.status(409).json({
          error: 'Claimant already an artist',
          message:
            'The claimant registered an artist profile after opening this claim; ' +
            'approving would give them two.',
          artistId: conflictingProfile._id.toString(),
        });
      }

      // Equality to null matches a missing field as well as an explicit null, so
      // this is the precondition "nobody holds this profile" in one filter.
      const granted = await ArtistModel.updateOne(
        {
          _id: claim.artistId,
          claimable: true,
          ownerOxyUserId: null,
          claimedByOxyUserId: null,
        },
        {
          $set: {
            ownerOxyUserId: claim.oxyUserId,
            claimedByOxyUserId: claim.oxyUserId,
            claimable: false,
          },
        },
      );

      if (granted.modifiedCount !== 1) {
        return res.status(409).json({
          error: 'Not claimable',
          message: 'This artist profile already belongs to someone',
        });
      }
    }

    claim.status = parsed.data.status;
    claim.resolvedAt = new Date();
    claim.resolvedBy = reviewerId;
    if (parsed.data.resolutionNote !== undefined) claim.resolutionNote = parsed.data.resolutionNote;
    await claim.save();

    /**
     * Every other open claim on a granted profile is now unanswerable — the
     * artist has an owner, so no reviewer can approve them. Closing them here
     * keeps the queue truthful and, because the open-claim index is partial on
     * `status: 'pending'`, frees the slot so a rejected claimant can appeal later.
     */
    if (parsed.data.status === 'approved') {
      await ArtistClaimModel.updateMany(
        { artistId: claim.artistId, status: 'pending', _id: { $ne: claim._id } },
        {
          $set: {
            status: 'rejected',
            resolvedAt: new Date(),
            resolvedBy: reviewerId,
            resolutionNote: 'Another claim on this artist profile was approved',
          },
        },
      );
    }

    logger.info(
      `[Artists] Claim ${id} ${parsed.data.status} by ${reviewerId} (artist ${claim.artistId})`,
    );

    res.json({ claim: serializeArtistClaim(claim) });
  } catch (error) {
    next(error);
  }
};

// ── Contributions to a claimed profile ────────────────────────────────────────

/**
 * What an artist may do about a recording somebody else published onto their
 * profile.
 *
 * `keep` re-publishes (it is the undo for `unpublish`); `unpublish` hides the
 * track while leaving it intact; `takedown` is the copyright path and is
 * irreversible — it removes the work, purges it from every private locker holding
 * the same bytes, and strikes whoever uploaded it.
 */
const contributionActionSchema = z.object({
  action: z.enum(['keep', 'unpublish', 'takedown']),
  reason: z.string().max(2000).optional(),
});

const contributionSettingsSchema = z.object({
  acceptsContributions: z.boolean(),
});

interface ContributedTrackRow {
  _id: mongoose.Types.ObjectId;
  title: string;
  albumName?: string;
  duration: number;
  coverArt?: string;
  isAvailable?: boolean;
  copyrightRemoved?: boolean;
  removedAt?: Date;
  removedReason?: string;
  createdAt?: Date;
  attestation: { uploaderOxyUserId: string; acceptedAt: Date }[];
}

/**
 * The stages that select "tracks on this artist that somebody else contributed".
 *
 * A `ContributionAttestation` is what makes a track a contribution — it is
 * written when a publication is made by an account that is not the artist, and
 * nothing else records that fact. The `$lookup` converts on the LOCAL side
 * (`$toString: '$_id'`) and leaves the foreign `trackId` a bare path so the
 * attestation's unique index on it serves the join; the leading `$match` is a bare
 * indexed field, so the lookup only ever runs over one artist's own tracks.
 */
function contributedTrackStages(artistId: string): mongoose.PipelineStage[] {
  return [
    { $match: { artistId } },
    {
      $lookup: {
        from: ContributionAttestationModel.collection.name,
        let: { tid: { $toString: '$_id' } },
        pipeline: [
          { $match: { $expr: { $eq: ['$trackId', '$$tid'] } } },
          { $project: { _id: 0, uploaderOxyUserId: 1, acceptedAt: 1 } },
        ],
        as: 'attestation',
      },
    },
    { $match: { 'attestation.0': { $exists: true } } },
  ];
}

/** GET /api/artists/me/contributions — recordings other people published onto my profile. */
export const getMyContributions = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const artist = await ArtistModel.findOne({ ownerOxyUserId: userId }).select('_id').lean();
    if (!artist) {
      return res.status(404).json({ error: 'Artist profile not found' });
    }

    const limit = parseBoundedLimit(req.query.limit, 50);
    const offset = parseOffset(req.query.offset);
    const stages = contributedTrackStages(artist._id.toString());

    const [rows, counted] = await Promise.all([
      TrackModel.aggregate<ContributedTrackRow>([
        ...stages,
        { $sort: { createdAt: -1 } },
        { $skip: offset },
        { $limit: limit },
      ]),
      TrackModel.aggregate<{ total: number }>([...stages, { $count: 'total' }]),
    ]);

    const total = counted[0]?.total ?? 0;

    res.json({
      contributions: rows.map((row) => ({
        trackId: row._id.toString(),
        title: row.title,
        albumName: row.albumName,
        duration: row.duration,
        coverArt: row.coverArt,
        isAvailable: row.isAvailable !== false,
        copyrightRemoved: row.copyrightRemoved === true,
        removedAt: row.removedAt?.toISOString(),
        removedReason: row.removedReason,
        createdAt: row.createdAt?.toISOString(),
        uploaderOxyUserId: row.attestation[0]?.uploaderOxyUserId,
        attestedAt: row.attestation[0]?.acceptedAt?.toISOString(),
      })),
      total,
      hasMore: offset + rows.length < total,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/artists/me/contributions/:trackId — keep, unpublish, or take down.
 *
 * Scoped to the caller's OWN profile, resolved by `ownerOxyUserId` rather than
 * from the path, and to tracks that actually carry an attestation: this endpoint
 * answers "what happens to what other people put on my page", and the creator's
 * own catalog is edited through the track routes.
 */
export const resolveMyContribution = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const trackId = getParam(req, 'trackId');

    if (!mongoose.Types.ObjectId.isValid(trackId)) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const parsed = contributionActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const artist = await ArtistModel.findOne({ ownerOxyUserId: userId }).select('_id name').lean();
    if (!artist) {
      return res.status(404).json({ error: 'Artist profile not found' });
    }

    const track = await TrackModel.findOne({ _id: trackId, artistId: artist._id.toString() });
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const attestation = await ContributionAttestationModel.findOne({ trackId })
      .select('uploaderOxyUserId')
      .lean();
    if (!attestation) {
      return res.status(404).json({
        error: 'Not a contribution',
        message: 'This track was published by you, not contributed by someone else',
      });
    }

    /**
     * A copyright takedown is terminal for every action here.
     *
     * `keep` must not republish it — a takedown is not creator-reversible, the
     * same rule the track routes enforce. And `takedown` must not repeat: a second
     * one would file a second report and, without the service's own guard, count a
     * second strike for one work.
     */
    if (track.copyrightRemoved === true) {
      return res.status(409).json({
        error: 'Track removed',
        message: 'This track was already removed for copyright',
      });
    }

    if (parsed.data.action === 'takedown') {
      /**
       * The record first, then the removal.
       *
       * A takedown with no report row behind it is an unexplained disappearance:
       * the uploader is struck, the work is gone from every locker, and nothing
       * says who asked or why. The claim was reviewed by a human, so the profile
       * owner IS the rightsholder here and the report is stored already resolved.
       */
      const report = await CopyrightReportModel.create({
        trackId,
        artistId: artist._id.toString(),
        reporterOxyUserId: userId,
        reason: parsed.data.reason?.trim() ||
          `Takedown requested by the owner of the artist profile "${artist.name}"`,
        status: 'approved',
        resolvedAt: new Date(),
        resolvedBy: userId,
      });

      const takedown = await takeDownTrack({
        trackId,
        reason: report.reason,
        actorOxyUserId: userId,
        copyrightReportId: report._id.toString(),
      });

      if (!takedown) {
        // The track went between the ownership check and the takedown. Nothing was
        // removed, so the report describes a decision that never happened — leaving
        // it would be a resolved takedown with no takedown behind it.
        await CopyrightReportModel.deleteOne({ _id: report._id });
        return res.status(404).json({ error: 'Track not found' });
      }

      return res.json({ action: 'takedown', trackId, takedown });
    }

    track.isAvailable = parsed.data.action === 'keep';
    await track.save();

    res.json({ action: parsed.data.action, trackId, isAvailable: track.isAvailable });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/artists/me/contribution-settings — open or close the profile to
 * contributions from other people.
 *
 * A separate endpoint rather than a field on `PATCH /me`, because it is not a
 * descriptive profile field: it is the one switch that decides whether a stranger
 * may attach a recording to this artist's page, and only the artist can flip it.
 */
export const updateMyContributionSettings = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);

    const parsed = contributionSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const artist = await ArtistModel.findOne({ ownerOxyUserId: userId });
    if (!artist) {
      return res.status(404).json({ error: 'Artist profile not found' });
    }

    artist.acceptsContributions = parsed.data.acceptsContributions;
    await artist.save();

    res.json({ acceptsContributions: artist.acceptsContributions });
  } catch (error) {
    next(error);
  }
};

// ── Suggested profile photos ──────────────────────────────────────────────────

/**
 * Candidate profile photos, offered to the artist and to nobody else.
 *
 * A suggestion is a GUESS about what somebody looks like — pulled from the
 * artwork embedded in a stranger's uploaded file, or matched from Commons by
 * name. Publishing a guess attaches a face to a real person's name on every
 * surface in the product, so a suggestion is never rendered anywhere until the
 * artist has said yes.
 *
 * Two independent mechanisms already make that structural, and these handlers
 * are written to work WITH them rather than around them: the Mongoose path is
 * `select: false`, so a serializer cannot spread a field the query never
 * fetched, and `artistSchema` has no name for it, so it cannot be emitted
 * deliberately either. Reading suggestions therefore takes an explicit
 * `+imageSuggestions`, and the response is typed as
 * `ArtistImageSuggestionsResponse` — its own contract, reachable only from an
 * endpoint scoped to the caller's own profile.
 */

const imageSuggestionActionSchema = z.object({
  /**
   * Which suggestion, by the image's source URL.
   *
   * The sub-document is `_id: false`, so there is no generated id to address —
   * and the URL is the better key anyway: it is what the artist is actually
   * accepting, and it survives the array being reordered or re-proposed between
   * the read and the decision. An index would not.
   */
  url: z.string().min(1),
});

/** GET /api/artists/me/image-suggestions — the artist's own pending photo suggestions. */
export const getMyImageSuggestions = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const artist = await ArtistModel.findOne({ ownerOxyUserId: userId })
      .select('+imageSuggestions')
      .lean();
    if (!artist) {
      return res.status(404).json({ error: 'Artist profile not found' });
    }

    const response: ArtistImageSuggestionsResponse = {
      suggestions: (artist.imageSuggestions ?? []).map((suggestion) => ({
        image: suggestion.image,
        proposedAt: suggestion.proposedAt.toISOString(),
        proposedByOxyUserId: suggestion.proposedByOxyUserId,
        sourceUploadId: suggestion.sourceUploadId,
      })),
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/artists/me/image-suggestions/accept — adopt one as the profile photo.
 *
 * An external image is MIRRORED into Syra's own storage rather than hot-linked,
 * through the same chokepoint the rest of the catalogue uses, so the profile does
 * not depend on Commons staying up and the stored bytes are ours to serve.
 *
 * The licence travels with it. A Commons image is reusable only while its author
 * and licence are shown, so `imageLicence` is written in the same save — an
 * accepted image whose attribution was dropped on the way in is a licence breach
 * that no later read can detect.
 *
 * Every suggestion is cleared on acceptance, including the ones not chosen: the
 * question has been answered, and leaving the rest pending would ask it again.
 */
export const acceptMyImageSuggestion = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const parsed = imageSuggestionActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const artist = await ArtistModel.findOne({ ownerOxyUserId: userId }).select('+imageSuggestions');
    if (!artist) {
      return res.status(404).json({ error: 'Artist profile not found' });
    }

    const suggestion = (artist.imageSuggestions ?? [])
      .find((candidate) => candidate.image.url === parsed.data.url);
    if (!suggestion) {
      return res.status(404).json({
        error: 'Suggestion not found',
        message: 'That photo is no longer among the suggestions for your profile',
      });
    }

    /**
     * `AttributableImage` is a union on `origin`, and only the `external` arm
     * carries a provider and a licence. Narrowing to that arm — rather than
     * reaching for optional fields — is what keeps "an external image without its
     * licence" unrepresentable, which is the property the type was built for.
     */
    const externalImage = suggestion.image.origin === 'external' ? suggestion.image : undefined;

    const mirrored = await mirrorCatalogImage(
      [{ url: suggestion.image.url, width: suggestion.image.width, height: suggestion.image.height }],
      {
        // Syra's own provenance vocabulary, not the image-provider enum: an
        // externally sourced photo is `cc`, one lifted from an uploaded file is
        // `upload`.
        provider: externalImage ? 'cc' : 'upload',
        entityType: 'artist',
        externalId: artist._id.toString(),
        existingImageId: artist.image,
        existingImageSizes: artist.imageSizes,
      },
    );

    if (!mirrored) {
      return res.status(502).json({
        error: 'Image unavailable',
        message: 'That photo could not be fetched. It may have been removed at the source.',
      });
    }

    artist.image = mirrored.imageId;
    artist.imageSizes = mirrored.imageSizes;
    if (mirrored.primaryColor) artist.primaryColor = mirrored.primaryColor;
    if (mirrored.secondaryColor) artist.secondaryColor = mirrored.secondaryColor;
    /**
     * Attribution travels with the bytes, or the image may not be used at all.
     * Cleared for an upload-origin photo rather than left alone: a stale licence
     * describing the PREVIOUS image would credit the wrong author for the one now
     * on display, which is worse than no credit.
     */
    artist.imageLicence = externalImage?.licence;
    artist.imageSuggestions = [];
    await artist.save();

    logger.info(
      `[Artists] Artist ${artist._id.toString()} accepted a suggested profile photo ` +
      `(${externalImage ? `external/${externalImage.provider}` : 'upload'})`,
    );

    res.json(formatArtistWithImage(artist.toObject()));
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/artists/me/image-suggestions/discard — refuse one suggestion.
 *
 * Refusing is a first-class outcome, not the absence of accepting: "that is not
 * me" is the answer a misattributed photo needs, and it has to be recordable
 * without adopting one of the alternatives.
 */
export const discardMyImageSuggestion = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const parsed = imageSuggestionActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const artist = await ArtistModel.findOne({ ownerOxyUserId: userId }).select('+imageSuggestions');
    if (!artist) {
      return res.status(404).json({ error: 'Artist profile not found' });
    }

    const remaining = (artist.imageSuggestions ?? [])
      .filter((candidate) => candidate.image.url !== parsed.data.url);
    if (remaining.length === (artist.imageSuggestions ?? []).length) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    artist.imageSuggestions = remaining;
    await artist.save();

    const response: ArtistImageSuggestionsResponse = {
      suggestions: remaining.map((suggestion) => ({
        image: suggestion.image,
        proposedAt: suggestion.proposedAt.toISOString(),
        proposedByOxyUserId: suggestion.proposedByOxyUserId,
        sourceUploadId: suggestion.sourceUploadId,
      })),
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
};
