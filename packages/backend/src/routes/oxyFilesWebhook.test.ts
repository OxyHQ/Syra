import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { eq, sql } from 'drizzle-orm';
import type { FileEvent } from '@oxy.so/core/server';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { imageAssets } from '../db/schema/catalog';
import { houses } from '../db/schema/rooms';
import { applyFileEvent, servingStatusAfter } from '../services/oxyFiles/fileEvents';
import { resolveImageAsset } from '../services/imageAssetService';
import { createOxyFilesWebhookRoutes } from './oxyFilesWebhook.routes';

/**
 * Oxy's file events reach Syra and change what Syra serves (ADR 0043 D9): a
 * takedown stops the image at once, a restore brings it back, a duplicate
 * delivery does nothing twice — and the receiver verifies the RAW bytes, so it
 * must sit before the JSON parser.
 */

beforeAll(connectDb);
afterEach(async () => {
  delete process.env.OXY_FILES_WEBHOOK_SECRET;
  await clearDb();
});
afterAll(disconnectDb);

const SECRET = 'whsec_test_secret';

function event(
  type: FileEvent['type'],
  fileId: string,
  overrides: Partial<FileEvent['file']> = {},
): FileEvent {
  return {
    id: `evt-${type}-${fileId}-${Math.random().toString(36).slice(2)}`,
    type,
    occurredAt: new Date().toISOString(),
    file: {
      id: fileId,
      ownerKind: 'application',
      visibility: 'public',
      status: 'active',
      ...overrides,
    },
    references: [],
  };
}

async function imageRow(fileId: string): Promise<string> {
  const [row] = await getDb()
    .insert(imageAssets)
    .values({
      oxyFileId: fileId,
      filename: 'f',
      contentType: 'image/png',
      byteSize: 1,
      ownerType: 'album',
    })
    .returning({ id: imageAssets.id });
  return row!.id;
}

describe('servingStatusAfter', () => {
  it('maps each event to whether the file may be served', () => {
    expect(servingStatusAfter(event('file.blocked', 'f', { status: 'blocked' }))).toBe('blocked');
    expect(servingStatusAfter(event('file.deleted', 'f', { status: 'deleted' }))).toBe(
      'unavailable',
    );
    expect(servingStatusAfter(event('file.trashed', 'f', { status: 'trash' }))).toBe('unavailable');
    expect(servingStatusAfter(event('file.restored', 'f'))).toBe('active');
    expect(servingStatusAfter(event('file.unblocked', 'f'))).toBe('active');
    expect(
      servingStatusAfter(event('file.visibility_changed', 'f', { visibility: 'private' })),
    ).toBe('unavailable');
    expect(
      servingStatusAfter(event('file.visibility_changed', 'f', { visibility: 'unlisted' })),
    ).toBe('active');
  });
});

describe('applyFileEvent', () => {
  it('stops serving a blocked file at once, and serves it again when unblocked', async () => {
    const id = await imageRow('file-1');
    await applyFileEvent(event('file.blocked', 'file-1', { status: 'blocked' }));
    expect(await resolveImageAsset(id)).toEqual({ kind: 'unavailable' });

    await applyFileEvent(event('file.unblocked', 'file-1'));
    expect((await resolveImageAsset(id))?.kind).toBe('oxy');
  });

  it('applies an event once however often it is delivered', async () => {
    await imageRow('file-1');
    const blocked = event('file.blocked', 'file-1', { status: 'blocked' });
    expect((await applyFileEvent(blocked)).duplicate).toBe(false);
    // Unblocked meanwhile; a redelivery of the OLD event must not block it again.
    await applyFileEvent(event('file.unblocked', 'file-1'));
    expect((await applyFileEvent(blocked)).duplicate).toBe(true);
    const [row] = await getDb()
      .select()
      .from(imageAssets)
      .where(eq(imageAssets.oxyFileId, 'file-1'));
    expect(row?.servingStatus).toBe('active');
  });

  it("lets go of a deleted file in a house's columns, and keeps a trashed one for a restore", async () => {
    await getDb().execute(sql`
      insert into houses (id, name, created_by, avatar_file_id, cover_image_file_id)
      values ('h-1', 'H', 'u', 'trashed', 'deleted')
    `);
    await applyFileEvent(
      event('file.trashed', 'trashed', { status: 'trash', ownerKind: 'account' }),
    );
    await applyFileEvent(
      event('file.deleted', 'deleted', { status: 'deleted', ownerKind: 'account' }),
    );
    const [house] = await getDb().select().from(houses).where(eq(houses.id, 'h-1'));
    expect(house).toMatchObject({ avatarFileId: 'trashed', coverImageFileId: null });
  });
});

describe('POST /webhooks/oxy/files', () => {
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

  function signed(body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)) {
    const v1 = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
    return { 'content-type': 'application/json', 'oxy-signature': `t=${at},v1=${v1}` };
  }

  it('echoes the registration challenge, even before the secret is configured', async () => {
    const res = await fetch(`${base}/webhooks/oxy/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'webhook.challenge', challenge: 'abc' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc' });
  });

  it('is absent (404) for anything else while unconfigured', async () => {
    const body = JSON.stringify(event('file.blocked', 'file-1'));
    const res = await fetch(`${base}/webhooks/oxy/files`, {
      method: 'POST',
      headers: signed(body),
      body,
    });
    expect(res.status).toBe(404);
  });

  it('applies a correctly signed event and refuses a forged one', async () => {
    process.env.OXY_FILES_WEBHOOK_SECRET = SECRET;
    const id = await imageRow('file-1');
    const body = JSON.stringify(event('file.blocked', 'file-1', { status: 'blocked' }));

    const forged = await fetch(`${base}/webhooks/oxy/files`, {
      method: 'POST',
      headers: signed(body, 'whsec_wrong'),
      body,
    });
    expect(forged.status).toBe(401);
    expect((await resolveImageAsset(id))?.kind).toBe('oxy');

    const res = await fetch(`${base}/webhooks/oxy/files`, {
      method: 'POST',
      headers: signed(body),
      body,
    });
    expect(res.status).toBe(204);
    expect(await resolveImageAsset(id)).toEqual({ kind: 'unavailable' });

    const again = await fetch(`${base}/webhooks/oxy/files`, {
      method: 'POST',
      headers: signed(body),
      body,
    });
    expect(again.status).toBe(200);
  });

  it('refuses to verify a body a JSON parser already consumed', async () => {
    process.env.OXY_FILES_WEBHOOK_SECRET = SECRET;
    const app = express();
    app.use(express.json());
    app.use('/webhooks/oxy/files', createOxyFilesWebhookRoutes());
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const body = JSON.stringify(event('file.blocked', 'file-1'));
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/oxy/files`, {
      method: 'POST',
      headers: signed(body),
      body,
    });
    server.close();
    expect(res.status).toBe(500);
  });
});
