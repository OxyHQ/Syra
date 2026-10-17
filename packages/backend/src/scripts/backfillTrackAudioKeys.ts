/**
 * One-shot: record where each track's original actually IS
 * (`tracks.audio_source_key`), for the rows uploaded before the column existed.
 *
 * ## Why the key cannot be re-derived
 *
 * An original is written to `audio/{artist}[/{album}]/{track}.{ext}` with the
 * artist and album the track had AT UPLOAD (`getS3AudioKey`). Both can change
 * afterwards: a creator moves the track to another album, or
 * `splitMergedArtist.ts` re-points it at the real artist. Re-deriving the key
 * from the row then names an object that does not exist, and every process
 * that reads the original misses it — ingest, fingerprinting, a preview at an
 * offset, room playback, and `migrateAudioToOxy.ts`, which reported production's
 * split track `missing_object` while its original sat under the old artist.
 *
 * ## How it is found: by name, not by guess
 *
 * The object's FILE NAME is the track id, and nothing moves it. So the script
 * lists the catalogue prefix once and matches `{track}.{ext}` to the track —
 * no inference from the current artist or album. Two objects named for the same
 * track are `ambiguous` and recorded for nobody; a track with none is
 * `missing`. A row that already has a key is never touched.
 *
 * ## Running it
 *
 *   bun run backfill:track-audio-keys            # preview (the default)
 *   bun run backfill:track-audio-keys -- --apply # record the keys
 *
 * In production through `.github/workflows/run-backend-script.yml`
 * (`backfill-track-audio-keys`). Safe to re-run: a second run finds nothing to do.
 */

import { and, asc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { tracks } from '../db/schema/catalog';
import { getS3AudioKey, listCatalogOriginalKeys } from '../services/oxyFiles/audioStorage';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';

const BATCH_SIZE = 500;

export type TrackKeyOutcome = 'would_record' | 'recorded' | 'missing' | 'ambiguous';

export interface TrackKeyLine {
  id: string;
  outcome: TrackKeyOutcome;
  /** True when the original is NOT where the row's current artist and album derive. */
  moved?: boolean;
}

export interface TrackKeyBackfillOptions {
  apply: boolean;
  listKeys?: () => AsyncIterable<string>;
  report?: (line: TrackKeyLine) => void;
}

export type TrackKeyBackfillStats = Record<TrackKeyOutcome, number>;

/** `audio/{artist}[/{album}]/{track}.{ext}` → `{track}`, else `null`. */
function trackIdOf(key: string): string | null {
  const parts = key.split('/');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const name = parts[parts.length - 1] ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : null;
}

export async function backfillTrackAudioKeys(
  options: TrackKeyBackfillOptions,
): Promise<TrackKeyBackfillStats> {
  const stats: TrackKeyBackfillStats = { would_record: 0, recorded: 0, missing: 0, ambiguous: 0 };
  const report = (line: TrackKeyLine) => {
    stats[line.outcome] += 1;
    options.report?.(line);
  };

  /** Track id → every key named for it. */
  const byTrack = new Map<string, string[]>();
  for await (const key of (options.listKeys ?? listCatalogOriginalKeys)()) {
    const trackId = trackIdOf(key);
    if (trackId === null) continue;
    byTrack.set(trackId, [...(byTrack.get(trackId) ?? []), key]);
  }

  let after: string | undefined;
  for (;;) {
    const rows = await getDb()
      .select({
        id: tracks.id,
        artistId: tracks.artistId,
        albumId: tracks.albumId,
        format: tracks.audioSourceFormat,
      })
      .from(tracks)
      .where(
        and(
          isNull(tracks.audioSourceKey),
          isNotNull(tracks.audioSourceUrl),
          after === undefined ? undefined : gt(tracks.id, after),
        ),
      )
      .orderBy(asc(tracks.id))
      .limit(BATCH_SIZE);
    if (rows.length === 0) break;
    after = rows[rows.length - 1]?.id;

    for (const row of rows) {
      const keys = byTrack.get(row.id) ?? [];
      if (keys.length === 0) {
        report({ id: row.id, outcome: 'missing' });
        continue;
      }
      if (keys.length > 1) {
        report({ id: row.id, outcome: 'ambiguous' });
        continue;
      }
      const key = keys[0] as string;
      const derived = getS3AudioKey(
        row.id,
        row.artistId,
        row.albumId ?? undefined,
        row.format ?? 'mp3',
      );
      const moved = key !== derived;
      if (options.apply) {
        await getDb()
          .update(tracks)
          .set({ audioSourceKey: key })
          .where(and(eq(tracks.id, row.id), isNull(tracks.audioSourceKey)));
      }
      report({ id: row.id, outcome: options.apply ? 'recorded' : 'would_record', moved });
    }
  }
  return stats;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await connectPostgres();
  try {
    const stats = await backfillTrackAudioKeys({
      apply,
      report: (line) => logger.info('[backfill-track-audio-keys]', { ...line }),
    });
    logger.info(`[backfill-track-audio-keys] ${apply ? 'applied' : 'preview (nothing written)'}`, {
      ...stats,
    });
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('[backfill-track-audio-keys] failed', { error: describeErrorSafely(error) });
    process.exit(1);
  });
}
