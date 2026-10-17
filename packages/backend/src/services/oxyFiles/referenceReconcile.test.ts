import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { installFakeOxyFiles, resetOxyFiles, type FakeOxyFiles } from '../../test/fakeOxyFiles';
import { getDb } from '../../db/postgres';
import { OXY_REFERENCE_ENTITY_TYPES, oxyFileReconcileRuns } from '../../db/schema/oxyFiles';
import { reconcileEntityType, reconcileMode, runDueReconciliations } from './referenceReconcile';

/**
 * The nightly inventory: Oxy is told the whole truth for one entity type and
 * repairs its references to match — adding the missing, removing the stale.
 */

beforeAll(connectDb);
let oxy: FakeOxyFiles;
const savedMode = process.env.OXY_FILES_RECONCILE;
beforeEach(() => {
  oxy = installFakeOxyFiles();
});
afterEach(async () => {
  resetOxyFiles();
  if (savedMode === undefined) delete process.env.OXY_FILES_RECONCILE;
  else process.env.OXY_FILES_RECONCILE = savedMode;
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
  it('defaults to a dry run, and runs each type once a day', async () => {
    delete process.env.OXY_FILES_RECONCILE;
    expect(reconcileMode()).toBe('dry-run');

    const first = await runDueReconciliations(new Date());
    expect(first).toHaveLength(OXY_REFERENCE_ENTITY_TYPES.length);
    expect(first.every((outcome) => outcome.dryRun)).toBe(true);
    expect(await runDueReconciliations(new Date())).toHaveLength(0);

    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(await runDueReconciliations(tomorrow)).toHaveLength(OXY_REFERENCE_ENTITY_TYPES.length);
  });

  it('does nothing when switched off', async () => {
    process.env.OXY_FILES_RECONCILE = 'off';
    expect(await runDueReconciliations()).toEqual([]);
    expect(oxy.calls).toEqual([]);
  });

  it('applies when told to', async () => {
    process.env.OXY_FILES_RECONCILE = 'apply';
    const used = oxy.seedFile({ bytes: Buffer.from('used'), ownerUserId: 'u' });
    await house('h-1', used.id);
    await runDueReconciliations();
    expect(oxy.hasReference(used.id, 'house', 'h-1')).toBe(true);
  });
});
