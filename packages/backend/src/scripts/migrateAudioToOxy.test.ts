import type { OxyAuthRequest } from '@oxy.so/core/server';
import {
  verifiedAudioSession,
  installFileTaskAuthorityFixture,
  resetFileTaskAuthorityFixture,
} from '../test/fileTaskAuthority';
import { createFileTask } from '../services/oxyFiles/taskAuthority';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { installFakeOxyFiles, resetOxyFiles, type FakeOxyFiles } from '../test/fakeOxyFiles';
import { getDb } from '../db/postgres';
import { migrateAudioToOxy, type AudioMigrationLine } from './migrateAudioToOxy';
import {
  retireLegacyAudioLadders,
  RetirementRefused,
  type LadderLine,
} from './retireLegacyAudioLadders';

/**
 * The audio backfill (ADR 0043 stage 4c) and the legacy-ladder retirement that
 * follows it: a preview writes nothing, `--apply` stores every kind of audio as
 * the right owner's private Oxy file and points the row at it, a re-run finds
 * nothing left, and a ladder is retired only once Oxy confirmed its own.
 */

let fake: FakeOxyFiles;
/** The bucket, as the backfill reads it: object key → bytes. */
const bucket = new Map<string, string>();

async function stage(key: string, localPath: string): Promise<boolean> {
  const bytes = bucket.get(key);
  if (bytes === undefined) return false;
  writeFileSync(localPath, bytes);
  return true;
}

beforeAll(connectDb);
beforeEach(() => {
  installFileTaskAuthorityFixture();
  fake = installFakeOxyFiles();
  fake.localUsers.add('owner');
  fake.localUsers.add('host');
  bucket.clear();
});
afterEach(async () => {
  resetFileTaskAuthorityFixture();
  delete process.env.OXY_AUDIO;
  resetOxyFiles();
  await clearDb();
});
afterAll(disconnectDb);

async function seed(): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    insert into catalog_entities (id, type, name, name_key, source)
    values ('ce-1', 'artist', 'A', 'a', 'upload')
  `);
  await db.execute(sql`
    insert into tracks (id, title, artist_id, artist_name, duration, source, audio_source_url, audio_source_format, hls_master_key)
    values ('track-1', 'T', 'ce-1', 'A', 1, 'upload', '/api/audio/track-1', 'mp3', 'hls/ce-1/track-1/master.m3u8'),
           ('track-gone', 'T', 'ce-1', 'A', 1, 'upload', '/api/audio/track-gone', 'mp3', null)
  `);
  bucket.set('audio/ce-1/track-1.mp3', 'track one');
  await db.execute(sql`
    insert into user_uploads (id, owner_oxy_user_id, title, duration, size_bytes, sha256, audio_source_key, audio_source_format)
    values ('upload-1', 'owner', 'U', 1, 1, ${'a'.repeat(64)}, 'uploads/owner/upload-1.flac', 'flac'),
           ('upload-stranger', 'nobody-oxy-knows', 'U', 1, 1, ${'b'.repeat(64)}, 'uploads/x/upload-stranger.flac', 'flac')
  `);
  bucket.set('uploads/owner/upload-1.flac', 'locker one');
  bucket.set('uploads/x/upload-stranger.flac', 'locker two');
  await db.execute(sql`
    insert into podcasts (id, title, source, visibility, owner_oxy_user_id)
    values ('show-1', 'P', 'syra', 'public', 'host'), ('feed-1', 'F', 'rss', 'public', null)
  `);
  await db.execute(sql`
    insert into episodes (id, podcast_id, podcast_title, title, guid, pub_date, source, audio_source_url, audio_source_format)
    values ('ep-hosted', 'show-1', 'P', 'E', 'g1', now(), 'syra', '/x', 'mp3')
  `);
  bucket.set('podcasts/audio/show-1/ep-hosted.mp3', 'episode one');
  await db.execute(sql`
    insert into episodes (id, podcast_id, podcast_title, title, guid, pub_date, source, enclosure_url, cache_status, cache_object_key)
    values ('ep-rss', 'feed-1', 'F', 'E', 'g2', now(), 'rss', 'https://feeds.test/ep.mp3', 'cached', 'podcasts/cache/feed-1/ep-rss.mp3'),
           ('ep-rss-dead', 'feed-1', 'F', 'E', 'g3', now(), 'rss', 'https://gone.test/ep.mp3', 'cached', 'podcasts/cache/feed-1/ep-rss-dead.mp3')
  `);
  fake.remote.set('https://feeds.test/ep.mp3', {
    bytes: Buffer.from('enclosure'),
    mime: 'audio/mpeg',
  });
  bucket.set('podcasts/cache/feed-1/ep-rss-dead.mp3', 'cached enclosure');
  await db.execute(sql`
    insert into recordings (id, room_title, host, egress_id, object_key, started_at, expires_at, status)
    values ('rec-1', 'R', 'host', 'eg-1', 'agora/recordings/r/rec-1.ogg', now(), now(), 'ready')
  `);
  bucket.set('agora/recordings/r/rec-1.ogg', 'recording one');
}

async function run(apply: boolean): Promise<AudioMigrationLine[]> {
  const lines: AudioMigrationLine[] = [];
  await migrateAudioToOxy({ apply, report: (line) => lines.push(line), deps: { stage } });
  return lines.sort((a, b) => a.id.localeCompare(b.id));
}

describe('migrateAudioToOxy', () => {
  it('previews every kind without writing anything', async () => {
    await seed();
    const lines = await run(false);
    expect(lines.every((line) => line.outcome === 'would_copy')).toBe(true);
    expect(lines).toHaveLength(8);
    expect(fake.files.size).toBe(0);
  });

  it('copies each kind with original personal admission proof, and a re-run finds nothing left', async () => {
    await seed();
    const requester = {} as OxyAuthRequest;
    verifiedAudioSession(requester, 'owner');
    const uploadTask = await createFileTask(requester, 'upload-1');
    verifiedAudioSession(requester, 'host');
    const episodeTask = await createFileTask(requester, 'ep-hosted');
    await getDb().execute(
      sql`update user_uploads set oxy_task_id = ${uploadTask} where id = 'upload-1'`,
    );
    await getDb().execute(
      sql`update episodes set oxy_task_id = ${episodeTask} where id = 'ep-hosted'`,
    );
    const outcomes = Object.fromEntries((await run(true)).map((line) => [line.id, line]));

    expect(outcomes['track-1']).toMatchObject({ outcome: 'copied', owner: 'application' });
    expect(outcomes['track-gone']).toMatchObject({ outcome: 'missing_object' });
    expect(outcomes['upload-1']).toMatchObject({ outcome: 'copied', owner: 'account' });
    expect(outcomes['upload-stranger']).toMatchObject({
      outcome: 'failed',
      error: 'Personal audio copy awaits original requester authority',
    });
    expect(outcomes['ep-hosted']).toMatchObject({ outcome: 'copied', owner: 'account' });
    expect(outcomes['ep-rss']).toMatchObject({ outcome: 'copied', owner: 'application' });
    expect(outcomes['ep-rss-dead']).toMatchObject({ outcome: 'copied', owner: 'application' });
    expect(outcomes['rec-1']).toMatchObject({ outcome: 'copied', owner: 'application' });

    const upload = fake.files.get(outcomes['upload-1'].fileId!)!;
    expect(upload).toMatchObject({ ownerUserId: 'owner', visibility: 'private' });
    expect(fake.files.get(outcomes['ep-hosted'].fileId!)!.ownerUserId).toBe('host');
    // The live enclosure was imported by URL; the dead one uploaded from the cache.
    expect(fake.calls.filter((call) => call.method === 'importAppFile')).toHaveLength(2);

    const ops = await getDb().execute<{ entity_type: string; entity_id: string }>(sql`
      select entity_type, entity_id from oxy_file_reference_ops order by entity_id
    `);
    expect([...ops].map((op) => `${op.entity_type}:${op.entity_id}`)).toEqual([
      'episode_audio:ep-hosted',
      'episode_audio:ep-rss',
      'episode_audio:ep-rss-dead',
      'recording:rec-1',
      'track_audio:track-1',
      'user_upload_audio:upload-1',
    ]);

    const again = await run(true);
    expect(again.map((line) => `${line.id}:${line.outcome}`)).toEqual([
      'track-gone:missing_object',
      'upload-stranger:failed',
    ]);
  });

  it('retains historical personal audio without inventing authority from its owner', async () => {
    await seed();
    const outcomes = Object.fromEntries((await run(true)).map((line) => [line.id, line]));
    for (const id of ['upload-1', 'ep-hosted']) {
      expect(outcomes[id]).toMatchObject({
        outcome: 'failed',
        error: 'Personal audio copy awaits original requester authority',
      });
    }
    const [upload] = await getDb().execute(
      sql`select audio_file_id, oxy_task_id, audio_source_key from user_uploads where id = 'upload-1'`,
    );
    const [episode] = await getDb().execute(
      sql`select audio_file_id, oxy_task_id, audio_source_url from episodes where id = 'ep-hosted'`,
    );
    expect(upload).toMatchObject({
      audio_file_id: null,
      oxy_task_id: null,
      audio_source_key: 'uploads/owner/upload-1.flac',
    });
    expect(episode).toMatchObject({
      audio_file_id: null,
      oxy_task_id: null,
      audio_source_url: '/x',
    });
    expect(outcomes['track-1']).toMatchObject({ outcome: 'copied', owner: 'application' });
    expect(fake.calls.some((call) => call.method === 'uploadUserMedia')).toBe(false);
  });

  it('changes nothing when Oxy has no stage 4c: every unit fails, every row keeps its legacy path', async () => {
    await seed();
    fake.audio = false;
    const lines = await run(true);
    expect(lines.filter((line) => line.outcome === 'copied')).toEqual([]);
    const [row] = await getDb().execute<{ n: number }>(
      sql`select count(*)::int as n from tracks where audio_file_id is not null`,
    );
    expect(row?.n).toBe(0);
  });
});

describe('retireLegacyAudioLadders', () => {
  async function report(apply: boolean, deleted: string[]): Promise<LadderLine[]> {
    const lines: LadderLine[] = [];
    await retireLegacyAudioLadders({
      apply,
      report: (line) => lines.push(line),
      deps: {
        deletePrefix: async (prefix) => {
          deleted.push(prefix);
          return 3;
        },
        deleteObject: async (key) => {
          deleted.push(key);
        },
      },
    });
    return lines;
  }

  it('refuses to apply unless OXY_AUDIO=oxy', async () => {
    process.env.OXY_AUDIO = 'dual';
    await expect(report(true, [])).rejects.toBeInstanceOf(RetirementRefused);
  });

  it('retires a ladder only once Oxy confirmed its own, keeping the original', async () => {
    await seed();
    await run(true);
    process.env.OXY_AUDIO = 'oxy';

    const deleted: string[] = [];
    expect((await report(true, deleted)).map((line) => line.outcome)).toEqual(['oxy_not_ready']);
    expect(deleted).toEqual([]);

    const [track] = await getDb().execute<{ audio_file_id: string }>(
      sql`select audio_file_id from tracks where id = 'track-1'`,
    );
    fake.renderLadder(track!.audio_file_id);
    expect((await report(false, deleted)).map((line) => line.outcome)).toEqual(['would_retire']);
    expect((await report(true, deleted)).map((line) => line.outcome)).toEqual(['retired']);
    expect(deleted).toEqual(['hls/ce-1/track-1/', 'previews/track-1/0.mp3']);

    const [after] = await getDb().execute<{ hls_master_key: string | null }>(
      sql`select hls_master_key from tracks where id = 'track-1'`,
    );
    expect(after?.hls_master_key).toBeNull();
  });
});
