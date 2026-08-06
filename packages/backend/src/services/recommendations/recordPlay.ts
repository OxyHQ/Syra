import { eq, sql } from 'drizzle-orm';
import { ListeningEventModel, type ListeningSource } from '../../models/ListeningEvent';
import { UserTasteProfileModel } from '../../models/UserTasteProfile';
import { getDb } from '../../db/postgres';
import { albums, catalogEntities, tracks } from '../../db/schema/catalog';
import { playCountToPopularity } from '../catalog/popularity';
import { countsAsGlobalPlay, deriveCompletion, playTasteWeight } from './engagement';
import { logger } from '../../utils/logger';

/** Cap on how many genre/artist weights we retain per user taste profile. */
const MAX_TASTE_GENRES = 40;
const MAX_TASTE_ARTISTS = 200;

export interface RecordPlayInput {
  oxyUserId: string;
  trackId: string;
  /** Seconds listened before the play ended. Optional if `completion` given. */
  listenedSec?: number;
  /** Explicit completion ratio [0,1]; overrides listenedSec/duration math. */
  completion?: number;
  source?: ListeningSource;
}

export interface RecordPlayResult {
  recorded: boolean;
  countedAsPlay: boolean;
}

/**
 * Record a real listening event and propagate every signal it carries:
 *
 *  1. Persist an immutable `ListeningEvent` (the canonical engagement log).
 *  2. If the listen cleared the completion threshold, atomically increment the
 *     track's global `playCount` + recompute `popularity`, the album's
 *     `playCount`, and the artist's `stats.totalPlays`. This is what makes
 *     popularity reflect REAL Syra listening, not just imported provider numbers.
 *  3. Fold the play into the user's taste profile (genre + artist affinity),
 *     weighted by how engaged the play was and how trustworthy its source is.
 *
 * Every step is best-effort and isolated: a failure in popularity or taste
 * accounting never loses the event and never throws to the caller path that
 * matters (playback). Returns whether the event was recorded and whether it
 * counted toward global popularity.
 */
export async function recordPlay(input: RecordPlayInput): Promise<RecordPlayResult> {
  const { oxyUserId } = input;
  const trackId = typeof input.trackId === 'string' ? input.trackId.trim() : '';

  // No id-shape check: `tracks.id` is `text`, so an unknown id resolves to no
  // row and the read below answers what the guard used to. The empty-string
  // cases still short-circuit, because those mean the CALLER sent nothing.
  if (!oxyUserId || !trackId) {
    return { recorded: false, countedAsPlay: false };
  }

  const [track] = await getDb()
    .select({
      id: tracks.id,
      artistId: tracks.artistId,
      albumId: tracks.albumId,
      genre: tracks.genre,
      metadataGenre: tracks.metadataGenre,
      duration: tracks.duration,
      playCount: tracks.playCount,
    })
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);

  if (!track) {
    return { recorded: false, countedAsPlay: false };
  }

  const durationSec = track.duration;
  const { listenedSec, completion, skipped } = deriveCompletion({
    listenedSec: input.listenedSec ?? 0,
    durationSec,
    explicitCompletion: input.completion,
  });

  const source: ListeningSource = input.source ?? 'unknown';
  const genre = resolvePrimaryGenre(track.genre, track.metadataGenre);
  const artistId = track.artistId;

  const playedAt = new Date();

  await ListeningEventModel.create({
    oxyUserId,
    trackId,
    artistId,
    genre,
    durationSec,
    listenedSec,
    completion,
    skipped,
    source,
    playedAt,
  });

  const countedAsPlay = countsAsGlobalPlay({ completion, skipped });

  // Fan out the heavier aggregate updates without blocking the caller; each is
  // independently isolated so one failure never cascades.
  await Promise.allSettled([
    countedAsPlay
      ? incrementGlobalCounters(track.id, track.albumId, artistId, track.playCount)
      : Promise.resolve(),
    updateTasteProfile(oxyUserId, { genre, artistId, completion, skipped, source }),
  ]);

  return { recorded: true, countedAsPlay };
}

/** Resolve a single lowercased genre string from the track's genre fields. */
function resolvePrimaryGenre(
  topGenre: string | null,
  metadataGenres: string[] | null,
): string | undefined {
  const candidate = topGenre ?? metadataGenres?.[0];
  if (typeof candidate !== 'string') return undefined;
  const trimmed = candidate.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Atomically bump global play counters from a single counted play and recompute
 * the track's normalised popularity from its new lifetime count.
 */
async function incrementGlobalCounters(
  trackId: string,
  albumId: string | null,
  artistId: string,
  priorPlayCount: number,
): Promise<void> {
  try {
    const newPlayCount = priorPlayCount + 1;
    const popularity = playCountToPopularity(newPlayCount);

    /**
     * `play_count = play_count + 1` in SQL, not `set({ playCount: newPlayCount })`.
     *
     * The read above and this write are not atomic together, so writing the
     * value computed from the read would LOSE a concurrent play — two listeners
     * finishing the same track at once would both read N and both write N+1.
     * The increment is evaluated by the database against the current row, so
     * both land. `popularity` is the one field that cannot be expressed that way
     * (it is a non-linear function of the count) and is written from the read;
     * it is a derived display score with a nightly recompute, so a lost update
     * there costs a stale rank rather than a lost play.
     */
    const ops: Promise<unknown>[] = [
      getDb()
        .update(tracks)
        .set({ playCount: sql`${tracks.playCount} + 1`, popularity })
        .where(eq(tracks.id, trackId)),
      getDb()
        .update(catalogEntities)
        .set({ statsTotalPlays: sql`coalesce(${catalogEntities.statsTotalPlays}, 0) + 1` })
        .where(eq(catalogEntities.id, artistId)),
    ];

    if (albumId) {
      ops.push(
        getDb()
          .update(albums)
          .set({ playCount: sql`${albums.playCount} + 1` })
          .where(eq(albums.id, albumId))
      );
    }

    await Promise.all(ops);
  } catch (err) {
    logger.warn('[recommendations] failed to increment global counters', { trackId, artistId, err });
  }
}

interface TasteSignal {
  genre?: string;
  artistId: string;
  completion: number;
  skipped: boolean;
  source: ListeningSource;
}

/**
 * Fold a single play into the user's taste profile. Adds the play's weight to
 * the matching genre and artist buckets, trims each list to its cap (dropping
 * the lowest-weight tails), and bumps `totalSignal`.
 */
async function updateTasteProfile(oxyUserId: string, signal: TasteSignal): Promise<void> {
  try {
    const weight = playTasteWeight({
      completion: signal.completion,
      skipped: signal.skipped,
      source: signal.source,
    });

    // A pure skip with no positive weight isn't worth a profile write.
    if (weight <= 0 && signal.skipped) {
      // Still apply a gentle cooling to the artist so heavy skipping registers.
      if (!signal.artistId) return;
    }

    const profile = await UserTasteProfileModel.findOne({ oxyUserId });

    if (!profile) {
      const genres = signal.genre && weight > 0 ? [{ key: signal.genre, weight }] : [];
      const artists = weight > 0 ? [{ key: signal.artistId, weight }] : [];
      await UserTasteProfileModel.create({
        oxyUserId,
        genres,
        artists,
        totalSignal: Math.max(0, weight),
        lastDecayAt: new Date(),
      });
      return;
    }

    applyWeight(profile.genres, signal.genre, weight, MAX_TASTE_GENRES);
    applyWeight(profile.artists, signal.artistId, weight, MAX_TASTE_ARTISTS);
    profile.totalSignal = Math.max(0, profile.totalSignal + Math.max(0, weight));
    await profile.save();
  } catch (err) {
    logger.warn('[recommendations] failed to update taste profile', { oxyUserId, err });
  }
}

/**
 * Add `delta` to the weight bucket keyed by `key`, clamping at 0, and trim the
 * list to `max` entries by dropping the lowest weights. Mutates `list` in place.
 */
function applyWeight(
  list: { key: string; weight: number }[],
  key: string | undefined,
  delta: number,
  max: number,
): void {
  if (!key) return;
  const existing = list.find((entry) => entry.key === key);
  if (existing) {
    existing.weight = Math.max(0, existing.weight + delta);
  } else if (delta > 0) {
    list.push({ key, weight: delta });
  } else {
    return;
  }

  if (list.length > max) {
    list.sort((a, b) => b.weight - a.weight);
    list.length = max;
  }
}
