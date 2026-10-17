import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { sql } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { createOxyFilesWebhookRoutes } from '../../routes/oxyFilesWebhook.routes';
import { authorizeAudioKey } from './audioKeyAuthorization';

/**
 * A play session's AES-128 key is released only when Syra says so (ADR 0043
 * stage 4c, `stream.key_authorization`) — and Syra says so on exactly the
 * entitlement its legacy key endpoints enforce. Every case here is one a
 * listener could otherwise use to hear what they may not.
 */

beforeAll(connectDb);
afterEach(async () => {
  delete process.env.OXY_FILES_WEBHOOK_SECRET;
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
    insert into tracks (id, title, artist_id, artist_name, duration, source, audio_file_id)
    values ('track-ok', 'T', 'ce-1', 'A', 1, 'upload', 'F-track'),
           ('track-down', 'T', 'ce-1', 'A', 1, 'upload', 'F-taken-down')
  `);
  await db.execute(sql`update tracks set copyright_removed = true where id = 'track-down'`);
  await db.execute(sql`
    insert into user_uploads (id, owner_oxy_user_id, title, duration, size_bytes, sha256, audio_file_id)
    values ('upload-1', 'owner', 'U', 1, 1, ${'a'.repeat(64)}, 'F-locker'),
           ('upload-gone', 'owner', 'U', 1, 1, ${'b'.repeat(64)}, 'F-deleted-locker')
  `);
  await db.execute(sql`update user_uploads set deleted_at = now() where id = 'upload-gone'`);
  await db.execute(sql`
    insert into podcasts (id, title, source, visibility, owner_oxy_user_id)
    values ('show-public', 'P', 'syra', 'public', 'host'),
           ('show-private', 'P', 'syra', 'private', 'host')
  `);
  await db.execute(sql`
    insert into episodes (id, podcast_id, podcast_title, title, guid, pub_date, source, audio_file_id)
    values ('ep-public', 'show-public', 'P', 'E', 'g1', now(), 'syra', 'F-public-episode'),
           ('ep-private', 'show-private', 'P', 'E', 'g2', now(), 'syra', 'F-private-episode')
  `);
  await db.execute(sql`
    insert into oxy_audio_files (file_id, status, owner_kind, mime)
    values ('F-track', 'active', 'application', 'audio/mpeg'),
           ('F-blocked', 'blocked', 'application', 'audio/mpeg')
  `);
}

describe('authorizeAudioKey', () => {
  it('releases a playable catalogue track to a signed-in listener, never to nobody', async () => {
    await seed();
    expect(await authorizeAudioKey({ fileId: 'F-track', endUserId: 'listener' })).toBe(true);
    expect(await authorizeAudioKey({ fileId: 'F-track', endUserId: null })).toBe(false);
  });

  it('refuses a taken-down track, and a file Oxy reported withdrawn', async () => {
    await seed();
    expect(await authorizeAudioKey({ fileId: 'F-taken-down', endUserId: 'listener' })).toBe(false);
    await getDb().execute(sql`update tracks set audio_file_id = 'F-blocked' where id = 'track-ok'`);
    expect(await authorizeAudioKey({ fileId: 'F-blocked', endUserId: 'listener' })).toBe(false);
  });

  it("releases a locker file to its owner alone, and nobody's once it is deleted", async () => {
    await seed();
    expect(await authorizeAudioKey({ fileId: 'F-locker', endUserId: 'owner' })).toBe(true);
    expect(await authorizeAudioKey({ fileId: 'F-locker', endUserId: 'stranger' })).toBe(false);
    expect(await authorizeAudioKey({ fileId: 'F-deleted-locker', endUserId: 'owner' })).toBe(false);
  });

  it("releases a public show's episode to a listener, a private show's to its owner only", async () => {
    await seed();
    expect(await authorizeAudioKey({ fileId: 'F-public-episode', endUserId: 'listener' })).toBe(
      true,
    );
    expect(await authorizeAudioKey({ fileId: 'F-private-episode', endUserId: 'host' })).toBe(true);
    expect(await authorizeAudioKey({ fileId: 'F-private-episode', endUserId: 'listener' })).toBe(
      false,
    );
  });

  it('fails closed for a file no row uses', async () => {
    await seed();
    expect(await authorizeAudioKey({ fileId: 'F-unknown', endUserId: 'listener' })).toBe(false);
  });
});

describe('POST /webhooks/oxy/files — stream.key_authorization', () => {
  const SECRET = 'whsec_test_secret';
  let base = '';
  let close: () => void = () => {};

  beforeAll(async () => {
    const app = express();
    app.use('/webhooks/oxy/files', createOxyFilesWebhookRoutes());
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  function request(fileId: string, endUserId: string | null): string {
    return JSON.stringify({
      id: `kar-${Math.random().toString(36).slice(2)}`,
      type: 'stream.key_authorization',
      occurredAt: new Date().toISOString(),
      session: {
        id: 'session-1',
        fileId,
        endUserId,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
  }

  function headers(body: string, secret = SECRET) {
    const at = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
    return {
      'content-type': 'application/json',
      'oxy-event-type': 'stream.key_authorization',
      'oxy-event-id': 'kar-1',
      'oxy-signature': `t=${at},v1=${v1}`,
    };
  }

  async function post(body: string, secret?: string): Promise<Response> {
    return fetch(`${base}/webhooks/oxy/files`, {
      method: 'POST',
      headers: headers(body, secret),
      body,
    });
  }

  it('answers { allow: true } for an entitled listener and { allow: false } otherwise', async () => {
    process.env.OXY_FILES_WEBHOOK_SECRET = SECRET;
    await seed();

    const allowed = await post(request('F-locker', 'owner'));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ allow: true });

    const denied = await post(request('F-locker', 'stranger'));
    expect(denied.status).toBe(200);
    expect(await denied.json()).toEqual({ allow: false });
  });

  it('refuses a forged request (a non-2xx, which Oxy reads as a denial)', async () => {
    process.env.OXY_FILES_WEBHOOK_SECRET = SECRET;
    await seed();
    const forged = await post(request('F-locker', 'owner'), 'whsec_wrong');
    expect(forged.status).toBe(401);
  });

  it('is absent (404) while the endpoint has no secret', async () => {
    await seed();
    const res = await post(request('F-locker', 'owner'));
    expect(res.status).toBe(404);
  });
});
