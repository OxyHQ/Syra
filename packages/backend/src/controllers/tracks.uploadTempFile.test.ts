import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { uuidv7 } from '@oxyhq/db';
import { normalizeNameKey } from '@syra/shared-types';
import { clear, connect, disconnect } from '../test/mongo';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities } from '../db/schema/catalog';
import tracksRoutes from '../routes/tracks.routes';

/**
 * The upload endpoint writes the multipart body to a temp file (multer
 * `diskStorage`) so ffprobe/fpcalc/music-metadata can read a path instead of the
 * request being buffered whole in memory. Nothing else deletes that file: a
 * rejected upload that leaves it behind fills the task's disk one 200MB request
 * at a time, and the failure is invisible until the container dies.
 *
 * The temp file is identified by multer's own naming — `crypto.randomBytes(16)`
 * hex, so exactly 32 lowercase hex characters with no extension (see
 * `multer/storage/disk.js`). Leftovers are found by diffing that set across the
 * request rather than by watching the whole of `os.tmpdir()`, so files belonging
 * to anything else in the process are irrelevant.
 */

const OWNER_ID = 'oxy-upload-owner';

/** Exactly multer's default `getFilename` output shape. */
const MULTER_TEMP_NAME = /^[0-9a-f]{32}$/;

function multerTempFiles(): Set<string> {
  return new Set(fs.readdirSync(os.tmpdir()).filter((name) => MULTER_TEMP_NAME.test(name)));
}

/**
 * BOTH databases: the catalogue is Postgres, and `connect()` stays because
 * `tracks.routes` mounts handlers from `recommendations.controller`, whose
 * module graph still opens Mongoose at import time.
 */
beforeAll(async () => {
  await connect();
  await connectDb();
});
afterEach(async () => {
  await clear();
  await clearDb();
});
afterAll(async () => {
  await disconnect();
  await disconnectDb();
});

/** An artist owned by `owner`, on the Postgres side. */
async function makeArtist(name: string, owner: string): Promise<string> {
  const unique = `${name} ${uuidv7()}`;
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: unique,
      nameKey: normalizeNameKey(unique),
      source: 'upload',
      ownerOxyUserId: owner,
    })
    .returning({ id: catalogEntities.id });
  if (!artist) throw new Error('makeArtist: insert returned no row');
  return artist.id;
}

/** Serve the tracks router on an ephemeral port, authenticated as `OWNER_ID`. */
async function withUploadServer(exercise: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use((req, _res, next) => {
    (req as AuthRequest).user = { id: OWNER_ID };
    next();
  });
  app.use('/api/tracks', tracksRoutes);

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });

  try {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected the test server to bind a TCP port');
    }
    await exercise(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Files matching multer's naming that exist now but did not before the request.
 *
 * The temp file is removed in a `finally` that runs after the response is
 * flushed, so poll rather than reading the directory once.
 */
async function leakedTempFiles(before: Set<string>, timeoutMs = 3_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let leaked = [...multerTempFiles()].filter((name) => !before.has(name));
  while (leaked.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    leaked = [...multerTempFiles()].filter((name) => !before.has(name));
  }
  return leaked;
}

function audioForm(fields: Record<string, string>, bytes: string): FormData {
  const form = new FormData();
  form.append('audioFile', new Blob([bytes], { type: 'audio/mpeg' }), 'track.mp3');
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

describe('POST /api/tracks/upload temp file lifecycle', () => {
  it('detects a leaked temp file when nothing removes it', async () => {
    // Vacuity floor: `leakedTempFiles` is the instrument every assertion below
    // relies on, so prove it can report a leak before trusting it to report none.
    const before = multerTempFiles();
    const planted = path.join(os.tmpdir(), 'a'.repeat(32));
    fs.writeFileSync(planted, 'leak');
    try {
      expect(await leakedTempFiles(before, 200)).toEqual([path.basename(planted)]);
    } finally {
      fs.rmSync(planted, { force: true });
    }
  });

  it('removes the temp file when the request is rejected for missing fields', async () => {
    const before = multerTempFiles();
    await withUploadServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tracks/upload`, {
        method: 'POST',
        // No title and no artistId — rejected well before any probing or S3 work.
        body: audioForm({}, 'irrelevant bytes'),
      });

      expect(response.status).toBe(400);
      expect(await leakedTempFiles(before)).toEqual([]);
    });
  });

  it('removes the temp file when the artist is not owned by the caller', async () => {
    const foreignArtistId = await makeArtist('Someone Else', 'oxy-different-user');

    const before = multerTempFiles();
    await withUploadServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tracks/upload`, {
        method: 'POST',
        body: audioForm(
          { title: 'Borrowed', artistId: foreignArtistId },
          'irrelevant bytes',
        ),
      });

      expect(response.status).toBe(403);
      expect(await leakedTempFiles(before)).toEqual([]);
    });
  });

  it('removes the temp file when ffprobe cannot read the upload', async () => {
    const artistId = await makeArtist('Owned Artist', OWNER_ID);

    const before = multerTempFiles();
    await withUploadServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tracks/upload`, {
        method: 'POST',
        // Declared audio/mpeg so the multer filter passes; the bytes are not audio,
        // so the probe is the thing that rejects it.
        body: audioForm(
          { title: 'Not Really Audio', artistId },
          'this is definitely not an mp3',
        ),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'Unreadable audio' });
      expect(await leakedTempFiles(before)).toEqual([]);
    });
  });

  it('rejects a non-audio mime type without writing anything to disk', async () => {
    const before = multerTempFiles();
    await withUploadServer(async (baseUrl) => {
      const form = new FormData();
      form.append('audioFile', new Blob(['#!/bin/sh'], { type: 'text/plain' }), 'payload.sh');
      form.append('title', 'Nope');
      form.append('artistId', '507f1f77bcf86cd799439011');

      const response = await fetch(`${baseUrl}/api/tracks/upload`, { method: 'POST', body: form });

      expect(response.status).toBe(400);
      expect(await leakedTempFiles(before)).toEqual([]);
    });
  });
});
