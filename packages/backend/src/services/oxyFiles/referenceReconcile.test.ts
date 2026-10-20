import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { installFakeOxyFiles, resetOxyFiles, type FakeOxyFiles } from '../../test/fakeOxyFiles';
import { getDb } from '../../db/postgres';
import { OXY_REFERENCE_ENTITY_TYPES, oxyFileReconcileRuns } from '../../db/schema/oxyFiles';
import { reconcileAllNow, reconcileEntityType, runDueReconciliations } from './referenceReconcile';

/**
 * The nightly inventory: Oxy is told the whole truth for one entity type and
 * repairs its references to match — adding the missing, removing the stale.
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

async function house(id: string, fileId: string): Promise<void> {
  await getDb().execute(sql`
    insert into houses (id, name, created_by, avatar_file_id) values (${id}, 'H', 'u', ${fileId})
  `);
}

describe('reconcileEntityType', () => {
  it('adds what Syra uses and Oxy lacks, removes what Oxy holds and Syra no longer uses', async () => {
    const used = oxy.seedFile({ bytes: Buffer.from('used'), ownerUserId: 'u' });
    const stale = oxy.seedFile({ bytes: Buffer.from('stale'), ownerUserId: 'u' });
    await house('h-1', used.id);
    oxy.refs.set(`${stale.id}|house|h-gone`, 0);

    const outcome = await reconcileEntityType('house', false);

    expect(outcome).toMatchObject({
      added: 1,
      removed: 1,
      unchanged: 0,
      refused: 0,
      dryRun: false,
    });
    expect(oxy.hasReference(used.id, 'house', 'h-1')).toBe(true);
    expect(oxy.hasReference(stale.id, 'house', 'h-gone')).toBe(false);
    const [run] = await getDb()
      .select()
      .from(oxyFileReconcileRuns)
      .where(eq(oxyFileReconcileRuns.entityType, 'house'));
    expect(run).toMatchObject({ added: 1, removed: 1, dryRun: false, lastError: null });
    expect(run?.finishedAt).not.toBeNull();
  });

  it('changes nothing on a dry run, and says so', async () => {
    const used = oxy.seedFile({ bytes: Buffer.from('used'), ownerUserId: 'u' });
    await house('h-1', used.id);
    const outcome = await reconcileEntityType('house', true);
    expect(outcome).toMatchObject({ added: 1, dryRun: true });
    expect(oxy.hasReference(used.id, 'house', 'h-1')).toBe(false);
  });

  it('records a failed run without marking it finished', async () => {
    oxy.failNext.set('references.reconcile', new Error('Oxy is down'));
    await expect(reconcileEntityType('room', false)).rejects.toThrow('Oxy is down');
    const [run] = await getDb()
      .select()
      .from(oxyFileReconcileRuns)
      .where(eq(oxyFileReconcileRuns.entityType, 'room'));
    expect(run?.finishedAt).toBeNull();
    expect(run?.lastError).toContain('Oxy is down');
  });
});

describe('runDueReconciliations', () => {
  it('applies, and runs each type once a day', async () => {
    const first = await runDueReconciliations(new Date());
    expect(first).toHaveLength(OXY_REFERENCE_ENTITY_TYPES.length);
    expect(first.every((outcome) => !outcome.dryRun)).toBe(true);
    expect(await runDueReconciliations(new Date())).toHaveLength(0);

    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(await runDueReconciliations(tomorrow)).toHaveLength(OXY_REFERENCE_ENTITY_TYPES.length);
  });

  it('registers what Syra uses', async () => {
    const used = oxy.seedFile({ bytes: Buffer.from('used'), ownerUserId: 'u' });
    await house('h-1', used.id);
    await runDueReconciliations();
    expect(oxy.hasReference(used.id, 'house', 'h-1')).toBe(true);
  });
});

describe('reconcileAllNow', () => {
  it("previews every entity type without recording a run, so the night's run still happens", async () => {
    const used = oxy.seedFile({ bytes: Buffer.from('used'), ownerUserId: 'u' });
    await house('h-1', used.id);

    const preview = await reconcileAllNow(true);

    expect(preview).not.toBe('busy');
    if (preview === 'busy') return;
    expect(preview.outcomes).toHaveLength(OXY_REFERENCE_ENTITY_TYPES.length);
    expect(preview.outcomes.find((o) => o.entityType === 'house')).toMatchObject({
      added: 1,
      dryRun: true,
    });
    expect(oxy.hasReference(used.id, 'house', 'h-1')).toBe(false);
    expect(await getDb().select().from(oxyFileReconcileRuns)).toEqual([]);

    expect(await runDueReconciliations()).toHaveLength(OXY_REFERENCE_ENTITY_TYPES.length);
  });

  it("applies every entity type and records it as the night's run", async () => {
    const used = oxy.seedFile({ bytes: Buffer.from('used'), ownerUserId: 'u' });
    await house('h-1', used.id);

    const applied = await reconcileAllNow(false);

    expect(applied).not.toBe('busy');
    expect(oxy.hasReference(used.id, 'house', 'h-1')).toBe(true);
    expect(await runDueReconciliations()).toHaveLength(0);
  });
});
