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
import { MongoMemoryServer } from 'mongodb-memory-server';

let server: MongoMemoryServer | undefined;
let connecting: Promise<void> | undefined;

/**
 * Connect once per test process; subsequent calls from other test files reuse
 * the same server. The in-flight promise is shared so concurrent first-calls
 * (race guard) don't spawn two servers.
 */
export async function connect(): Promise<void> {
  if (mongoose.connection.readyState === 1) return; // already connected
  if (connecting) return connecting;                // in-flight — share the promise

  connecting = (async () => {
    server = await MongoMemoryServer.create();
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
