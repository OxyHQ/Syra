import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { albums, catalogEntities, tracks } from '../../db/schema/catalog';
import { insertListeningEvent, type ListeningSource } from '../../db/user/listening';
import { applyTasteSignal } from '../../db/user/taste';
import { playCountToPopularity } from '../catalog/popularity';
import { countsAsGlobalPlay, deriveCompletion, playTasteWeight } from './engagement';
import { describeErrorSafely } from '../../utils/error';
import { logger } from '../../utils/logger';

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

  await insertListeningEvent({
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
    logger.warn('[recommendations] failed to increment global counters', {
      trackId,
      artistId,
      error: describeErrorSafely(err),
    });
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
 * Fold a single play into the user's taste profile.
 *
 * `applyWeight` and the profile find-or-create are gone into
 * `db/user/taste.ts`: adding a delta to a keyed bucket, refusing to create one
 * for a non-positive delta, and trimming to the cap are that module's `on
 * conflict do update` and bounded delete, expressed once for all three signal
 * sources rather than near-duplicated here and in `tasteSignals.ts`.
 *
 * A skip's weight is NEGATIVE, and passing it through unchanged is the point:
 * it cools the buckets the play touched without ever creating one, which is
 * exactly what `applyWeight` did with a non-positive delta. `totalSignalDelta`
 * is clamped at zero separately, so churning past a track never reduces the
 * maturity signal that decides cold start.
 */
async function updateTasteProfile(oxyUserId: string, signal: TasteSignal): Promise<void> {
  try {
    const weight = playTasteWeight({
      completion: signal.completion,
      skipped: signal.skipped,
      source: signal.source,
    });

    if (!signal.artistId) return;

    await applyTasteSignal(oxyUserId, {
      genres: signal.genre ? [{ key: signal.genre, delta: weight }] : [],
      artists: [{ key: signal.artistId, delta: weight }],
      totalSignalDelta: Math.max(0, weight),
    });
  } catch (err) {
    logger.warn('[recommendations] failed to update taste profile', {
      oxyUserId,
      error: describeErrorSafely(err),
    });
  }
}
