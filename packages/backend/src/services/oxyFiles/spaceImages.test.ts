import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import sharp from 'sharp';
import type { AddressInfo } from 'node:net';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { connectDb, clearDb, disconnectDb } from '../../test/postgres';
import { installFakeOxyFiles, resetOxyFiles, type FakeOxyFiles } from '../../test/fakeOxyFiles';
import {
  createHouse,
  updateHouse,
  addHouseMember,
  findHouseWithMembers,
} from '../../db/rooms/houses';
import { DEFAULT_HOUSE_VISIBILITY, HouseMemberRole } from '../../db/rooms/types';
import housesRoutes from '../../routes/houses.routes';
import { drainReferenceOutboxOnce } from './referenceOutbox';

let files: FakeOxyFiles;
beforeAll(connectDb);
beforeEach(() => {
  files = installFakeOxyFiles();
});
afterEach(async () => {
  resetOxyFiles();
  await clearDb();
});
afterAll(disconnectDb);

async function upload(houseId: string, accountId: string) {
  const app = express();
  app.use((req, _res, next) => {
    (req as OxyAuthRequest).user = { id: accountId };
    next();
  });
  app.use(housesRoutes);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#cc4400' },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'avatar.png');
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/${houseId}/avatar`,
      { method: 'POST', body: form },
    );
    return { status: response.status, body: (await response.json()) as { avatarFileId?: string } };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('space admin replaces a shared asset without acquiring or deleting personal owner files', async () => {
  const { house } = await createHouse({
    name: 'Shared house',
    createdBy: 'owner',
    visibility: DEFAULT_HOUSE_VISIBILITY,
    tags: [],
  });
  await addHouseMember(house.id, 'admin', HouseMemberRole.ADMIN);
  const old = files.seedFile({
    bytes: Buffer.from('historical-personal-image'),
    ownerUserId: 'owner',
    visibility: 'public',
  });
  await updateHouse(house.id, { avatarFileId: old.id });
  await drainReferenceOutboxOnce();
  expect(files.hasReference(old.id, 'house', house.id)).toBe(true);

  const response = await upload(house.id, 'admin');
  expect(response.status).toBe(200);
  const fileId = response.body.avatarFileId!;
  expect(files.files.get(fileId)?.ownerApplicationId).toBe(files.applicationId);
  expect(files.files.get(fileId)?.ownerUserId).toBeUndefined();
  expect(files.calls.some((call) => call.method === 'uploadUserMedia')).toBe(false);
  await drainReferenceOutboxOnce();
  expect(files.hasReference(old.id, 'house', house.id)).toBe(false);
  expect(files.hasReference(fileId, 'house', house.id)).toBe(true);
  expect(files.files.get(old.id)?.ownerUserId).toBe('owner');
  expect((await findHouseWithMembers(house.id))?.house.avatarFileId).toBe(fileId);
});

test('a local member without the existing admin role cannot upload a shared asset', async () => {
  const { house } = await createHouse({
    name: 'Private',
    createdBy: 'owner',
    visibility: DEFAULT_HOUSE_VISIBILITY,
    tags: [],
  });
  await addHouseMember(house.id, 'member', HouseMemberRole.MEMBER);
  expect((await upload(house.id, 'member')).status).toBe(403);
  expect(files.files.size).toBe(0);
});
