/**
 * One-shot: store the audio Syra already holds in Oxy Files (OxyHQ/oxy ADR 0043
 * stage 4c), and point each row at its file.
 *
 * ## What moves, and to whom
 *
 * Every copy is a PRIVATE Oxy file; Oxy renders its audio-only HLS ladder,
 * waveform and 30-second preview, and Syra plays it through play sessions.
 *
 * - `tracks` — the catalogue: the SYRA application's file, from the original in
 *   the bucket.
 * - `uploads` — a locker file: a file in its OWNER's Oxy account, stored for
 *   them by Syra. An owner Oxy no longer knows cannot own anything, and a
 *   person's private music is not Syra's to keep: that upload stays on the
 *   legacy path and the report says `owner_unknown`.
 * - `episodes` — a hosted episode: its show owner's file (Syra's own for a show
 *   nobody owns).
 * - `enclosures` — a mirrored RSS episode the bucket cached: imported BY OXY
 *   from its enclosure URL (up to 8 GiB; one over 40 MiB is fetched in the
 *   background and waited for), Syra's own file. An origin that no longer
 *   answers falls back to uploading the bucket's cached copy.
 * - `recordings` — a room recording in the bucket: Syra's own file; a
 *   recording made into an Oxy recording target is collected instead.
 *
 * NOT moved, and reported: a row whose bucket object is gone
 * (`missing_object`), whose upload Oxy refused (`failed`, with Oxy's status
 * and code) — both keep playing exactly as before.
 *
 * ## Verified, resumable, and safe to re-run
 *
 * Every original is hashed before upload and compared with the SHA-256 Oxy
 * answers (`storeAudioInOxy`); a mismatch points nothing at the file. A row is
 * "done" exactly when its column names an Oxy file, so a re-run — after an
 * interruption, a failure, or a bounded `--limit` pass — continues with what is
 * left, and Oxy's per-owner deduplication answers a repeated upload with the
 * same file. Pointing a row at its file is what queues Syra's reference to it
 * (migration `0036`'s triggers).
 *
 * Nothing here changes what plays until `OXY_AUDIO` is `dual` or `oxy`: in
 * `legacy` the runtime never reads the new columns. Run it AFTER Oxy's stage 4c
 * is deployed — before that, Oxy refuses audio and every unit reports `failed`,
 * which changes nothing.
 *
 * Reports carry Syra's own row ids, sizes and SHA-256 hashes — never a URL or a
 * bucket key. One JSON line per unit (`[migrate-audio-to-oxy]`).
 *
 * ## Running it
 *
 *   bun run migrate:audio-to-oxy                        # preview (the default)
 *   bun run migrate:audio-to-oxy -- --apply             # copy and repoint
 *   bun run migrate:audio-to-oxy -- --apply --limit 200 # a bounded pass (per kind)
 *   bun run migrate:audio-to-oxy -- --apply --concurrency 4
 *
 * In production through `.github/workflows/run-backend-script.yml`
 * (`migrate-audio-to-oxy`). `docs/runbooks/oxy-files-audio.md` is the order.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, asc, eq, gt, isNotNull, isNull, ne } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { tracks } from '../db/schema/catalog';
import { userUploads } from '../db/schema/creators';
import { episodes, podcasts } from '../db/schema/podcasts';
import { recordings } from '../db/schema/rooms';
import {
  audioMimeFor,
  collectRecordingFile,
  getS3AudioKey,
  getS3PodcastEpisodeAudioKey,
  importEnclosureToOxy,
  stageAudioObject,
  storeAudioInOxy,
  type AudioEntity,
  type AudioOwner,
  type StoredOxyAudio,
} from '../services/oxyFiles/audioStorage';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';

const BATCH_SIZE = 100;

export const AUDIO_MIGRATION_KINDS = [
  'tracks',
  'uploads',
  'episodes',
  'enclosures',
  'recordings',
] as const;
export type AudioMigrationKind = (typeof AUDIO_MIGRATION_KINDS)[number];

export type AudioMigrationOutcome =
  | 'would_copy'
  | 'copied'
  | 'collected'
  | 'missing_object'
  | 'owner_unknown'
  | 'not_ready'
  | 'failed';

export interface AudioMigrationLine {
  kind: AudioMigrationKind;
  id: string;
  outcome: AudioMigrationOutcome;
  fileId?: string;
  sha256?: string;
  size?: number;
  owner?: 'application' | 'account';
  status?: number;
  code?: string;
  error?: string;
}

export type AudioMigrationStats = Record<AudioMigrationOutcome, number>;

/** One row to copy: where its original is, and whose file it becomes. */
interface AudioUnit {
  kind: AudioMigrationKind;
  entity: AudioEntity;
  owner: AudioOwner;
  /** The bucket object holding the original (`null` for a target to collect). */
  objectKey: string | null;
  format: string;
  /** An enclosure Oxy imports by URL before the cached copy is uploaded. */
  sourceUrl?: string;
  /** A recording Oxy already holds in a recording target. */
  recordingTargetId?: string;
}

export interface AudioMigrationDeps {
  stage?: (key: string, localPath: string) => Promise<boolean>;
  store?: typeof storeAudioInOxy;
  importEnclosure?: typeof importEnclosureToOxy;
  collect?: typeof collectRecordingFile;
}

export interface AudioMigrationOptions {
  apply: boolean;
  /** At most this many units of EACH kind. */
  limit?: number;
  concurrency?: number;
  kinds?: readonly AudioMigrationKind[];
  report: (line: AudioMigrationLine) => void;
  deps?: AudioMigrationDeps;
}

function errorFields(error: unknown): Pick<AudioMigrationLine, 'status' | 'code' | 'error'> {
  const status = (error as { status?: unknown } | null)?.status;
  const code = (error as { code?: unknown } | null)?.code;
  return {
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof code === 'string' && code ? { code } : {}),
    error: describeErrorSafely(error),
  };
}

// ── Inventory: one keyset-paginated query per kind ──────────────────────────

async function trackUnits(after: string | null): Promise<AudioUnit[]> {
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
        isNull(tracks.audioFileId),
        isNotNull(tracks.audioSourceUrl),
        isNotNull(tracks.audioSourceFormat),
        after === null ? undefined : gt(tracks.id, after),
      ),
    )
    .orderBy(asc(tracks.id))
    .limit(BATCH_SIZE);
  return rows.map((row) => ({
    kind: 'tracks',
    entity: { kind: 'track', id: row.id },
    owner: { kind: 'application' },
    objectKey: getS3AudioKey(row.id, row.artistId, row.albumId ?? undefined, row.format ?? 'mp3'),
    format: row.format ?? 'mp3',
  }));
}

async function uploadUnits(after: string | null): Promise<AudioUnit[]> {
  const rows = await getDb()
    .select({
      id: userUploads.id,
      owner: userUploads.ownerOxyUserId,
      key: userUploads.audioSourceKey,
      format: userUploads.audioSourceFormat,
    })
    .from(userUploads)
    .where(
      and(
        isNull(userUploads.audioFileId),
        isNull(userUploads.deletedAt),
        isNotNull(userUploads.audioSourceKey),
        isNotNull(userUploads.audioSourceFormat),
        after === null ? undefined : gt(userUploads.id, after),
      ),
    )
    .orderBy(asc(userUploads.id))
    .limit(BATCH_SIZE);
  return rows.map((row) => ({
    kind: 'uploads',
    entity: { kind: 'user_upload', id: row.id },
    owner: { kind: 'account', oxyUserId: row.owner },
    objectKey: row.key,
    format: row.format ?? 'mp3',
  }));
}

async function episodeUnits(after: string | null): Promise<AudioUnit[]> {
  const rows = await getDb()
    .select({
      id: episodes.id,
      podcastId: episodes.podcastId,
      format: episodes.audioSourceFormat,
      owner: podcasts.ownerOxyUserId,
    })
    .from(episodes)
    .innerJoin(podcasts, eq(podcasts.id, episodes.podcastId))
    .where(
      and(
        eq(episodes.source, 'syra'),
        isNull(episodes.audioFileId),
        isNotNull(episodes.audioSourceFormat),
        ne(episodes.status, 'unavailable'),
        after === null ? undefined : gt(episodes.id, after),
      ),
    )
    .orderBy(asc(episodes.id))
    .limit(BATCH_SIZE);
  return rows.map((row) => ({
    kind: 'episodes',
    entity: { kind: 'episode', id: row.id },
    owner: row.owner ? { kind: 'account', oxyUserId: row.owner } : { kind: 'application' },
    objectKey: getS3PodcastEpisodeAudioKey(row.id, row.podcastId, row.format ?? 'mp3'),
    format: row.format ?? 'mp3',
  }));
}

async function enclosureUnits(after: string | null): Promise<AudioUnit[]> {
  const rows = await getDb()
    .select({
      id: episodes.id,
      key: episodes.cacheObjectKey,
      url: episodes.enclosureUrl,
    })
    .from(episodes)
    .where(
      and(
        eq(episodes.source, 'rss'),
        isNull(episodes.audioFileId),
        eq(episodes.cacheStatus, 'cached'),
        isNotNull(episodes.cacheObjectKey),
        after === null ? undefined : gt(episodes.id, after),
      ),
    )
    .orderBy(asc(episodes.id))
    .limit(BATCH_SIZE);
  return rows.map((row) => {
    const extension = /\.([a-z0-9]{2,4})$/i.exec(row.key ?? '')?.[1] ?? 'mp3';
    return {
      kind: 'enclosures',
      entity: { kind: 'episode', id: row.id },
      owner: { kind: 'application' },
      objectKey: row.key,
      format: extension,
      ...(row.url ? { sourceUrl: row.url } : {}),
    };
  });
}

async function recordingUnits(after: string | null): Promise<AudioUnit[]> {
  const rows = await getDb()
    .select({
      id: recordings.id,
      key: recordings.objectKey,
      targetId: recordings.oxyRecordingTargetId,
    })
    .from(recordings)
    .where(
      and(
        isNull(recordings.oxyFileId),
        eq(recordings.status, 'ready'),
        after === null ? undefined : gt(recordings.id, after),
      ),
    )
    .orderBy(asc(recordings.id))
    .limit(BATCH_SIZE);
  return rows.map((row) => ({
    kind: 'recordings',
    entity: { kind: 'recording', id: row.id },
    owner: { kind: 'application' },
    objectKey: row.targetId ? null : row.key,
    format: 'ogg',
    ...(row.targetId ? { recordingTargetId: row.targetId } : {}),
  }));
}

const INVENTORY: Record<AudioMigrationKind, (after: string | null) => Promise<AudioUnit[]>> = {
  tracks: trackUnits,
  uploads: uploadUnits,
  episodes: episodeUnits,
  enclosures: enclosureUnits,
  recordings: recordingUnits,
};

// ── One unit ─────────────────────────────────────────────────────────────────

function copiedLine(unit: AudioUnit, stored: StoredOxyAudio): AudioMigrationLine {
  return {
    kind: unit.kind,
    id: unit.entity.id,
    outcome: 'copied',
    fileId: stored.fileId,
    sha256: stored.sha256,
    size: stored.size,
    owner: unit.owner.kind,
  };
}

async function migrateUnit(
  unit: AudioUnit,
  options: AudioMigrationOptions,
): Promise<AudioMigrationLine> {
  const deps = options.deps ?? {};
  const base = { kind: unit.kind, id: unit.entity.id, owner: unit.owner.kind };

  if (unit.recordingTargetId) {
    if (!options.apply) return { ...base, outcome: 'would_copy' };
    const fileId = await (deps.collect ?? collectRecordingFile)(
      unit.entity.id,
      unit.recordingTargetId,
    );
    return fileId ? { ...base, outcome: 'collected', fileId } : { ...base, outcome: 'not_ready' };
  }

  if (!options.apply) return { ...base, outcome: 'would_copy' };

  if (unit.sourceUrl) {
    try {
      const stored = await (deps.importEnclosure ?? importEnclosureToOxy)(
        unit.entity.id,
        unit.sourceUrl,
      );
      return copiedLine(unit, stored);
    } catch {
      // The origin may be gone: the bucket's cached copy is uploaded instead.
    }
  }

  if (!unit.objectKey) return { ...base, outcome: 'missing_object' };
  const dir = mkdtempSync(join(tmpdir(), 'audio-to-oxy-'));
  try {
    const localPath = join(dir, `original.${unit.format}`);
    if (!(await (deps.stage ?? stageAudioObject)(unit.objectKey, localPath))) {
      return { ...base, outcome: 'missing_object' };
    }
    const stored = await (deps.store ?? storeAudioInOxy)({
      entity: unit.entity,
      localPath,
      mime: audioMimeFor(unit.format),
      owner: unit.owner,
      filename: `${unit.entity.id}.${unit.format}`,
    });
    return copiedLine(unit, stored);
  } catch (error) {
    const fields = errorFields(error);
    // A person Oxy does not know cannot own the file, and it is not Syra's.
    if (unit.owner.kind === 'account' && fields.status === 403) {
      return { ...base, outcome: 'owner_unknown', ...fields };
    }
    return { ...base, outcome: 'failed', ...fields };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── The run ──────────────────────────────────────────────────────────────────

export async function migrateAudioToOxy(
  options: AudioMigrationOptions,
): Promise<AudioMigrationStats> {
  const stats: AudioMigrationStats = {
    would_copy: 0,
    copied: 0,
    collected: 0,
    missing_object: 0,
    owner_unknown: 0,
    not_ready: 0,
    failed: 0,
  };
  const concurrency = Math.max(1, options.concurrency ?? 4);

  for (const kind of options.kinds ?? AUDIO_MIGRATION_KINDS) {
    let after: string | null = null;
    let seen = 0;
    for (;;) {
      let units = await INVENTORY[kind](after);
      if (units.length === 0) break;
      after = units[units.length - 1].entity.id;
      if (options.limit !== undefined) units = units.slice(0, options.limit - seen);
      for (let index = 0; index < units.length; index += concurrency) {
        const lines = await Promise.all(
          units.slice(index, index + concurrency).map((unit) => migrateUnit(unit, options)),
        );
        for (const line of lines) {
          stats[line.outcome] += 1;
          options.report(line);
        }
      }
      seen += units.length;
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
    const stats = await migrateAudioToOxy({
      apply,
      limit: flagValue('--limit'),
      concurrency: flagValue('--concurrency'),
      report: (line) => logger.info('[migrate-audio-to-oxy]', { ...line }),
    });
    logger.info(`[migrate-audio-to-oxy] ${apply ? 'applied' : 'preview (nothing written)'}`, {
      ...stats,
    });
    if (stats.failed > 0) process.exitCode = 1;
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('[migrate-audio-to-oxy] failed', { error: describeErrorSafely(error) });
    process.exit(1);
  });
}
