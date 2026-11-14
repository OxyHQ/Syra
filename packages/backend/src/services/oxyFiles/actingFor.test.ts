import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { type OxyAuthRequest, OxyServer } from '@oxy.so/core/server';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { userUploads } from '../../db/schema/creators';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { signedIn } from '../../test/signedInRequest';
import { operatorOf, ownerActingFor, requestActingFor, resumeLockerCopy } from './actingFor';

/**
 * Syra acts for a person in Oxy Files by naming the account (oxy ADR 0066):
 * no session, task or ticket crosses to Oxy, in the foreground or later.
 */

function request(effective: string, actor = effective): OxyAuthRequest {
  const req = { headers: { 'x-oxy-user-id': 'someone-else' } } as unknown as OxyAuthRequest;
  signedIn(req, effective, actor);
  return req;
}

describe('requestActingFor', () => {
  it('names the signed-in account, and the person when they operate it', () => {
    expect(requestActingFor(request('person'))).toEqual({ accountId: 'person' });
    expect(requestActingFor(request('organization', 'person'))).toEqual({
      accountId: 'organization',
      requesterAccountId: 'person',
    });
    expect(operatorOf(request('person'))).toBeNull();
    expect(operatorOf(request('organization', 'person'))).toBe('person');
  });

  it('ignores a chain that does not describe the signed-in account, and refuses no account', () => {
    const req = request('organization', 'person');
    req.user = { id: 'another-account' };
    expect(requestActingFor(req)).toEqual({ accountId: 'another-account' });
    expect(() => requestActingFor({} as OxyAuthRequest)).toThrow('signed-in account');
  });

  it('builds the background form from the stored owner and operator', () => {
    expect(ownerActingFor('organization', 'person')).toEqual({
      accountId: 'organization',
      requesterAccountId: 'person',
    });
    expect(ownerActingFor('person', null)).toEqual({ accountId: 'person' });
  });
});

describe('what reaches Oxy', () => {
  let server: ReturnType<typeof Bun.serve>;
  let client: OxyServer;
  const seen: Array<Record<string, string | null>> = [];

  beforeAll(() => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path.endsWith('/challenge')) return Response.json({ nonce: 'fixture' });
        if (path === '/auth/service-token/workload') {
          const now = Math.floor(Date.now() / 1000);
          return Response.json({
            token: `e30.${Buffer.from(JSON.stringify({ exp: now + 300 })).toString('base64url')}.fixture`,
            expiresIn: 300,
          });
        }
        seen.push({
          path,
          user: req.headers.get('x-oxy-user-id'),
          requester: req.headers.get('x-oxy-requester-id'),
          owner: req.headers.get('x-owner-user-id'),
          proof: req.headers.get('x-oxy-requester-token') ?? req.headers.get('x-oxy-task-id'),
        });
        return Response.json({
          file: { id: 'file-1', sha256: 'a'.repeat(64), size: 1, mime: 'image/png' },
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
  });
  afterAll(() => {
    client.dispose();
    server.stop(true);
  });

  it('sends the account and the operating person, and no proof', async () => {
    await client.assets
      .actingFor(requestActingFor(request('organization', 'person')))
      .uploadUserMedia('organization', Buffer.from('x'), 'image/png');
    expect(seen).toEqual([
      {
        path: '/assets/service/user-media',
        user: 'organization',
        requester: 'person',
        owner: 'organization',
        proof: null,
      },
    ]);
  });
});

describe('resumeLockerCopy', () => {
  beforeAll(connectDb);
  afterEach(clearDb);
  afterAll(disconnectDb);

  async function upload(audioFileId: string | null = null): Promise<void> {
    await getDb()
      .insert(userUploads)
      .values({
        id: 'upload',
        ownerOxyUserId: 'organization',
        title: 'Existing Audio',
        duration: 5,
        sizeBytes: 1,
        sha256: 'b'.repeat(64),
        audioFileId,
      });
  }
  const stored = async () =>
    (
      await getDb()
        .select({ operator: userUploads.operatorOxyUserId, title: userUploads.title })
        .from(userUploads)
        .where(eq(userUploads.id, 'upload'))
    )[0];

  it("resumes the owner's uncopied file and records who asked this time", async () => {
    await upload();
    expect(await resumeLockerCopy(request('organization', 'person'), 'upload')).toBe(true);
    expect(await stored()).toEqual({ operator: 'person', title: 'Existing Audio' });
    expect(await resumeLockerCopy(request('organization'), 'upload')).toBe(true);
    expect((await stored())?.operator).toBeNull();
  });

  it("never touches another account's file or one Oxy already holds", async () => {
    await upload();
    expect(await resumeLockerCopy(request('another-account'), 'upload')).toBe(false);
    expect((await stored())?.operator).toBeNull();
    await clearDb();
    await upload('file-1');
    expect(await resumeLockerCopy(request('organization', 'person'), 'upload')).toBe(false);
  });
});
