/**
 * In-memory MongoDB test helper for bun test suites.
 *
 * ONE server is shared across the entire test process — all test files that
 * call `connect()` reuse the same mongod rather than spinning up a new one
 * each time. This eliminates the resource contention that caused intermittent
 * 5 s hook-timeout failures when 17 files each started their own server.
 *
 * Usage (unchanged in every test file):
 *   import { connect, clear, disconnect } from '../test/mongo';
 *   beforeAll(connect);
 *   afterEach(clear);
 *   afterAll(disconnect);
 */

import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * A single-member REPLICA SET, not a standalone.
 *
 * Multi-document transactions require a replica set or a sharded cluster, and the
 * moderation outbox is built on one: a report and its delivery event commit
 * together or not at all. On a standalone the first such write throws, so the
 * coupling could not be tested at all — and an untested coupling is exactly the
 * one that fails silently in production as a report answered 201 that nothing
 * ever sends.
 *
 * One member behaves identically to a standalone for every other test, and it is
 * still ONE mongod for the whole process, so the resource-contention fix this
 * module was written for is preserved.
 */
let server: MongoMemoryReplSet | undefined;
let connecting: Promise<void> | undefined;

/**
 * The catalog image-mirror double MOVED to `test/catalogImageMirror.ts`.
 *
 * This module used to define its own, export it under the same name, AND
 * install it as a side effect of `connect()`. That is what made the double
 * invisible: a suite moving to Postgres dropped the Mongo hooks and silently
 * lost its mock, which is exactly what happened to `enrichCatalogEntity`. Worse,
 * the two definitions had DIFFERENT semantics — this one minted `ObjectId`
 * strings, and those ids now land in seven foreign-key columns, where a minted
 * id is a constraint violation rather than a harmless fake.
 *
 * So there is one definition, it writes real `image_assets` rows, and every
 * suite that needs it installs it explicitly. `connect()` no longer installs
 * anything: a database helper's job is the database.
 */

/**
 * Connect once per test process; subsequent calls from other test files reuse
 * the same server. The in-flight promise is shared so concurrent first-calls
 * (race guard) don't spawn two servers.
 */
export async function connect(): Promise<void> {
  if (mongoose.connection.readyState === 1) return; // already connected
  if (connecting) return connecting;                // in-flight — share the promise

  connecting = (async () => {
    server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(server.getUri());
  })();
  await connecting;
}

/** Clear all collections between tests. Fast — no server restart. */
export async function clear(): Promise<void> {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

/**
 * Per-file teardown is intentionally a NO-OP.
 *
 * The server is shared across every test file in the process. Stopping it in
 * one file's `afterAll` would kill the connection other files still depend on.
 * Actual teardown happens in `stopShared()` via `process.once('beforeExit')`.
 */
export async function disconnect(): Promise<void> {
  // intentionally empty — teardown handled by stopShared() below
}

/** Best-effort teardown so the mongod child doesn't outlive the test process. */
async function stopShared(): Promise<void> {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (server) {
    await server.stop();
    server = undefined;
  }
}

process.once('beforeExit', () => {
  void stopShared();
});
