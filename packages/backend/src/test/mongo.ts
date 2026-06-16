/**
 * In-memory MongoDB test helper for bun test suites.
 *
 * Usage:
 *   import { connect, clear, disconnect } from '../test/mongo';
 *   beforeAll(connect);
 *   afterEach(clear);
 *   afterAll(disconnect);
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let server: MongoMemoryServer;

export async function connect(): Promise<void> {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
}

export async function clear(): Promise<void> {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
}

export async function disconnect(): Promise<void> {
  await mongoose.disconnect();
  await server.stop();
}
