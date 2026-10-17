/**
 * Delete the legacy HLS ladders Oxy has replaced (OxyHQ/oxy ADR 0043 stage 4c).
 *
 * A row whose audio is in Oxy Files plays from Oxy's own ladder; its legacy
 * ladder in the bucket (playlists, encrypted segments, its AES key in
 * `track_keys`, a catalogue track's default preview clip) is then only a
 * fallback. Once Oxy has CONFIRMED its ladder for the file — `hlsReadyAt` and
 * an `active` file, asked of Oxy itself, never assumed — this deletes the
 * legacy one and clears the row's legacy ladder columns, so the row plays from
 * Oxy alone.
 *
 * KEPT: the original in the bucket. It is the input of every process Syra runs
 * on the raw bytes (re-ingest, fingerprinting, promoting a locker file, a
 * preview at a listener-chosen offset, a track played into a LiveKit room), and
 * none of those is a listener's playback.
 *
 * Gated on `OXY_AUDIO=oxy`: in `legacy` or `dual` a row without its legacy
 * ladder would have nothing to fall back to, so `--apply` refuses outright.
 * The preview (the default) runs in any mode and reports what would go.
 *
 *   bun run retire:legacy-audio-ladders                  # preview
 *   bun run retire:legacy-audio-ladders -- --apply       # delete (OXY_AUDIO=oxy only)
 *   bun run retire:legacy-audio-ladders -- --apply --limit 500
 *
 * In production through `.github/workflows/run-backend-script.yml`
 * (`retire-legacy-audio-ladders`), after `migrate-audio-to-oxy`.
 */

import { and, asc, eq, gt, isNotNull } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { trackHlsRenditions, tracks } from '../db/schema/catalog';
import { userUploadHlsRenditions, userUploads } from '../db/schema/creators';
import { episodeHlsRenditions, episodes } from '../db/schema/podcasts';
import { trackKeys } from '../db/schema/trackKeys';
import {
  deleteAudioObject,
  deleteAudioPrefix,
  getS3HlsKey,
  getS3LockerHlsPrefix,
  getS3PodcastEpisodeHlsPrefix,
  getS3PreviewKey,
  laddersReady,
  oxyAudioMode,
} from '../services/oxyFiles/audioStorage';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';

const BATCH_SIZE = 100;

export const LADDER_KINDS = ['tracks', 'uploads', 'episodes'] as const;
export type LadderKind = (typeof LADDER_KINDS)[number];

export type LadderOutcome = 'would_retire' | 'retired' | 'oxy_not_ready' | 'failed';

export interface LadderLine {
  kind: LadderKind;
  id: string;
  outcome: LadderOutcome;
  fileId: string;
  objectsDeleted?: number;
  error?: string;
}

export type LadderStats = Record<LadderOutcome, number>;

interface LadderUnit {
  kind: LadderKind;
  id: string;
  fileId: string;
  /** The directory holding exactly this row's ladder. */
  prefix: string;
  /** Single objects beside it (a default preview clip). */
  objects: string[];
}

export interface RetireDeps {
  ready?: typeof laddersReady;
  deletePrefix?: (prefix: string) => Promise<number>;
  deleteObject?: (key: string) => Promise<void>;
}

export class RetirementRefused extends Error {}

async function trackUnits(after: string | null): Promise<LadderUnit[]> {
  const rows = await getDb()
    .select({ id: tracks.id, artistId: tracks.artistId, fileId: tracks.audioFileId })
    .from(tracks)
    .where(
      and(
        isNotNull(tracks.audioFileId),
        isNotNull(tracks.hlsMasterKey),
        after === null ? undefined : gt(tracks.id, after),
      ),
    )
    .orderBy(asc(tracks.id))
    .limit(BATCH_SIZE);
  return rows.map((row) => ({
    kind: 'tracks',
    id: row.id,
    fileId: row.fileId as string,
    prefix: getS3HlsKey(row.artistId, row.id, ''),
    objects: [getS3PreviewKey(row.id, 0)],
  }));
}

async function uploadUnits(after: string | null): Promise<LadderUnit[]> {
  const rows = await getDb()
    .select({
      id: userUploads.id,
      owner: userUploads.ownerOxyUserId,
      fileId: userUploads.audioFileId,
    })
    .from(userUploads)
    .where(
      and(
        isNotNull(userUploads.audioFileId),
        isNotNull(userUploads.hlsMasterKey),
        after === null ? undefined : gt(userUploads.id, after),
      ),
    )
    .orderBy(asc(userUploads.id))
    .limit(BATCH_SIZE);
  return rows.map((row) => ({
    kind: 'uploads',
    id: row.id,
    fileId: row.fileId as string,
    prefix: getS3LockerHlsPrefix(row.owner, row.id),
    objects: [],
  }));
}

async function episodeUnits(after: string | null): Promise<LadderUnit[]> {
  const rows = await getDb()
    .select({ id: episodes.id, podcastId: episodes.podcastId, fileId: episodes.audioFileId })
    .from(episodes)
    .where(
      and(
        isNotNull(episodes.audioFileId),
        isNotNull(episodes.hlsMasterKey),
        after === null ? undefined : gt(episodes.id, after),
      ),
    )
    .orderBy(asc(episodes.id))
    .limit(BATCH_SIZE);
  return rows.map((row) => ({
    kind: 'episodes',
    id: row.id,
    fileId: row.fileId as string,
    prefix: getS3PodcastEpisodeHlsPrefix(row.podcastId, row.id),
    objects: [],
  }));
}

const INVENTORY: Record<LadderKind, (after: string | null) => Promise<LadderUnit[]>> = {
  tracks: trackUnits,
  uploads: uploadUnits,
  episodes: episodeUnits,
};

/** Clear a row's legacy ladder: its rendition rows, its master key and its AES key. */
async function clearLadder(unit: LadderUnit): Promise<void> {
  await getDb().transaction(async (tx) => {
    switch (unit.kind) {
      case 'tracks':
        await tx.delete(trackHlsRenditions).where(eq(trackHlsRenditions.trackId, unit.id));
        await tx.update(tracks).set({ hlsMasterKey: null }).where(eq(tracks.id, unit.id));
        await tx.delete(trackKeys).where(eq(trackKeys.trackId, unit.id));
        return;
      case 'uploads':
        await tx
          .delete(userUploadHlsRenditions)
          .where(eq(userUploadHlsRenditions.userUploadId, unit.id));
        await tx.update(userUploads).set({ hlsMasterKey: null }).where(eq(userUploads.id, unit.id));
        await tx.delete(trackKeys).where(eq(trackKeys.userUploadId, unit.id));
        return;
      case 'episodes':
        await tx.delete(episodeHlsRenditions).where(eq(episodeHlsRenditions.episodeId, unit.id));
        await tx.update(episodes).set({ hlsMasterKey: null }).where(eq(episodes.id, unit.id));
        await tx.delete(trackKeys).where(eq(trackKeys.episodeId, unit.id));
        return;
    }
  });
}

export async function retireLegacyAudioLadders(options: {
  apply: boolean;
  limit?: number;
  report: (line: LadderLine) => void;
  deps?: RetireDeps;
}): Promise<LadderStats> {
  if (options.apply && oxyAudioMode() !== 'oxy') {
    throw new RetirementRefused(
      `OXY_AUDIO is ${oxyAudioMode()}: a row without its legacy ladder plays only from Oxy, ` +
        'so legacy ladders are retired only under OXY_AUDIO=oxy',
    );
  }
  const deps = options.deps ?? {};
  const stats: LadderStats = { would_retire: 0, retired: 0, oxy_not_ready: 0, failed: 0 };

  for (const kind of LADDER_KINDS) {
    let after: string | null = null;
    let seen = 0;
    for (;;) {
      let units = await INVENTORY[kind](after);
      if (units.length === 0) break;
      after = units[units.length - 1].id;
      if (options.limit !== undefined) units = units.slice(0, options.limit - seen);
      seen += units.length;

      const ready = await (deps.ready ?? laddersReady)(units.map((unit) => unit.fileId));
      for (const unit of units) {
        const base = { kind, id: unit.id, fileId: unit.fileId };
        let line: LadderLine;
        if (!ready.get(unit.fileId)) {
          line = { ...base, outcome: 'oxy_not_ready' };
        } else if (!options.apply) {
          line = { ...base, outcome: 'would_retire' };
        } else {
          try {
            // The row first: once it names no ladder nothing serves one, so an
            // interruption leaves orphaned objects (swept by a re-run of the
            // prefix delete), never a row pointing at deleted ones.
            await clearLadder(unit);
            let objectsDeleted = await (deps.deletePrefix ?? deleteAudioPrefix)(unit.prefix);
            for (const key of unit.objects) {
              await (deps.deleteObject ?? deleteAudioObject)(key);
              objectsDeleted += 1;
            }
            line = { ...base, outcome: 'retired', objectsDeleted };
          } catch (error) {
            line = { ...base, outcome: 'failed', error: describeErrorSafely(error) };
          }
        }
        stats[line.outcome] += 1;
        options.report(line);
      }
      if (options.limit !== undefined && seen >= options.limit) break;
    }
  }
  return stats;
}

function flagValue(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = Number.parseInt(process.argv[index + 1] ?? '', 10);
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} needs a positive integer`);
  return value;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await connectPostgres();
  try {
    const stats = await retireLegacyAudioLadders({
      apply,
      limit: flagValue('--limit'),
      report: (line) => logger.info('[retire-legacy-audio-ladders]', { ...line }),
    });
    logger.info(
      `[retire-legacy-audio-ladders] ${apply ? 'applied' : 'preview (nothing deleted)'}`,
      { ...stats },
    );
    if (stats.failed > 0) process.exitCode = 1;
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('[retire-legacy-audio-ladders] failed', { error: describeErrorSafely(error) });
    process.exit(1);
  });
}
