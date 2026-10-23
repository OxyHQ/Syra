import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { OxyServer, type OxyAuthRequest } from '@oxy.so/core/server';
import { accountActorChainSchema } from '@oxy.so/contracts';
import { eq } from 'drizzle-orm';
import { connectDb, clearDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { episodes, podcasts } from '../../db/schema/podcasts';
import { userUploads } from '../../db/schema/creators';
import { oxyFileTaskRevocations } from '../../db/schema/oxyFiles';
import {
  refreshLockerFileTask,
  createFileTask,
  withFileTask,
  setFileTaskAuthorityForTests,
  personalAudioRequester,
  drainFileTaskRevocations,
} from './taskAuthority';

let server: ReturnType<typeof Bun.serve>;
let client: OxyServer;
let revoked = false;
let wrongAccount = false;
let failRevoke = false;
const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const req = {
  user: { id: 'organization' },
  accessToken: 'real-original-session',
  oxyActor: accountActorChainSchema.parse({
    schemaVersion: 1,
    effectiveAccountId: 'organization',
    actorAccountId: 'human',
    delegated: true,
  }),
} as OxyAuthRequest;

beforeAll(async () => {
  await connectDb();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/challenge')) return Response.json({ nonce: 'fixture' });
      if (path === '/auth/service-token/workload') {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.protocolVersion).toBe(2);
        expect(body).not.toHaveProperty('scopes');
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          token: `e30.${Buffer.from(JSON.stringify({ exp: now + 300 })).toString('base64url')}.fixture`,
          expiresIn: 300,
        });
      }
      expect(request.headers.get('authorization')).toStartWith('Bearer ');
      if (request.method === 'DELETE') {
        calls.push({ path, body: {} });
        return failRevoke ? Response.json({ error: 'outage' }, { status: 503 }) : Response.json({});
      }
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ path, body });
      if (revoked || body.subjectToken !== req.accessToken)
        return Response.json({ error: 'session_revoked' }, { status: 403 });
      return Response.json({
        task: {
          id: 'original-task',
          requesterAccountId: 'human',
          effectiveAccountId: wrongAccount ? 'another-account' : 'organization',
        },
      });
    },
  });
  client = new OxyServer({
    baseURL: server.url.origin,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIA_TEST',
      SecretAccessKey: 'fixture',
      Token: 'temporary',
    }),
  });
  setFileTaskAuthorityForTests(client.agency);
});
beforeEach(() => {
  revoked = false;
  wrongAccount = false;
  failRevoke = false;
  calls.length = 0;
});
afterEach(clearDb);
afterAll(async () => {
  setFileTaskAuthorityForTests(null);
  client.dispose();
  server.stop(true);
  await disconnectDb();
});

async function revocations() {
  return getDb()
    .select({ taskId: oxyFileTaskRevocations.taskId, attempts: oxyFileTaskRevocations.attempts })
    .from(oxyFileTaskRevocations);
}
async function episode() {
  await getDb()
    .insert(podcasts)
    .values({ id: 'show', title: 'Show', source: 'syra', ownerOxyUserId: 'organization' });
  await getDb().insert(episodes).values({
    id: 'episode',
    podcastId: 'show',
    podcastTitle: 'Show',
    title: 'Episode',
    guid: 'guid',
    source: 'syra',
    pubDate: new Date(),
    oxyTaskId: 'original-task',
  });
}

test('managed account admission records the human requester separately from the resource account', async () => {
  expect(await createFileTask(req, 'episode')).toBe('original-task');
  expect(calls[0]).toMatchObject({
    path: '/capabilities/tasks',
    body: {
      origin: { kind: 'goal', id: 'syra-audio:episode' },
      actor: { type: 'requester', accountId: 'human' },
      effectiveAccountId: 'organization',
      subjectToken: req.accessToken,
    },
  });
});
test('revoked original session cannot be replaced by the workload or row owner', async () => {
  revoked = true;
  await expect(createFileTask(req, 'episode')).rejects.toThrow();
  expect(await revocations()).toEqual([]);
});
test('wrong-account task and failed domain insert both retain durable revocation', async () => {
  wrongAccount = true;
  await expect(createFileTask(req, 'episode')).rejects.toThrow('different audio requester');
  expect(await revocations()).toEqual([{ taskId: 'original-task', attempts: 0 }]);
  await clearDb();
  wrongAccount = false;
  await expect(
    withFileTask(req, 'episode', async () => {
      throw new Error('insert failed');
    }),
  ).rejects.toThrow('insert failed');
  expect(await revocations()).toEqual([{ taskId: 'original-task', attempts: 0 }]);
});
test('show cascade queues revocation without losing IDs during an Oxy outage', async () => {
  await episode();
  expect(await personalAudioRequester('episode', 'episode', 'organization')).toEqual({
    taskId: 'original-task',
    accountId: 'organization',
  });
  expect(await personalAudioRequester('episode', 'episode', 'another-account')).toBeNull();
  await getDb().delete(podcasts).where(eq(podcasts.id, 'show'));
  expect(await revocations()).toEqual([{ taskId: 'original-task', attempts: 0 }]);
  failRevoke = true;
  await drainFileTaskRevocations();
  expect((await revocations())[0]?.attempts).toBe(1);
  failRevoke = false;
  await getDb()
    .update(oxyFileTaskRevocations)
    .set({ nextAttemptAt: new Date(0) });
  await drainFileTaskRevocations();
  expect(await revocations()).toEqual([]);
});
test('replacing an upload task queues only the old handle and never exposes another account', async () => {
  await getDb()
    .insert(userUploads)
    .values({
      id: 'upload',
      ownerOxyUserId: 'organization',
      title: 'Audio',
      duration: 0,
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
      oxyTaskId: 'old-task',
    });
  await getDb()
    .update(userUploads)
    .set({ oxyTaskId: 'new-task' })
    .where(eq(userUploads.id, 'upload'));
  expect(await revocations()).toEqual([{ taskId: 'old-task', attempts: 0 }]);
  expect(await personalAudioRequester('user_upload', 'upload', 'organization')).toEqual({
    taskId: 'new-task',
    accountId: 'organization',
  });
  expect(await personalAudioRequester('user_upload', 'upload', 'another-account')).toBeNull();
});

test('ordinary owner re-upload refreshes legacy copy authority without changing the file record', async () => {
  await getDb()
    .insert(userUploads)
    .values({
      id: 'upload',
      ownerOxyUserId: 'organization',
      title: 'Existing Audio',
      duration: 5,
      sizeBytes: 1,
      sha256: 'b'.repeat(64),
    });
  expect(await refreshLockerFileTask(req, 'upload')).toBe(true);
  expect(await personalAudioRequester('user_upload', 'upload', 'organization')).toEqual({
    taskId: 'original-task',
    accountId: 'organization',
  });
  const [row] = await getDb()
    .select({ title: userUploads.title, duration: userUploads.duration })
    .from(userUploads)
    .where(eq(userUploads.id, 'upload'));
  expect(row).toEqual({ title: 'Existing Audio', duration: 5 });
  const count = calls.length;
  expect(
    await refreshLockerFileTask(
      { ...req, user: { id: 'another-account' } } as OxyAuthRequest,
      'upload',
    ),
  ).toBe(false);
  expect(calls).toHaveLength(count);
});
