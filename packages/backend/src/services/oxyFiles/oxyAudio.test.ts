import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { FileEvent } from '@oxy.so/core/server';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { installFakeOxyFiles, resetOxyFiles, type FakeOxyFiles } from '../../test/fakeOxyFiles';
import { getDb } from '../../db/postgres';
import { applyFileEvent } from './fileEvents';
import {
  audioFileState,
  mirrorAudioToOxy,
  openPlaySession,
  oxyAudioMode,
  recordingPlaybackUrl,
  recordingStorage,
  revokePlaySessions,
  storeAudioInOxy,
} from './audioStorage';

/**
 * The Oxy half of the audio seam (ADR 0043 stage 4c), against an Oxy that keeps
 * its rules (`test/fakeOxyFiles.ts`): what a file becomes, who owns it, that
 * every use is referenced, that a play is a per-listener session — and that
 * every refusal, including an Oxy without stage 4c at all, leaves the legacy
 * path in charge.
 */

let fake: FakeOxyFiles;
let dir: string;

beforeAll(connectDb);
beforeEach(() => {
  fake = installFakeOxyFiles();
  fake.localUsers.add('owner');
  dir = mkdtempSync(join(tmpdir(), 'oxy-audio-test-'));
  process.env.OXY_AUDIO = 'dual';
});
afterEach(async () => {
  delete process.env.OXY_AUDIO;
  resetOxyFiles();
  rmSync(dir, { recursive: true, force: true });
  await clearDb();
});
afterAll(disconnectDb);

function original(name: string, contents = `audio-${name}`): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

async function seedRows(): Promise<void> {
  await getDb().execute(sql`
    insert into catalog_entities (id, type, name, name_key, source)
    values ('ce-1', 'artist', 'A', 'a', 'upload')
  `);
  await getDb().execute(sql`
    insert into tracks (id, title, artist_id, artist_name, duration, source)
    values ('track-1', 'T', 'ce-1', 'A', 1, 'upload')
  `);
  await getDb().execute(sql`
    insert into user_uploads (id, owner_oxy_user_id, title, duration, size_bytes, sha256)
    values ('upload-1', 'owner', 'U', 1, 1, ${'a'.repeat(64)})
  `);
}

async function queuedOps(): Promise<Array<{ entity_type: string; entity_id: string; op: string }>> {
  return [
    ...(await getDb().execute<{ entity_type: string; entity_id: string; op: string }>(sql`
      select entity_type, entity_id, op from oxy_file_reference_ops order by entity_type
    `)),
  ];
}

describe('OXY_AUDIO', () => {
  it('defaults to legacy, and only names its three modes', () => {
    delete process.env.OXY_AUDIO;
    expect(oxyAudioMode()).toBe('legacy');
    process.env.OXY_AUDIO = 'everything';
    expect(oxyAudioMode()).toBe('legacy');
    process.env.OXY_AUDIO = 'oxy';
    expect(oxyAudioMode()).toBe('oxy');
  });
});

describe('storing audio', () => {
  it("stores the catalogue as Syra's private file, verified, and references it from the row", async () => {
    await seedRows();
    const stored = await storeAudioInOxy({
      entity: { kind: 'track', id: 'track-1' },
      localPath: original('t.mp3'),
      mime: 'audio/mpeg',
      owner: { kind: 'application' },
    });

    const file = fake.files.get(stored.fileId)!;
    expect(file.ownerApplicationId).toBe(fake.applicationId);
    expect(file.visibility).toBe('private');
    expect(await audioFileState(stored.fileId)).toEqual({ status: 'active', hlsReadyAt: null });
    expect(await queuedOps()).toEqual([
      { entity_type: 'track_audio', entity_id: 'track-1', op: 'add' },
    ]);
  });

  it("stores a locker file in its owner's account, private", async () => {
    await seedRows();
    const stored = await storeAudioInOxy({
      entity: { kind: 'user_upload', id: 'upload-1' },
      localPath: original('u.flac'),
      mime: 'audio/flac',
      owner: { kind: 'account', oxyUserId: 'owner' },
    });
    const file = fake.files.get(stored.fileId)!;
    expect(file.ownerUserId).toBe('owner');
    expect(file.visibility).toBe('private');
  });

  it('answers null — the legacy path keeps the file — in legacy mode and on any refusal', async () => {
    await seedRows();
    const input = {
      entity: { kind: 'track' as const, id: 'track-1' },
      localPath: original('t.mp3'),
      mime: 'audio/mpeg',
      owner: { kind: 'application' as const },
    };

    delete process.env.OXY_AUDIO;
    expect(await mirrorAudioToOxy(input)).toBeNull();
    expect(fake.calls).toEqual([]);

    // An Oxy without stage 4c refuses audio (415).
    process.env.OXY_AUDIO = 'dual';
    fake.audio = false;
    expect(await mirrorAudioToOxy(input)).toBeNull();

    const [row] = await getDb().execute<{ audio_file_id: string | null }>(
      sql`select audio_file_id from tracks where id = 'track-1'`,
    );
    expect(row?.audio_file_id).toBeNull();
  });
});

describe('play sessions', () => {
  async function storedTrack(): Promise<string> {
    await seedRows();
    const stored = await storeAudioInOxy({
      entity: { kind: 'track', id: 'track-1' },
      localPath: original('t.mp3'),
      mime: 'audio/mpeg',
      owner: { kind: 'application' },
    });
    return stored.fileId;
  }

  it("opens an AES-128 session whose key Syra's webhook authorizes, once the ladder is ready", async () => {
    const fileId = await storedTrack();
    expect(await openPlaySession({ fileId, endUserId: 'listener' })).toEqual({
      ok: false,
      reason: 'not_ready',
    });

    fake.renderLadder(fileId);
    const result = await openPlaySession({ fileId, endUserId: 'listener', durationSec: 7200 });
    expect(result.ok).toBe(true);
    const [, options] = fake.calls.filter((c) => c.method === 'streams.create').at(-1)!.args as [
      string,
      Record<string, unknown>,
    ];
    expect(options).toEqual({
      endUserId: 'listener',
      ttlSeconds: 10_800,
      encryption: 'aes-128',
      keyAuthorization: 'webhook',
    });
    expect((await audioFileState(fileId))?.hlsReadyAt).not.toBeNull();
  });

  it('refuses a withdrawn file outright, and answers unavailable when Oxy has no 4c', async () => {
    const fileId = await storedTrack();
    fake.renderLadder(fileId);

    fake.audio = false;
    expect(await openPlaySession({ fileId, endUserId: 'listener' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });

    fake.audio = true;
    const event: FileEvent = {
      id: 'evt-1',
      type: 'file.blocked',
      occurredAt: new Date().toISOString(),
      file: { id: fileId, ownerKind: 'application', visibility: 'private', status: 'blocked' },
      references: [],
    };
    expect((await applyFileEvent(event)).audioFiles).toBe(1);
    expect(await openPlaySession({ fileId, endUserId: 'listener' })).toEqual({
      ok: false,
      reason: 'withdrawn',
    });
  });

  it('revokes every session of a file', async () => {
    const fileId = await storedTrack();
    fake.renderLadder(fileId);
    await openPlaySession({ fileId, endUserId: 'a' });
    await openPlaySession({ fileId, endUserId: 'b' });
    expect(await revokePlaySessions({ fileId })).toBe(2);
  });
});

describe('room recordings', () => {
  it('records into an Oxy target, and plays the collected file', async () => {
    const storage = await recordingStorage({
      roomId: 'room-1',
      recordingId: 'rec-1',
      maxDurationSec: 3600,
    });
    expect(storage.oxyRecordingTargetId).not.toBeNull();
    expect(storage.s3.endpoint).toBe('https://api.oxy.test/assets/recording-ingest');

    await getDb().execute(sql`
      insert into recordings (id, room_title, host, egress_id, object_key, started_at, expires_at, oxy_recording_target_id, status)
      values ('rec-1', 'R', 'host', 'eg-1', ${storage.objectKey}, now(), now(), ${storage.oxyRecordingTargetId}, 'ready')
    `);
    const recording = {
      id: 'rec-1',
      objectKey: storage.objectKey,
      oxyFileId: null,
      oxyRecordingTargetId: storage.oxyRecordingTargetId,
    };

    // Egress has not written it yet.
    expect(await recordingPlaybackUrl(recording)).toBeNull();

    const fileId = await fake.writeRecording(storage.oxyRecordingTargetId!, Buffer.from('ogg'));
    expect(await recordingPlaybackUrl(recording)).toBe(`https://download.oxy.test/${fileId}?sig=x`);
    const [row] = await getDb().execute<{ oxy_file_id: string }>(
      sql`select oxy_file_id from recordings where id = 'rec-1'`,
    );
    expect(row?.oxy_file_id).toBe(fileId);
    expect(fake.hasReference(fileId, 'recording', 'rec-1')).toBe(true);
  });

  it('records into the bucket in legacy mode, and when Oxy has no recording targets', async () => {
    delete process.env.OXY_AUDIO;
    const legacy = await recordingStorage({ roomId: 'r', recordingId: 'x', maxDurationSec: 60 });
    expect(legacy).toMatchObject({
      objectKey: 'agora/recordings/r/x.ogg',
      oxyRecordingTargetId: null,
    });

    process.env.OXY_AUDIO = 'oxy';
    fake.audio = false;
    const refused = await recordingStorage({ roomId: 'r', recordingId: 'y', maxDurationSec: 60 });
    expect(refused).toMatchObject({
      objectKey: 'agora/recordings/r/y.ogg',
      oxyRecordingTargetId: null,
    });
  });
});
