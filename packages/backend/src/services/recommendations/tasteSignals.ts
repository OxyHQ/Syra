import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { catalogEntities, tracks } from '../../db/schema/catalog';
import { applyTasteSignal, type TasteDelta } from '../../db/user/taste';
import { describeErrorSafely } from '../../utils/error';
import { logger } from '../../utils/logger';

/**
 * Explicit taste signals (likes, follows) are strong, intentional declarations
 * of taste and carry more weight than a single play.
 *
 * ## The bucket arithmetic moved to `db/user/taste.ts`
 *
 * `bump` and its `MAX_TASTE_GENRES`/`MAX_TASTE_ARTISTS` copies are gone: adding
 * a delta to a keyed bucket and trimming to a cap are now one `on conflict do
 * update` and one bounded delete, in the module that owns the tables. What is
 * left here is the part that is actually about signals — which catalog row a
 * like or a follow implicates, and how much it is worth.
 *
 * `applyToProfile`'s find-or-create went with it. It read the profile, built a
 * fresh object when there was none, and wrote back: three round trips, and a
 * race between the read and the create that a unique constraint plus an upsert
 * closes.
 */

const LIKE_TRACK_WEIGHT = 2.5;
const FOLLOW_ARTIST_WEIGHT = 4;

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

    await applyTasteSignal(oxyUserId, {
      genres: genre ? [{ key: genre, delta: LIKE_TRACK_WEIGHT }] : [],
      artists: [{ key: track.artistId, delta: LIKE_TRACK_WEIGHT }],
      totalSignalDelta: LIKE_TRACK_WEIGHT,
    });
  } catch (err) {
    logger.warn('[recommendations] applyLikeSignal failed', {
      oxyUserId,
      trackId,
      error: describeErrorSafely(err),
    });
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

    // The follow's weight is SPLIT across the artist's genres, so following a
    // five-genre artist does not boost each of them as hard as following a
    // single-genre one. Unchanged from the Mongo version; a list rather than a
    // loop because the deltas now land in one statement.
    const perGenre = FOLLOW_ARTIST_WEIGHT / Math.max(1, genres.length);
    const genreDeltas: TasteDelta[] = genres.map((genre) => ({ key: genre, delta: perGenre }));

    await applyTasteSignal(oxyUserId, {
      genres: genreDeltas,
      artists: [{ key: artistId, delta: FOLLOW_ARTIST_WEIGHT }],
      totalSignalDelta: FOLLOW_ARTIST_WEIGHT,
    });
  } catch (err) {
    logger.warn('[recommendations] applyFollowSignal failed', {
      oxyUserId,
      artistId,
      error: describeErrorSafely(err),
    });
  }
}
