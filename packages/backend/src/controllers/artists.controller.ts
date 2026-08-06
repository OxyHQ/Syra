import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { isLiveEntityId, sqlStateOf } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import { z } from 'zod';
import { getDb } from '../db/postgres';
import { albums, catalogEntities, tracks } from '../db/schema/catalog';
import { copyrightReports } from '../db/schema/creators';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import { playableTrackFilter } from '../db/catalog/visibility';
import {
  countArtistsWithPlayableTracks,
  findAlbumsWithPlayableTracks,
  findArtistsWithPlayableTracks,
  findOneArtistWithPlayableTracks,
  imageFirst,
  descNullsLast,
} from '../db/catalog/containers';
import { loadImageVariants, toAlbumDtos, toTrackDtos } from '../db/catalog/hydrate';
import { normalizeImageRef, toArtistDto, type PublicCatalogEntityRow } from '../db/catalog/serialize';
import { ArtistClaimModel, type IArtistClaim } from '../models/ArtistClaim';
import { ContributionAttestationModel } from '../models/ContributionAttestation';
import { takeDownTrack } from '../services/compliance/takedown';
import { mirrorCatalogImage } from '../services/catalog/catalogImageAssets';
import { logger } from '../utils/logger';
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
  normalizeNameKey,
} from '@syra/shared-types';
import { getStoredImageColors } from '../utils/imageColors';
import { getRequestUserId } from '../utils/requestUser';

const ARTIST_ALBUMS_LIMIT = 100;
/** A claimant's own history — bounded, and far above the number anyone accumulates. */
const MAX_CLAIMS_PAGE = 50;

/** The ordering every artist listing uses: has-a-photo, then popularity, then reach. */
const ARTIST_LISTING_ORDER = [
  imageFirst(catalogEntities.imageId),
  descNullsLast(catalogEntities.popularity),
  descNullsLast(catalogEntities.statsFollowers),
];

/** Serialize one entity row, loading only the image assets it references. */
async function toArtistResponse(row: PublicCatalogEntityRow) {
  const lookup = await loadImageVariants([
    row.imageId,
    row.imageSizesSmallId,
    row.imageSizesMediumId,
    row.imageSizesLargeId,
    row.imageSizesXlargeId,
    row.imageSizesXxlargeId,
    row.imageSizesOriginalId,
  ]);
  return toArtistDto(row, lookup);
}

/** Serialize a page of artists — ONE `image_assets` query for the whole page. */
async function toArtistResponses(rows: readonly PublicCatalogEntityRow[]) {
  const lookup = await loadImageVariants(
    rows.flatMap((row) => [
      row.imageId,
      row.imageSizesSmallId,
      row.imageSizesMediumId,
      row.imageSizesLargeId,
      row.imageSizesXlargeId,
      row.imageSizesXxlargeId,
      row.imageSizesOriginalId,
    ])
  );
  return rows.map((row) => toArtistDto(row, lookup));
}

/**
 * The owner's own suggestions, read through a projection that NAMES the
 * protected column.
 *
 * `imageSuggestions` is in `PROTECTED_COLUMNS_BY_TABLE`, so `publicColumns()`
 * removes it from every catalog read and {@link PublicCatalogEntityRow} has no
 * property for it — a serializer naming it stops compiling. That protection is
 * against it reaching a CLIENT through a catalog surface; the artist reading
 * their own pending photos is exactly who it is for, so this asks for it
 * explicitly rather than widening anything.
 */
async function findOwnArtistWithSuggestions(ownerOxyUserId: string) {
  const [row] = await getDb()
    .select({
      id: catalogEntities.id,
      imageId: catalogEntities.imageId,
      imageSizesSmallId: catalogEntities.imageSizesSmallId,
      imageSizesMediumId: catalogEntities.imageSizesMediumId,
      imageSizesLargeId: catalogEntities.imageSizesLargeId,
      imageSizesXlargeId: catalogEntities.imageSizesXlargeId,
      imageSizesXxlargeId: catalogEntities.imageSizesXxlargeId,
      imageSizesOriginalId: catalogEntities.imageSizesOriginalId,
      imageSuggestions: catalogEntities.imageSuggestions,
    })
    .from(catalogEntities)
    .where(
      and(eq(catalogEntities.type, 'artist'), eq(catalogEntities.ownerOxyUserId, ownerOxyUserId))
    )
    .limit(1);

  return row;
}

/** The signed-in user's own artist row, or `undefined`. */
async function findOwnedArtistRow(
  ownerOxyUserId: string
): Promise<PublicCatalogEntityRow | undefined> {
  const [row] = await getDb()
    .select(publicColumns(catalogEntities, PROTECTED_COLUMNS_BY_TABLE))
    .from(catalogEntities)
    .where(
      and(eq(catalogEntities.type, 'artist'), eq(catalogEntities.ownerOxyUserId, ownerOxyUserId))
    )
    .limit(1);

  return row;
}

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
      findArtistsWithPlayableTracks(undefined, {
        orderBy: ARTIST_LISTING_ORDER,
        offset,
        limit,
      }),
      countArtistsWithPlayableTracks(),
    ]);

    const formattedArtists = await toArtistResponses(artists);

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
    
    if (!isLiveEntityId(id)) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const artist = await findOneArtistWithPlayableTracks(id);

    if (!artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    res.json(await toArtistResponse(artist));
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
    
    if (!isLiveEntityId(id)) {
      return res.status(404).json({ error: 'Artist not found' });
    }
    
    // Verify artist exists
    const artist = await findOneArtistWithPlayableTracks(id);
    if (!artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    // Fetch albums for this artist, sorted by release date
    const albumRows = await findAlbumsWithPlayableTracks(eq(albums.artistId, id), {
      orderBy: [imageFirst(albums.coverArtId), descNullsLast(albums.releaseDate)],
      limit: ARTIST_ALBUMS_LIMIT,
    });

    const formattedAlbums = await toAlbumDtos(albumRows);

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
    
    if (!isLiveEntityId(id)) {
      return res.status(404).json({ error: 'Artist not found' });
    }
    
    // Verify artist exists
    const artist = await findOneArtistWithPlayableTracks(id);
    if (!artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    // Fetch tracks for this artist, sorted by popularity then date
    const artistTracksWhere = and(playableTrackFilter(), eq(tracks.artistId, id));
    const [trackRows, counted] = await Promise.all([
      getDb()
        .select(publicColumns(tracks, PROTECTED_COLUMNS_BY_TABLE))
        .from(tracks)
        .where(artistTracksWhere)
        .orderBy(imageFirst(tracks.coverArtId), descNullsLast(tracks.popularity), descNullsLast(tracks.createdAt))
        .offset(offset)
        .limit(limit),
      getDb().select({ total: count() }).from(tracks).where(artistTracksWhere),
    ]);

    const total = counted[0]?.total ?? 0;
    const formattedTracks = await toTrackDtos(trackRows);

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
    const existingArtist = await findOwnedArtistRow(userId);
    if (existingArtist) {
      return res.status(400).json({ 
        error: 'Already registered',
        message: 'You already have an artist profile',
        artistId: existingArtist.id,
      });
    }

    // Check if artist name is already taken. `type = 'artist'` is stated: one
    // table holds artists and persons now, and a person may share a name.
    const [nameExists] = await getDb()
      .select({ id: catalogEntities.id })
      .from(catalogEntities)
      .where(and(eq(catalogEntities.type, 'artist'), eq(catalogEntities.name, data.name)))
      .limit(1);
    if (nameExists) {
      return res.status(400).json({ 
        error: 'Name taken',
        message: 'This artist name is already taken',
      });
    }

    // Validate image if provided — must be an id of an already-uploaded asset.
    let colors;
    if (data.image !== undefined && data.image !== null && data.image !== '') {
      // Reject blob URLs, http/https URLs, or any other format
      if (data.image.startsWith('blob:') || data.image.startsWith('http://') || data.image.startsWith('https://') || data.image.startsWith('/api/')) {
        return res.status(400).json({ 
          error: 'Invalid image', 
          message: 'image must be a valid image ID. Images must be uploaded first using /api/images/upload.' 
        });
      }

      /**
       * Both live id shapes, not just the 24-hex one.
       *
       * `image_assets.id` is `generatedId()` — a uuid v7 — so a check for an
       * ObjectId would reject every image uploaded after the cutover while the
       * upload endpoint that minted it succeeded. The message said "MongoDB
       * ObjectId (24 hex characters)" and is corrected with the check.
       */
      if (!isLiveEntityId(data.image)) {
        return res.status(400).json({ 
          error: 'Invalid image', 
          message: 'image must be a valid image ID. Images must be uploaded first using /api/images/upload.' 
        });
      }

      colors = await getStoredImageColors(data.image);
    }

    // Create artist profile
    const [created] = await getDb()
      .insert(catalogEntities)
      .values({
        type: 'artist',
        name: data.name,
        /**
         * DERIVED, not supplied — `models/CatalogEntity.ts` computed it in a
         * pre-save hook, and Postgres has no hook. Omitting it leaves the
         * artist unreachable from `loadCreditedOn`, which matches
         * `track_credits.name_key` against exactly this value.
         */
        nameKey: normalizeNameKey(data.name),
        bio: data.bio,
        imageId: data.image,
        genres: data.genres || [],
        verified: false, // Artists start unverified
        ownerOxyUserId: userId,
        primaryColor: colors?.primaryColor,
        secondaryColor: colors?.secondaryColor,
        statsFollowers: 0,
        statsAlbums: 0,
        statsTracks: 0,
        statsTotalPlays: 0,
        statsMonthlyListeners: 0,
        source: 'upload',
      })
      .returning(publicColumns(catalogEntities, PROTECTED_COLUMNS_BY_TABLE));

    if (!created) {
      return res.status(500).json({ error: 'Failed to create artist profile' });
    }

    res.status(201).json(await toArtistResponse(created));
  } catch (error: unknown) {
    /**
     * `23505` is Postgres's `unique_violation`, the replacement for Mongo's
     * duplicate-key `11000`. It still has to be caught: the name check above is
     * a read followed by a write, so two simultaneous registrations both pass it
     * and the unique index is what actually decides.
     */
    if (sqlStateOf(error) === '23505') {
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

    const artist = await findOwnedArtistRow(userId);

    if (!artist) {
      return res.json(null);
    }

    res.json(await toArtistResponse(artist));
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
    const artist = await findOwnedArtistRow(userId);
    if (!artist) {
      return res.status(404).json({ 
        error: 'Not found',
        message: 'You do not have an artist profile',
      });
    }

    const artistId = artist.id;
    const db = getDb();

    /**
     * The dashboard is the artist's OWN view of their catalogue, so none of
     * these compose `playableTrackFilter()` — a taken-down track has to appear
     * here, and the third query exists to list exactly those.
     */
    const [recentTracks, recentAlbums, copyrightRemovedTracks, trackCount, albumCount] =
      await Promise.all([
        db
          .select({
            id: tracks.id, title: tracks.title, createdAt: tracks.createdAt,
            playCount: tracks.playCount,
          })
          .from(tracks)
          .where(eq(tracks.artistId, artistId))
          .orderBy(descNullsLast(tracks.createdAt))
          .limit(10),
        db
          .select({
            id: albums.id, title: albums.title, createdAt: albums.createdAt,
            totalTracks: albums.totalTracks,
          })
          .from(albums)
          .where(eq(albums.artistId, artistId))
          .orderBy(descNullsLast(albums.createdAt))
          .limit(10),
        db
          .select({
            id: tracks.id, title: tracks.title, removedAt: tracks.removedAt,
            removedReason: tracks.removedReason,
          })
          .from(tracks)
          .where(and(eq(tracks.artistId, artistId), eq(tracks.copyrightRemoved, true)))
          .orderBy(descNullsLast(tracks.removedAt))
          .limit(20),
        db.select({ total: count() }).from(tracks).where(eq(tracks.artistId, artistId)),
        db.select({ total: count() }).from(albums).where(eq(albums.artistId, artistId)),
      ]);

    /**
     * Summed over the ten most recent tracks, which is what the Mongo version
     * did too — `tracks` there was the same `.limit(10)` list. Preserved rather
     * than corrected to a real total: changing what a dashboard number MEANS is
     * not a port, and doing it silently inside one would be worse.
     */
    const totalPlays = recentTracks.reduce((sum, track) => sum + (track.playCount || 0), 0);

    const dashboard: ArtistDashboard = {
      artist: await toArtistResponse(artist),
      totalTracks: trackCount[0]?.total ?? 0,
      totalAlbums: albumCount[0]?.total ?? 0,
      totalPlays,
      followers: artist.statsFollowers || 0,
      strikeCount: artist.strikeCount || 0,
      uploadsDisabled: artist.uploadsDisabled || false,
      recentTracks: recentTracks.map(track => ({
        id: track.id,
        title: track.title,
        createdAt: track.createdAt.toISOString(),
        playCount: track.playCount || 0,
      })),
      recentAlbums: recentAlbums.map(album => ({
        id: album.id,
        title: album.title,
        createdAt: album.createdAt.toISOString(),
        totalTracks: album.totalTracks || 0,
      })),
      copyrightRemovedTracks: copyrightRemovedTracks.map(track => ({
        id: track.id,
        title: track.title,
        removedAt: track.removedAt?.toISOString() || new Date().toISOString(),
        removedReason: track.removedReason ?? undefined,
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
    const artist = await findOwnedArtistRow(userId);
    if (!artist) {
      return res.status(404).json({ 
        error: 'Not found',
        message: 'You do not have an artist profile',
      });
    }

    const artistId = artist.id;

    /**
     * Two queries instead of loading every track into memory.
     *
     * The Mongo version read the artist's ENTIRE catalogue with `.lean()`, summed
     * `playCount` in JS and sorted the whole array to take ten. Both answers are
     * available from the database: the sum is an aggregate and the top ten is an
     * `ORDER BY … LIMIT 10` the `tracks_artist_id_idx` can serve. Same numbers,
     * bounded memory.
     */
    const [summed, topTrackRows] = await Promise.all([
      getDb()
        .select({ totalPlays: sql<number>`coalesce(sum(${tracks.playCount}), 0)::int` })
        .from(tracks)
        .where(eq(tracks.artistId, artistId)),
      getDb()
        .select({ id: tracks.id, title: tracks.title, playCount: tracks.playCount })
        .from(tracks)
        .where(eq(tracks.artistId, artistId))
        .orderBy(descNullsLast(tracks.playCount))
        .limit(10),
    ]);

    const insights: ArtistInsights = {
      totalPlays: summed[0]?.totalPlays ?? 0,
      monthlyListeners: artist.statsMonthlyListeners || 0,
      followers: artist.statsFollowers || 0,
      topTracks: topTrackRows.map((track) => ({
        trackId: track.id,
        title: track.title,
        playCount: track.playCount || 0,
      })),
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

    const artist = await findOwnedArtistRow(userId);
    if (!artist) {
      return res.status(404).json({ error: 'Artist profile not found' });
    }

    const updates = parsed.data;

    /**
     * An explicit set object, built key by key — the parsed body is never
     * spread. `name` carries `nameKey` with it, because the two are one fact and
     * Mongoose's pre-save hook used to keep them together; leaving `nameKey`
     * behind would silently strand every credit that matches on it.
     */
    const set: Partial<typeof catalogEntities.$inferInsert> = {};
    if (updates.name !== undefined) {
      set.name = updates.name;
      set.nameKey = normalizeNameKey(updates.name);
    }
    if (updates.bio !== undefined) set.bio = updates.bio;
    if (updates.image !== undefined) set.imageId = updates.image;
    if (updates.genres !== undefined) set.genres = updates.genres;

    const [updated] = Object.keys(set).length
      ? await getDb()
          .update(catalogEntities)
          .set(set)
          .where(eq(catalogEntities.id, artist.id))
          .returning(publicColumns(catalogEntities, PROTECTED_COLUMNS_BY_TABLE))
      : [artist];

    if (!updated) {
      return res.status(404).json({ error: 'Artist profile not found' });
    }

    res.json(await toArtistResponse(updated));
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

    if (!isLiveEntityId(id)) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const parsed = createArtistClaimRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const [artist] = await getDb()
      .select({
        claimable: catalogEntities.claimable,
        ownerOxyUserId: catalogEntities.ownerOxyUserId,
        claimedByOxyUserId: catalogEntities.claimedByOxyUserId,
      })
      .from(catalogEntities)
      .where(and(eq(catalogEntities.type, 'artist'), eq(catalogEntities.id, id)))
      .limit(1);
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
    const existingProfile = await findOwnedArtistRow(userId);
    if (existingProfile) {
      return res.status(409).json({
        error: 'Already an artist',
        message:
          'You already have an artist profile. Contact support to merge it with this one.',
        artistId: existingProfile.id,
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

    /**
     * `ObjectId.isValid`, and DELIBERATELY not `isLiveEntityId` — this `id` is a
     * CLAIM id, and `artist_claims` is Task 13's table, still Mongoose. The same
     * controller now validates two id spaces, so the right guard is decided by
     * which store the id addresses, not by the file it appears in. The sibling
     * guard in `createArtistClaim` reads an ARTIST id and had to change; this one
     * changes when Task 13 ports the claims.
     */
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
      const conflictingProfile = await findOwnedArtistRow(claim.oxyUserId);
      if (conflictingProfile) {
        return res.status(409).json({
          error: 'Claimant already an artist',
          message:
            'The claimant registered an artist profile after opening this claim; ' +
            'approving would give them two.',
          artistId: conflictingProfile.id,
        });
      }

      /**
       * The precondition "nobody holds this profile" stays IN the `WHERE`, which
       * is what makes the grant atomic against a concurrent claim.
       *
       * `isNull` rather than `eq(column, null)`: in SQL `x = null` is never true,
       * so the Mongo spelling — where equality to null also matched a MISSING
       * field — would translate to a filter that matches nothing and a grant
       * that always 409s. The two owner columns are nullable and unset means
       * null here, so `is null` is the faithful translation.
       */
      const granted = await getDb()
        .update(catalogEntities)
        .set({
          ownerOxyUserId: claim.oxyUserId,
          claimedByOxyUserId: claim.oxyUserId,
          claimable: false,
        })
        .where(
          and(
            eq(catalogEntities.id, claim.artistId),
            eq(catalogEntities.type, 'artist'),
            eq(catalogEntities.claimable, true),
            isNull(catalogEntities.ownerOxyUserId),
            isNull(catalogEntities.claimedByOxyUserId)
          )
        )
        .returning({ id: catalogEntities.id });

      if (granted.length !== 1) {
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

/**
 * "Tracks on this artist that somebody else contributed" — and the ONE place
 * the vertical split is a real join rather than two independent reads.
 *
 * A `ContributionAttestation` is what makes a track a contribution: it is
 * written when a publication is made by an account that is not the artist, and
 * nothing else records that fact. Under Mongo this was a single aggregation with
 * a `$lookup` from `tracks` into `contributionattestations`.
 *
 * That pipeline cannot survive the split. `tracks` is Postgres and
 * `contribution_attestations` is still Mongoose until Task 13 ports its WRITER —
 * `contribution_attestations` EXISTS in `schema/creators.ts`, so this is a
 * split-brain constraint and not a capability gap, exactly as it is for
 * `UserMusicPreferences` in the playback controllers. Reading the Postgres table
 * today would return an empty shelf, because nothing writes it yet.
 *
 * So it becomes three round trips, and the shape is chosen to keep them bounded:
 *
 *   1. Postgres — the artist's own track ids. Indexed on `artist_id`, and this
 *      is the SAME set the old pipeline's leading `$match: { artistId }` scanned,
 *      so nothing got wider.
 *   2. Mongo — attestations for those ids. The unique index on `trackId` serves
 *      the `$in`, as it served the `$lookup` before.
 *   3. Postgres — the page itself, over the contributed ids only.
 *
 * The whole function disappears into one query when Task 13 lands.
 */
async function loadContributedTrackIds(artistId: string): Promise<Map<string, {
  uploaderOxyUserId: string;
  acceptedAt: Date;
}>> {
  const ownTrackIds = (
    await getDb().select({ id: tracks.id }).from(tracks).where(eq(tracks.artistId, artistId))
  ).map((row) => row.id);

  if (ownTrackIds.length === 0) return new Map();

  const attestations = await ContributionAttestationModel.find({
    trackId: { $in: ownTrackIds },
  })
    .select({ trackId: 1, uploaderOxyUserId: 1, acceptedAt: 1 })
    .lean();

  return new Map(
    attestations.map((row) => [
      row.trackId,
      { uploaderOxyUserId: row.uploaderOxyUserId, acceptedAt: row.acceptedAt },
    ])
  );
}

/** GET /api/artists/me/contributions — recordings other people published onto my profile. */
export const getMyContributions = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const artist = await findOwnedArtistRow(userId);
    if (!artist) {
      return res.status(404).json({ error: 'Artist profile not found' });
    }

    const limit = parseBoundedLimit(req.query.limit, 50);
    const offset = parseOffset(req.query.offset);

    const attestationByTrackId = await loadContributedTrackIds(artist.id);
    const contributedIds = [...attestationByTrackId.keys()];

    // `inArray` with an empty list is a Postgres syntax error, not an empty
    // result — so the empty case answers without a query at all.
    const rows = contributedIds.length
      ? await getDb()
          .select({
            id: tracks.id,
            title: tracks.title,
            albumName: tracks.albumName,
            duration: tracks.duration,
            coverArtId: tracks.coverArtId,
            isAvailable: tracks.isAvailable,
            copyrightRemoved: tracks.copyrightRemoved,
            removedAt: tracks.removedAt,
            removedReason: tracks.removedReason,
            createdAt: tracks.createdAt,
          })
          .from(tracks)
          .where(inArray(tracks.id, contributedIds))
          .orderBy(descNullsLast(tracks.createdAt))
          .offset(offset)
          .limit(limit)
      : [];

    const total = contributedIds.length;

    res.json({
      contributions: rows.map((row) => {
        const attestation = attestationByTrackId.get(row.id);
        return {
          trackId: row.id,
          title: row.title,
          albumName: row.albumName ?? undefined,
          duration: row.duration,
          coverArt: normalizeImageRef(row.coverArtId),
          isAvailable: row.isAvailable,
          copyrightRemoved: row.copyrightRemoved,
          removedAt: row.removedAt?.toISOString(),
          removedReason: row.removedReason ?? undefined,
          createdAt: row.createdAt.toISOString(),
          uploaderOxyUserId: attestation?.uploaderOxyUserId,
          attestedAt: attestation?.acceptedAt?.toISOString(),
        };
      }),
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

    if (!isLiveEntityId(trackId)) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const parsed = contributionActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const artist = await findOwnedArtistRow(userId);
    if (!artist) {
      return res.status(404).json({ error: 'Artist profile not found' });
    }

    // The ownership check is IN the query — a track on somebody else's profile
    // resolves to nothing, exactly as a nonexistent id does.
    const [track] = await getDb()
      .select({ id: tracks.id, copyrightRemoved: tracks.copyrightRemoved })
      .from(tracks)
      .where(and(eq(tracks.id, trackId), eq(tracks.artistId, artist.id)))
      .limit(1);
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
    if (track.copyrightRemoved) {
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
      /**
       * On DRIZZLE, and this one is not a scope choice — a foreign key decides
       * it.
       *
       * `copyright_reports` belongs to Task 13's vertical, so the obvious split
       * is the one every other cross-vertical read here takes: keep the Mongoose
       * write, hand the id to the ported service. That is UNREPRESENTABLE.
       * `tracks.copyright_report_id` is a REAL `.references()` constraint on
       * `copyright_reports.id`, so `takeDownTrack` — already drizzle — writes a
       * Mongo ObjectId into a column Postgres checks, and the update fails with
       * `23503 tracks_copyright_report_id_copyright_reports_id_fk`. Measured,
       * not predicted: that is exactly what this test suite reported.
       *
       * The difference from `UserUpload` and `UserMusicPreferences`, which DO
       * stay Mongoose here, is that neither is referenced by a catalog column. A
       * hybrid split survives a cross-vertical READ and cannot survive a
       * cross-vertical FOREIGN KEY.
       */
      const [report] = await getDb()
        .insert(copyrightReports)
        .values({
          trackId,
          artistId: artist.id,
          reporterOxyUserId: userId,
          reason: parsed.data.reason?.trim() ||
            `Takedown requested by the owner of the artist profile "${artist.name}"`,
          status: 'approved',
          resolvedAt: new Date(),
          resolvedBy: userId,
        })
        .returning({ id: copyrightReports.id, reason: copyrightReports.reason });

      if (!report) {
        return res.status(500).json({ error: 'Failed to record the takedown' });
      }

      const takedown = await takeDownTrack({
        trackId,
        reason: report.reason,
        actorOxyUserId: userId,
        copyrightReportId: report.id,
      });

      if (!takedown) {
        // The track went between the ownership check and the takedown. Nothing was
        // removed, so the report describes a decision that never happened — leaving
        // it would be a resolved takedown with no takedown behind it.
        await getDb().delete(copyrightReports).where(eq(copyrightReports.id, report.id));
        return res.status(404).json({ error: 'Track not found' });
      }

      return res.json({ action: 'takedown', trackId, takedown });
    }

    const isAvailable = parsed.data.action === 'keep';
    await getDb().update(tracks).set({ isAvailable }).where(eq(tracks.id, trackId));

    res.json({ action: parsed.data.action, trackId, isAvailable });
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

    const [updated] = await getDb()
      .update(catalogEntities)
      .set({ acceptsContributions: parsed.data.acceptsContributions })
      .where(
        and(eq(catalogEntities.type, 'artist'), eq(catalogEntities.ownerOxyUserId, userId))
      )
      .returning({ acceptsContributions: catalogEntities.acceptsContributions });

    if (!updated) {
      return res.status(404).json({ error: 'Artist profile not found' });
    }

    res.json({ acceptsContributions: updated.acceptsContributions });
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
    const artist = await findOwnArtistWithSuggestions(userId);
    if (!artist) {
      return res.status(404).json({ error: 'Artist profile not found' });
    }

    const response: ArtistImageSuggestionsResponse = {
      suggestions: (artist.imageSuggestions ?? []).map((suggestion) => ({
        image: suggestion.image,
        // `jsonb` round-trips a Date as an ISO STRING, where Mongo handed back a
        // `Date`. Accepting both keeps this correct for rows written on either
        // side of the cutover rather than only for ones written since.
        proposedAt: new Date(suggestion.proposedAt).toISOString(),
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

    const artist = await findOwnArtistWithSuggestions(userId);
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

    const storedVariantIds = [
      artist.imageSizesSmallId,
      artist.imageSizesMediumId,
      artist.imageSizesLargeId,
      artist.imageSizesXlargeId,
      artist.imageSizesXxlargeId,
      artist.imageSizesOriginalId,
    ];
    const existingVariants = await loadImageVariants(storedVariantIds);

    /**
     * `undefined` when the artist has NO stored variants — not an object of six
     * undefineds.
     *
     * The two are not interchangeable: `mirrorCatalogImage` treats a present
     * `existingImageSizes` as "sizes are already stored" and can return them
     * unchanged, so handing it a fully-empty object claims something false and
     * yields an artist whose six size columns stay null after a successful
     * accept. Caught by this suite rather than reasoned about — the Mongo code
     * passed `artist.imageSizes`, which was simply absent for a fresh artist,
     * and the shape of that absence is what had to be preserved.
     */
    const existingImageSizes = storedVariantIds.some((id) => id !== null)
      ? {
          small: existingVariants(artist.imageSizesSmallId),
          medium: existingVariants(artist.imageSizesMediumId),
          large: existingVariants(artist.imageSizesLargeId),
          xlarge: existingVariants(artist.imageSizesXlargeId),
          xxlarge: existingVariants(artist.imageSizesXxlargeId),
          original: existingVariants(artist.imageSizesOriginalId),
        }
      : undefined;

    const mirrored = await mirrorCatalogImage(
      [{ url: suggestion.image.url, width: suggestion.image.width, height: suggestion.image.height }],
      {
        // Syra's own provenance vocabulary, not the image-provider enum: an
        // externally sourced photo is `cc`, one lifted from an uploaded file is
        // `upload`.
        provider: externalImage ? 'cc' : 'upload',
        entityType: 'artist',
        externalId: artist.id,
        existingImageId: artist.imageId ?? undefined,
        // Rebuilt from the six FK columns the port split `imageSizes` into, via
        // the same batch lookup every serializer uses — a variant needs real
        // `width`/`height`, which live on the `image_assets` row, not on the FK.
        existingImageSizes,
      },
    );

    if (!mirrored) {
      return res.status(502).json({
        error: 'Image unavailable',
        message: 'That photo could not be fetched. It may have been removed at the source.',
      });
    }

    const [updated] = await getDb()
      .update(catalogEntities)
      .set({
        imageId: mirrored.imageId,
        imageSizesSmallId: mirrored.imageSizes.small?.id ?? null,
        imageSizesMediumId: mirrored.imageSizes.medium?.id ?? null,
        imageSizesLargeId: mirrored.imageSizes.large?.id ?? null,
        imageSizesXlargeId: mirrored.imageSizes.xlarge?.id ?? null,
        imageSizesXxlargeId: mirrored.imageSizes.xxlarge?.id ?? null,
        imageSizesOriginalId: mirrored.imageSizes.original?.id ?? null,
        ...(mirrored.primaryColor ? { primaryColor: mirrored.primaryColor } : {}),
        ...(mirrored.secondaryColor ? { secondaryColor: mirrored.secondaryColor } : {}),
        /**
         * Attribution travels with the bytes, or the image may not be used at
         * all. Written unconditionally — set for an external photo, NULLED for an
         * upload-origin one — because a stale licence describing the PREVIOUS
         * image would credit the wrong author for the one now on display, which
         * is worse than no credit. Four columns, so all four move together.
         */
        imageLicenceLicence: externalImage?.licence.licence ?? null,
        imageLicenceLicenceUrl: externalImage?.licence.licenceUrl ?? null,
        imageLicenceAttribution: externalImage?.licence.attribution ?? null,
        imageLicenceSourceUrl: externalImage?.licence.sourceUrl ?? null,
        imageSuggestions: [],
      })
      .where(eq(catalogEntities.id, artist.id))
      .returning(publicColumns(catalogEntities, PROTECTED_COLUMNS_BY_TABLE));

    if (!updated) {
      return res.status(404).json({ error: 'Artist profile not found' });
    }

    logger.info(
      `[Artists] Artist ${artist.id} accepted a suggested profile photo ` +
      `(${externalImage ? `external/${externalImage.provider}` : 'upload'})`,
    );

    res.json(await toArtistResponse(updated));
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

    const artist = await findOwnArtistWithSuggestions(userId);
    if (!artist) {
      return res.status(404).json({ error: 'Artist profile not found' });
    }

    const remaining = (artist.imageSuggestions ?? [])
      .filter((candidate) => candidate.image.url !== parsed.data.url);
    if (remaining.length === (artist.imageSuggestions ?? []).length) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    await getDb()
      .update(catalogEntities)
      .set({ imageSuggestions: remaining })
      .where(eq(catalogEntities.id, artist.id));

    const response: ArtistImageSuggestionsResponse = {
      suggestions: remaining.map((suggestion) => ({
        image: suggestion.image,
        proposedAt: new Date(suggestion.proposedAt).toISOString(),
        proposedByOxyUserId: suggestion.proposedByOxyUserId,
        sourceUploadId: suggestion.sourceUploadId,
      })),
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
};
