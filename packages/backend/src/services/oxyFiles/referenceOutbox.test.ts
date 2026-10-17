import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import {
  FakeOxyError,
  installFakeOxyFiles,
  resetOxyFiles,
  type FakeOxyFiles,
} from '../../test/fakeOxyFiles';
import { getDb } from '../../db/postgres';
import { drainReferenceOutboxOnce, MAX_ATTEMPTS } from './referenceOutbox';

/**
 * The outbox is written by the database; this is the half that delivers it. The
 * properties that matter: a delivered row goes, an intent written while its
 * predecessor was in flight survives, a refusal is not retried forever, and a
 * failure backs off.
 */

beforeAll(connectDb);
let oxy: FakeOxyFiles;
beforeEach(() => {
  oxy = installFakeOxyFiles();
});
afterEach(async () => {
  resetOxyFiles();
  await clearDb();
});
afterAll(disconnectDb);

async function queue(fileId: string, entityId: string, op: 'add' | 'remove'): Promise<void> {
  await getDb().execute(sql`
    insert into oxy_file_reference_ops (file_id, entity_type, entity_id, op)
    values (${fileId}, 'playlist', ${entityId}, ${op})
  `);
}

async function rows() {
  return [
    ...(await getDb().execute<{
      file_id: string;
      op: string;
      attempts: number;
      dead_at: Date | null;
      last_error: string | null;
      next_attempt_at: string;
    }>(
      sql`select file_id, op, attempts, dead_at, last_error, next_attempt_at from oxy_file_reference_ops order by file_id`,
    )),
  ];
}

describe('drainReferenceOutboxOnce', () => {
  it('delivers adds and removes, then forgets them', async () => {
    const own = oxy.seedFile({ bytes: Buffer.from('a'), ownerApplicationId: oxy.applicationId });
    oxy.refs.set(`gone|playlist|p-2`, 0);
    await queue(own.id, 'p-1', 'add');
    await queue('gone', 'p-2', 'remove');
    await queue('never-held', 'p-3', 'remove');

    expect(await drainReferenceOutboxOnce()).toBe(3);
    expect(oxy.hasReference(own.id, 'playlist', 'p-1')).toBe(true);
    expect(oxy.hasReference('gone', 'playlist', 'p-2')).toBe(false);
    // A remove Oxy answers not_found is ALREADY removed: delivered, not failed.
    expect(await rows()).toEqual([]);
  });

  it('dead-letters an add Oxy refuses, at once, with the reason', async () => {
    oxy.seedFile({
      bytes: Buffer.from('p'),
      ownerApplicationId: 'someone-else',
      visibility: 'private',
    });
    const [privateFile] = [...oxy.files.values()];
    await queue(privateFile!.id, 'p-1', 'add');

    await drainReferenceOutboxOnce();
    const [row] = await rows();
    expect(row?.dead_at).not.toBeNull();
    expect(row?.last_error).toContain('not_found');
    // A dead row is never claimed again.
    expect(await drainReferenceOutboxOnce()).toBe(0);
  });

  it('backs off a failed request and dead-letters it after the last attempt', async () => {
    const own = oxy.seedFile({ bytes: Buffer.from('b'), ownerApplicationId: oxy.applicationId });
    await queue(own.id, 'p-1', 'add');

    oxy.failNext.set('references.add', new FakeOxyError(503, 'down'));
    await drainReferenceOutboxOnce();
    let [row] = await rows();
    expect(row?.attempts).toBe(1);
    expect(row?.dead_at).toBeNull();
    expect(new Date(row!.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
    // Not due yet: nothing is claimed.
    expect(await drainReferenceOutboxOnce()).toBe(0);

    await getDb().execute(sql`
      update oxy_file_reference_ops set attempts = ${MAX_ATTEMPTS - 1}, next_attempt_at = now()
    `);
    oxy.failNext.set('references.add', new FakeOxyError(503, 'down'));
    await drainReferenceOutboxOnce();
    [row] = await rows();
    expect(row?.dead_at).not.toBeNull();
  });

  it('keeps an intent written while the previous one was in flight', async () => {
    const own = oxy.seedFile({ bytes: Buffer.from('c'), ownerApplicationId: oxy.applicationId });
    await queue(own.id, 'p-1', 'add');

    // The add is "in flight" when the entity lets go of the file: the trigger's
    // upsert flips the intent and bumps the version under the drainer.
    const realAdd = oxy.references.add;
    oxy.references.add = async (refs) => {
      await getDb().execute(sql`
        update oxy_file_reference_ops set op = 'remove', version = version + 1
      `);
      return realAdd(refs);
    };
    await drainReferenceOutboxOnce();
    oxy.references.add = realAdd;

    expect((await rows()).map((row) => row.op)).toEqual(['remove']);
    await getDb().execute(sql`update oxy_file_reference_ops set claimed_until = null`);
    await drainReferenceOutboxOnce();
    expect(await rows()).toEqual([]);
    expect(oxy.hasReference(own.id, 'playlist', 'p-1')).toBe(false);
  });

  it('never hands one row to two drainers', async () => {
    const own = oxy.seedFile({ bytes: Buffer.from('d'), ownerApplicationId: oxy.applicationId });
    for (let i = 0; i < 20; i += 1) await queue(own.id, `p-${i}`, 'add');

    const [a, b] = await Promise.all([drainReferenceOutboxOnce(15), drainReferenceOutboxOnce(15)]);
    expect(a + b).toBe(20);
    const sent = oxy.calls
      .filter((call) => call.method === 'references.add')
      .flatMap((call) => (call.args[0] as Array<{ entityId: string }>).map((ref) => ref.entityId));
    expect(new Set(sent).size).toBe(sent.length);
  });
});
