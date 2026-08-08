import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../test/mongo';
import { ensureIndexes, planIndexes, loadAllModels } from './ensureIndexes';
import { ReportModel, ReportCategory, ReportedType } from '../models/Report';

/**
 * The worked examples in this file are MODERATION collections.
 *
 * They used to be `catalogentities` and `tracks`, which was right while the
 * catalogue was Mongoose. Task 19a ported or deleted every non-moderation
 * model, so those two no longer exist and discovery has nothing to find but
 * Task 8's four. Pointing the assertions at collections this script still
 * serves is what keeps them meaningful — the alternative was keeping two dead
 * models alive to give the test something to discover, which is circular.
 *
 * When Task 8 lands, this script and this file go together.
 */
const REPORT_FIXTURE = {
  reportedType: ReportedType.TRACK,
  reportedId: 'track-under-report',
  reporter: 'reporter-1',
  categories: [ReportCategory.SPAM],
};

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

/** Index names on a collection, minus the implicit `_id_`. */
async function builtIndexNames(collectionName: string): Promise<string[]> {
  const indexes = await mongoose.connection.collection(collectionName).indexes();
  return indexes.map((index) => index.name ?? '').filter((name) => name !== '_id_').sort();
}

/**
 * FULL index definitions — key AND options — not just names.
 *
 * Names alone cannot see the difference this comparison exists to catch: an
 * index built with and without a `partialFilterExpression` has the SAME name, so
 * a name-only check passes while production silently gets a collection-wide
 * unique index where dev has a discriminator-scoped one. (An earlier version of
 * this test compared names; mutation-testing the decoration away did not fail a
 * single assertion, which is what exposed it.) `v` is dropped because it is the
 * server's index format version, not something either side chose.
 */
async function builtIndexDefinitions(collectionName: string): Promise<string[]> {
  const indexes = await mongoose.connection.collection(collectionName).indexes();
  return indexes
    .filter((index) => index.name !== '_id_')
    .map(({ v, ...definition }) => JSON.stringify(definition, Object.keys(definition).sort()))
    .sort();
}

async function dropAllIndexes(collectionName: string): Promise<void> {
  try {
    await mongoose.connection.collection(collectionName).dropIndexes();
  } catch {
    // Nothing to drop.
  }
}

describe('ensureIndexes — discovery', () => {
  it('finds every model without being told which ones exist', () => {
    loadAllModels();
    const planned = planIndexes();
    const models = new Set(planned.map((index) => index.modelName));

    // The point of reading the directory: a schema added later is covered with
    // no edit here. If this ever drops to a handful, discovery silently broke.
    //
    // 15 against 17 measured, down from "> 40". The floor fell because the
    // MODELS fell: Task 19a left moderation as the only vertical still on
    // Mongoose, so 17 is the whole population rather than a sample of it. Every
    // name below is one of Task 8's four — when they go, so does this file.
    expect(planned.length).toBeGreaterThan(15);
    expect(models.has('Report')).toBe(true);
    expect(models.has('ModerationEnforcement')).toBe(true);
    expect(models.has('ModerationEvent')).toBe(true);
    expect(models.has('ModerationOutbox')).toBe(true);
  });

  it('includes the constraints this feature depends on', () => {
    loadAllModels();
    const planned = planIndexes();
    const find = (collection: string, spec: Record<string, unknown>) =>
      planned.find(
        (index) =>
          index.collectionName === collection && JSON.stringify(index.spec) === JSON.stringify(spec),
      );

    // Named explicitly because these are the ones whose ABSENCE in production is
    // silent: the code races, nothing errors, and duplicates accumulate.
    expect(
      find('reports', { reporter: 1, reportedType: 1, reportedId: 1 })?.options.unique
    ).toBe(true);
    expect(
      find('moderation_enforcements', { decisionId: 1, decisionRevision: 1, action: 1 })?.options
        .unique
    ).toBe(true);
    // The two `useruploads` entries were here for the same reason and left with
    // the model. `user_uploads_owner_oxy_user_id_sha256_key` and
    // `user_uploads_fingerprint_duration_sec_idx` are the Postgres constraints
    // that replace them, both asserted in `db/__tests__/gates.test.ts` — the
    // first by writing a duplicate and reading the violation back.
  });
});

describe('ensureIndexes — agreement with Mongoose', () => {
  it('builds exactly what Mongoose builds itself', async () => {
    // The core property: whatever Mongoose would create, the script creates,
    // options included. If the two ever disagree, production gets an index that
    // differs from the one every test ran against.
    await dropAllIndexes('reports');
    await ReportModel.createIndexes();
    const byMongoose = await builtIndexDefinitions('reports');

    await dropAllIndexes('reports');
    await ensureIndexes();
    const byScript = await builtIndexDefinitions('reports');

    // Full definitions, so a dropped option fails here and not in production.
    expect(byScript).toEqual(byMongoose);
    expect(byScript.length).toBeGreaterThan(5);
    // Vacuity floor: the comparison must be looking at OPTIONS, not just key
    // specs. It read `partialFilterExpression` while the worked example was
    // `catalogentities`; `reports` has no discriminator, so it reads `unique`
    // — the option this collection actually carries. A floor naming an option
    // the subject does not have is a floor that fails for the wrong reason,
    // which is how this swap was noticed.
    expect(byMongoose.some((definition) => definition.includes('unique'))).toBe(true);
  });

  // DELETED WITH ITS SUBJECT: 'scopes a discriminator index to its own type'.
  //
  // It asserted that `nameKey_1` on `catalogentities` carries
  // `partialFilterExpression: { type: 'artist' }`, which is how artists and
  // persons shared one collection without a podcast guest colliding with a
  // recording artist. Task 19a deleted `CatalogEntity`, and NO surviving
  // Mongoose model uses a discriminator at all.
  //
  // The consequence is worth stating rather than leaving to be discovered:
  // `ensureIndexes.ts` still replicates Mongoose's discriminator
  // `partialFilterExpression` rule, and that code path is now UNEXERCISED. It
  // is not dead — a discriminator model would need it — but nothing would catch
  // it breaking. Task 8 deletes this script along with moderation's models, at
  // which point the question closes; until then it is a known gap, not an
  // oversight.
});

describe('ensureIndexes — reporting', () => {
  it('reports what it created, then reports the same indexes as already present', async () => {
    await dropAllIndexes('moderation_enforcements');

    const first = await ensureIndexes();
    const createdTrackIndexes = first.outcomes.filter(
      (outcome) => outcome.status === 'created' && outcome.index.collectionName === 'moderation_enforcements',
    );
    expect(createdTrackIndexes.length).toBeGreaterThan(0);
    expect(first.failed).toBe(0);

    // Idempotent: re-running is the normal way to deploy a new index, so the
    // second run must be a no-op rather than an error.
    const second = await ensureIndexes();
    expect(second.created).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.present).toBe(first.outcomes.length);
  });

  it('dry run reports missing indexes WITHOUT building them', async () => {
    await dropAllIndexes('moderation_enforcements');

    const result = await ensureIndexes({ dryRun: true });
    const missing = result.outcomes.filter(
      (outcome) => outcome.status === 'would-create' && outcome.index.collectionName === 'moderation_enforcements',
    );

    expect(missing.length).toBeGreaterThan(0);
    expect(result.created).toBe(0);
    // Nothing was written — this is what makes it safe to point at production.
    expect(await builtIndexNames('moderation_enforcements')).toEqual([]);
  });
});

describe('ensureIndexes — failure on existing duplicate data', () => {
  it('reports the offending documents instead of a bare E11000, and keeps going', async () => {
    // The expected first-run failure against production: a unique index that
    // cannot build because duplicates are ALREADY there. Written through the
    // driver so the schema's own guards do not prevent the bad state.
    await dropAllIndexes('reports');
    await mongoose.connection.collection('reports').insertMany([
      { ...REPORT_FIXTURE, localStatus: 'open' },
      { ...REPORT_FIXTURE, localStatus: 'open' },
    ]);

    const result = await ensureIndexes();

    const failure = result.outcomes.find(
      (outcome) =>
        outcome.status === 'failed' &&
        JSON.stringify(outcome.index.spec) ===
          JSON.stringify({ reporter: 1, reportedType: 1, reportedId: 1 }),
    );
    expect(failure).toBeDefined();
    if (failure?.status !== 'failed') throw new Error('expected a failed outcome');

    // "E11000" alone leaves whoever is running the deploy with no next step.
    // The offending group IS the next step.
    expect(failure.duplicates?.length).toBe(1);
    expect(JSON.stringify(failure.duplicates)).toContain('track-under-report');
    expect(result.failed).toBeGreaterThan(0);

    // One bad index must not hide the state of the other forty.
    expect(result.created).toBeGreaterThan(0);
    const trackIndexes = await builtIndexNames('moderation_enforcements');
    expect(trackIndexes.length).toBeGreaterThan(0);
  });

  it('does NOT drop or alter indexes it did not create', async () => {
    // `syncIndexes()` would delete any index this script did not plan. It only
    // ever calls `createIndex`, so a hand-made one survives a run.
    await dropAllIndexes('reports');
    await mongoose.connection
      .collection('reports')
      .createIndex({ handmadeMarker: 1 }, { name: 'handmade_marker' });

    await ensureIndexes();

    expect(await builtIndexNames('reports')).toContain('handmade_marker');
  });
});

describe('ensureIndexes — the constraints it is meant to restore actually bite', () => {
  it('a unique index built by the script rejects a duplicate afterwards', async () => {
    // Vacuity floor for the whole script: building an index that does not
    // enforce anything would satisfy every test above.
    await dropAllIndexes('reports');
    await ensureIndexes();

    await ReportModel.create(REPORT_FIXTURE);
    await expect(ReportModel.create(REPORT_FIXTURE)).rejects.toThrow();
  });
});
