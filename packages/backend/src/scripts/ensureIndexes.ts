/**
 * Build every index declared in every schema, against the connected database.
 *
 * ## Why this exists
 *
 * `utils/database.ts` sets `autoIndex: false` when `NODE_ENV === 'production'`,
 * and nothing else in the backend has ever created an index. So in production
 * every index in every schema is DECLARATIVE ONLY: the code reads as though the
 * constraint exists, and the database does not enforce it.
 *
 * That is not a performance footnote. It means the unique guarantees the code
 * relies on may simply not be there — `Track.externalIds.isrc`, `Album.upc`,
 * `CatalogEntity.linkedOxyUserId`, `Podcast.feedUrl`, the artist `nameKey` the
 * whole upload dedup story rests on. Every one of those is a correctness
 * constraint that races silently when the index is absent: two concurrent
 * writers both read "nothing there", both insert, and nothing ever complains.
 * Tests pass, because tests run with `autoIndex` on.
 *
 * ## Design
 *
 * - **Models are DISCOVERED, not listed.** The script requires every file in
 *   `src/models` and then walks `mongoose.models`, so a schema added later
 *   cannot be silently missed by whoever forgot to update a list here.
 * - **Every index is reported** — created, already present, or failed. A silent
 *   success is worthless for this particular job: the entire problem being fixed
 *   is that everyone assumed the indexes were there.
 * - **A failure is reported with its cause and does not stop the run.** The
 *   expected first-run failure against production is a unique index that cannot
 *   build because duplicate data ALREADY exists, so the script goes and finds
 *   the offending documents and prints them. Continuing means one bad index does
 *   not hide the state of the other forty; the process still exits non-zero.
 * - **It never drops anything, and never calls `syncIndexes()`.** On
 *   `catalogentities` that call would DELETE the other discriminators' indexes:
 *   each of the three models knows only its own, so syncing any one of them
 *   treats the others' as extraneous. Only `createIndex` is used here.
 * - **Idempotent.** `createIndex` on an identical existing index is a no-op, so
 *   re-running is safe and is the normal way to deploy a new index.
 *
 * ## Running it
 *
 *   bun run ensure-indexes            # against MONGODB_URI
 *   bun run ensure-indexes -- --dry-run
 *
 * Run the dry run against production FIRST. It reports what would be built
 * without touching anything, which is how you find out that a unique index is
 * going to fail on existing duplicates before you are mid-deploy.
 */

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import type { CreateIndexesOptions, IndexSpecification } from 'mongodb';
import dotenv from 'dotenv';
import { connectToDatabase } from '../utils/database';
import { logger } from '../utils/logger';

dotenv.config();

/** How many offending documents to print when a unique index cannot build. */
const DUPLICATE_SAMPLE_LIMIT = 10;

export interface PlannedIndex {
  /** Mongoose model name, e.g. `Track` or the discriminator `artist`. */
  modelName: string;
  collectionName: string;
  spec: mongoose.IndexDefinition;
  options: mongoose.IndexOptions;
}

/**
 * The internal bookkeeping Mongoose puts on a discriminated schema.
 *
 * Real at runtime and load-bearing here, but absent from the published types, so
 * it is reached through a precise structural type rather than a widening cast —
 * `discriminatorMapping` is what says whether a schema IS a discriminator and
 * which value it stands for.
 */
interface SchemaDiscriminatorInternals {
  discriminatorMapping?: { value?: string | null; isRoot?: boolean };
  options: { discriminatorKey?: string };
}

export type IndexOutcome =
  | { status: 'created'; index: PlannedIndex; name: string }
  | { status: 'present'; index: PlannedIndex; name: string }
  | { status: 'would-create'; index: PlannedIndex }
  | { status: 'failed'; index: PlannedIndex; error: string; duplicates?: unknown[] };

export interface EnsureIndexesResult {
  outcomes: IndexOutcome[];
  created: number;
  present: number;
  failed: number;
}

/**
 * Import every model module so `mongoose.models` is fully populated.
 *
 * Reading the directory rather than listing imports is the point: a model added
 * next month registers itself here with no edit to this file, so "we forgot to
 * add it to the index script" is not a failure mode that exists.
 */
export function loadAllModels(): void {
  const modelsDir = path.join(__dirname, '..', 'models');
  for (const entry of fs.readdirSync(modelsDir)) {
    if (!/\.(ts|js)$/.test(entry)) continue;
    if (/\.(test|spec)\.(ts|js)$/.test(entry)) continue;
    if (/\.d\.ts$/.test(entry)) continue;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require(path.join(modelsDir, entry));
  }
}

/**
 * Add the discriminator's own `partialFilterExpression`, exactly as Mongoose
 * does when it builds indexes itself.
 *
 * This mirrors `mongoose/lib/helpers/indexes/decorateDiscriminatorIndexOptions.js`
 * — including the `sparse` exemption, which exists because MongoDB rejects an
 * index that is both sparse and partial. Replicated rather than imported because
 * that path is Mongoose internals, and pinned by a test that compares this
 * plan against the indexes `Model.createIndexes()` actually produces. If Mongoose
 * ever changes the rule, that test fails rather than production quietly getting
 * a collection-wide unique index where dev has a discriminator-scoped one.
 */
function decorateDiscriminatorOptions(
  schema: mongoose.Schema,
  options: mongoose.IndexOptions,
): mongoose.IndexOptions {
  const internals = schema as unknown as SchemaDiscriminatorInternals;
  const discriminatorValue = internals.discriminatorMapping?.value;
  // TRUTHINESS, not `!== undefined`, and the difference is not cosmetic: the
  // BASE schema of a discriminated model also carries a `discriminatorMapping`,
  // with `isRoot: true` and `value: null`. An `undefined` check lets that
  // through and stamps `partialFilterExpression: { type: null }` onto every base
  // index — which matches NO documents, so the indexes build successfully and
  // index nothing. Six of them, silently, in production. Mongoose's own helper
  // uses truthiness for exactly this reason.
  if (!discriminatorValue || 'sparse' in options) return options;

  const discriminatorKey = internals.options.discriminatorKey ?? '__t';
  const existing = (options.partialFilterExpression ?? {}) as Record<string, unknown>;
  return {
    ...options,
    partialFilterExpression: { ...existing, [discriminatorKey]: discriminatorValue },
  };
}

/** Every index every registered model declares, with its final built options. */
export function planIndexes(): PlannedIndex[] {
  const planned: PlannedIndex[] = [];

  const collect = (modelName: string, model: mongoose.Model<unknown>): void => {
    for (const [spec, rawOptions] of model.schema.indexes()) {
      planned.push({
        modelName,
        collectionName: model.collection.name,
        spec,
        options: decorateDiscriminatorOptions(model.schema, { ...(rawOptions ?? {}) }),
      });
    }
  };

  for (const [modelName, model] of Object.entries(mongoose.models)) {
    const typedModel = model as mongoose.Model<unknown>;
    collect(modelName, typedModel);

    // Discriminators live in the same physical collection but carry their own
    // indexes, and `mongoose.models` does not always surface them as top-level
    // entries — walk them explicitly so an artist-only unique index is not
    // skipped just because it hangs off the base model.
    for (const [discriminatorName, discriminator] of Object.entries(typedModel.discriminators ?? {})) {
      collect(discriminatorName, discriminator as mongoose.Model<unknown>);
    }
  }

  return planned;
}

/** MongoDB's duplicate-key error, as it arrives from a failed index build. */
function isDuplicateKeyFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: number }).code;
  // 11000 duplicate key; 11001 legacy duplicate key on index build.
  return code === 11000 || code === 11001;
}

/**
 * Find the documents that make a unique index impossible.
 *
 * Reporting "E11000" alone would leave whoever is running the deploy with no
 * next step. Grouping by the index key and returning the groups with more than
 * one member IS the next step — those are the rows somebody has to merge or
 * delete before the constraint can exist.
 */
async function findDuplicates(
  collection: mongoose.Collection,
  spec: mongoose.IndexDefinition,
): Promise<unknown[]> {
  const keyFields = Object.keys(spec);
  const groupId: Record<string, string> = {};
  for (const field of keyFields) {
    // A dotted path is not a legal `$group` key, so flatten it.
    groupId[field.replace(/\./g, '_')] = `$${field}`;
  }

  try {
    return await collection
      .aggregate([
        { $group: { _id: groupId, count: { $sum: 1 }, ids: { $push: '$_id' } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
        { $limit: DUPLICATE_SAMPLE_LIMIT },
      ])
      .toArray();
  } catch {
    // Diagnostics must never become the reason the report is lost.
    return [];
  }
}

/**
 * The name MongoDB will give this index — key and direction joined by `_`,
 * unless the schema named it explicitly.
 *
 * Matching on the NAME rather than the key pattern, because for several index
 * types the stored key is not the declared one: a text index declared
 * `{ title: 'text', artistName: 'text' }` is stored as `{ _fts: 'text', _ftsx: 1 }`
 * and only its NAME (`title_text_artistName_text`) still reflects what was
 * asked for. Comparing key patterns therefore reports every text index as
 * missing on every run — which is how this was caught: the idempotency test
 * saw seven indexes "created" a second time.
 */
export function indexName(spec: mongoose.IndexDefinition, options: mongoose.IndexOptions): string {
  if (typeof options.name === 'string') return options.name;
  return Object.entries(spec)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');
}

/** Is an equivalent index already built? */
function existingIndexName(
  existing: Array<{ name?: string }>,
  spec: mongoose.IndexDefinition,
  options: mongoose.IndexOptions,
): string | undefined {
  const expected = indexName(spec, options);
  return existing.find((index) => index.name === expected)?.name;
}

export async function ensureIndexes(options: { dryRun?: boolean } = {}): Promise<EnsureIndexesResult> {
  loadAllModels();
  const planned = planIndexes();
  const outcomes: IndexOutcome[] = [];

  // One `indexes()` call per collection rather than per index.
  const existingByCollection = new Map<string, Array<{ name?: string }>>();
  for (const index of planned) {
    if (existingByCollection.has(index.collectionName)) continue;
    try {
      const collection = mongoose.connection.collection(index.collectionName);
      existingByCollection.set(index.collectionName, await collection.indexes());
    } catch {
      // A collection that does not exist yet simply has no indexes.
      existingByCollection.set(index.collectionName, []);
    }
  }

  for (const index of planned) {
    const collection = mongoose.connection.collection(index.collectionName);
    const alreadyBuilt = existingIndexName(
      existingByCollection.get(index.collectionName) ?? [],
      index.spec,
      index.options,
    );

    if (alreadyBuilt !== undefined) {
      outcomes.push({ status: 'present', index, name: alreadyBuilt });
      continue;
    }

    if (options.dryRun) {
      outcomes.push({ status: 'would-create', index });
      continue;
    }

    try {
      // No `background: true`: MongoDB 4.2+ ignores it and always uses the
      // hybrid build, which does not hold a write lock for the duration. Passing
      // it would only add a deprecation warning to every line of the output.
      // Mongoose's `IndexDefinition` and the driver's `IndexSpecification`
      // describe the same value; they differ only in that Mongoose additionally
      // accepts the `'asc'`/`'desc'` direction aliases, which the driver
      // normalises at runtime. A precise cast between the two, not a widening one.
      const name = await collection.createIndex(
        index.spec as IndexSpecification,
        index.options as CreateIndexesOptions,
      );
      outcomes.push({ status: 'created', index, name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const duplicates = isDuplicateKeyFailure(err)
        ? await findDuplicates(collection, index.spec)
        : undefined;
      outcomes.push({ status: 'failed', index, error: message, duplicates });
    }
  }

  return {
    outcomes,
    created: outcomes.filter((outcome) => outcome.status === 'created').length,
    present: outcomes.filter((outcome) => outcome.status === 'present').length,
    failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
  };
}

function describe(index: PlannedIndex): string {
  const options = Object.entries(index.options)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  return `${index.collectionName} ${JSON.stringify(index.spec)}${options ? ` [${options}]` : ''}`;
}

export function reportOutcomes(result: EnsureIndexesResult): void {
  for (const outcome of result.outcomes) {
    switch (outcome.status) {
      case 'created':
        logger.info(`[ensure-indexes] CREATED  ${describe(outcome.index)}`);
        break;
      case 'present':
        logger.info(`[ensure-indexes] present  ${describe(outcome.index)}`);
        break;
      case 'would-create':
        logger.info(`[ensure-indexes] MISSING  ${describe(outcome.index)}`);
        break;
      case 'failed':
        logger.error(`[ensure-indexes] FAILED   ${describe(outcome.index)}: ${outcome.error}`);
        if (outcome.duplicates?.length) {
          logger.error(
            `[ensure-indexes]          ${outcome.duplicates.length} duplicate group(s) block this index; ` +
              'merge or remove them, then re-run:',
          );
          for (const duplicate of outcome.duplicates) {
            logger.error(`[ensure-indexes]          ${JSON.stringify(duplicate)}`);
          }
        }
        break;
    }
  }

  const wouldCreate = result.outcomes.filter((outcome) => outcome.status === 'would-create').length;
  logger.info(
    `[ensure-indexes] ${result.outcomes.length} declared | ${result.created} created | ` +
      `${result.present} already present | ${wouldCreate} missing | ${result.failed} failed`,
  );
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  await connectToDatabase();
  logger.info(`[ensure-indexes] starting${dryRun ? ' (dry run — nothing will be written)' : ''}`);

  const result = await ensureIndexes({ dryRun });
  reportOutcomes(result);

  if (result.failed > 0) {
    throw new Error(
      `${result.failed} index(es) could not be built. The database is NOT enforcing those constraints.`,
    );
  }
}

if (require.main === module) {
  main()
    .then(() => mongoose.connection.close())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[ensure-indexes] fatal', { err });
      mongoose.connection.close().finally(() => process.exit(1));
    });
}
