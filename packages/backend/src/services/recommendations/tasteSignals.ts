import { and, eq } from 'drizzle-orm';
import { UserTasteProfileModel } from '../../models/UserTasteProfile';
import { getDb } from '../../db/postgres';
import { catalogEntities, tracks } from '../../db/schema/catalog';
import { logger } from '../../utils/logger';

/**
 * `UserTasteProfile` belongs to the user vertical (Task 15) and is still
 * Mongoose. The two catalog reads below are Postgres; neither is joined to the
 * profile, so the split is two round trips rather than a broken query.
 */

/**
 * Explicit taste signals (likes, follows) are strong, intentional declarations
 * of taste and carry more weight than a single play.
 */
const LIKE_TRACK_WEIGHT = 2.5;
const FOLLOW_ARTIST_WEIGHT = 4;

const MAX_TASTE_GENRES = 40;
const MAX_TASTE_ARTISTS = 200;

/** Add a positive weight to a keyed bucket, capping list length. */
function bump(
  list: { key: string; weight: number }[],
  key: string,
  delta: number,
  max: number,
): void {
  const existing = list.find((entry) => entry.key === key);
  if (existing) {
    existing.weight = Math.max(0, existing.weight + delta);
  } else {
    list.push({ key, weight: Math.max(0, delta) });
  }
  if (list.length > max) {
    list.sort((a, b) => b.weight - a.weight);
    list.length = max;
  }
}

async function applyToProfile(
  oxyUserId: string,
  apply: (profile: { genres: { key: string; weight: number }[]; artists: { key: string; weight: number }[]; totalSignal: number }) => number,
): Promise<void> {
  const profile = await UserTasteProfileModel.findOne({ oxyUserId });
  if (!profile) {
    const fresh = { genres: [] as { key: string; weight: number }[], artists: [] as { key: string; weight: number }[], totalSignal: 0 };
    const added = apply(fresh);
    await UserTasteProfileModel.create({
      oxyUserId,
      genres: fresh.genres,
      artists: fresh.artists,
      totalSignal: Math.max(0, added),
      lastDecayAt: new Date(),
    });
    return;
  }
  const added = apply(profile);
  profile.totalSignal = Math.max(0, profile.totalSignal + Math.max(0, added));
  await profile.save();
}

/**
 * Fold a track-like into the user's taste profile: boosts the track's artist
 * and primary genre. Best-effort; never throws.
 */
export async function applyLikeSignal(oxyUserId: string, trackId: string): Promise<void> {
  try {
    const [track] = await getDb()
      .select({
        artistId: tracks.artistId,
        genre: tracks.genre,
        metadataGenre: tracks.metadataGenre,
      })
      .from(tracks)
      .where(eq(tracks.id, trackId))
      .limit(1);
    if (!track) return;
    const genre = (track.genre ?? track.metadataGenre?.[0])?.trim().toLowerCase();

    await applyToProfile(oxyUserId, (profile) => {
      bump(profile.artists, track.artistId, LIKE_TRACK_WEIGHT, MAX_TASTE_ARTISTS);
      if (genre) bump(profile.genres, genre, LIKE_TRACK_WEIGHT, MAX_TASTE_GENRES);
      return LIKE_TRACK_WEIGHT;
    });
  } catch (err) {
    logger.warn('[recommendations] applyLikeSignal failed', { oxyUserId, trackId, err });
  }
}

/**
 * Fold an artist-follow into the user's taste profile: strong boost to the
 * artist and its genres. Best-effort; never throws.
 */
export async function applyFollowSignal(oxyUserId: string, artistId: string): Promise<void> {
  try {
    const [artist] = await getDb()
      .select({ genres: catalogEntities.genres })
      .from(catalogEntities)
      .where(and(eq(catalogEntities.id, artistId), eq(catalogEntities.type, 'artist')))
      .limit(1);
    if (!artist) return;
    const genres = (artist.genres ?? [])
      .map((g) => g.trim().toLowerCase())
      .filter((g) => g.length > 0);

    await applyToProfile(oxyUserId, (profile) => {
      bump(profile.artists, artistId, FOLLOW_ARTIST_WEIGHT, MAX_TASTE_ARTISTS);
      for (const genre of genres) {
        bump(profile.genres, genre, FOLLOW_ARTIST_WEIGHT / Math.max(1, genres.length), MAX_TASTE_GENRES);
      }
      return FOLLOW_ARTIST_WEIGHT;
    });
  } catch (err) {
    logger.warn('[recommendations] applyFollowSignal failed', { oxyUserId, artistId, err });
  }
}
