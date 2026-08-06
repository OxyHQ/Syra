import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { trackKeys } from '../../db/schema/catalog';
import { storePackagedHls } from './hlsStorage';
import { getS3HlsKey, getS3LockerHlsKey } from '../../config/s3.config';
import type { PackageResult } from './hlsPackager';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

/** Every `track_keys` row filed under one id. */
function keysFor(trackId: string) {
  return getDb().select().from(trackKeys).where(eq(trackKeys.trackId, trackId));
}

// ── Synthetic package dir ─────────────────────────────────────────────────

let packageDir: string;

const TRACK_ID = 'aabbccddeeff001122334455';
const ARTIST_ID = 'ffeeddccbbaa554433221100';
const UPLOAD_ID = '0011223344556677889900aa';
const OWNER_ID = 'oxy-locker-owner';
const FAKE_KEY_HEX = 'deadbeefdeadbeefdeadbeefdeadbeef';
const BITRATES = [96, 160, 320] as const;

/** Catalog target: keys under the artist, AES key filed under the track id. */
function catalogTarget() {
  return {
    kind: 'track' as const,
    recordId: TRACK_ID,
    buildKey: (relPath: string) => getS3HlsKey(ARTIST_ID, TRACK_ID, relPath),
  };
}

/** Locker target: keys under `hls/uploads/{owner}/{uploadId}/`, no artist id. */
function lockerTarget() {
  return {
    kind: 'user_upload' as const,
    recordId: UPLOAD_ID,
    buildKey: (relPath: string) => getS3LockerHlsKey(OWNER_ID, UPLOAD_ID, relPath),
  };
}

function buildSyntheticPackage(): PackageResult {
  packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-storage-test-'));

  // master.m3u8
  fs.writeFileSync(path.join(packageDir, 'master.m3u8'), '#EXTM3U\n', 'utf8');

  // per-bitrate dirs
  for (const kbps of BITRATES) {
    const dir = path.join(packageDir, String(kbps));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'stream.m3u8'), `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'segment-0.ts'), Buffer.alloc(8), );
  }

  return {
    outputDir: packageDir,
    masterPlaylistPath: 'master.m3u8',
    renditions: BITRATES.map((bitrateKbps) => ({
      bitrateKbps,
      playlistPath: `${bitrateKbps}/stream.m3u8`,
    })),
    keyHex: FAKE_KEY_HEX,
    keyUri: 'key',
    loudnessLufs: -14.0,
  };
}

afterAll(() => {
  if (packageDir) fs.rmSync(packageDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('storePackagedHls', () => {
  it('uploads every file under outputDir with correct S3 keys and contentTypes', async () => {
    const result = buildSyntheticPackage();

    const uploaded: { key: string; contentType: string; length: number }[] = [];
    const fakeUpload = async (
      key: string,
      body: Buffer,
      opts: { contentType: string },
    ): Promise<void> => {
      uploaded.push({ key, contentType: opts.contentType, length: body.length });
    };

    await storePackagedHls(result, catalogTarget(), { upload: fakeUpload });

    // 7 files total: 1 master + 3 × (1 playlist + 1 segment)
    expect(uploaded).toHaveLength(7);

    const prefix = `hls/${ARTIST_ID}/${TRACK_ID}/`;
    for (const u of uploaded) {
      expect(u.key.startsWith(prefix)).toBe(true);
    }

    // Content-type assertions
    const m3u8s = uploaded.filter((u) => u.key.endsWith('.m3u8'));
    const tss = uploaded.filter((u) => u.key.endsWith('.ts'));
    expect(m3u8s.length).toBe(4); // 1 master + 3 variant
    expect(tss.length).toBe(3);
    for (const m of m3u8s) {
      expect(m.contentType).toBe('application/vnd.apple.mpegurl');
    }
    for (const t of tss) {
      expect(t.contentType).toBe('video/mp2t');
    }
  });

  it('returns hls[] with 3 entries: correct manifestKey, bitrateKbps, encrypted:true', async () => {
    const result = buildSyntheticPackage();
    const { hls } = await storePackagedHls(
      result,
      catalogTarget(),
      { upload: async () => {} },
    );

    expect(hls).toHaveLength(3);
    for (const [i, kbps] of BITRATES.entries()) {
      expect(hls[i].bitrateKbps).toBe(kbps);
      expect(hls[i].encrypted).toBe(true);
      expect(hls[i].manifestKey).toBe(
        `hls/${ARTIST_ID}/${TRACK_ID}/${kbps}/stream.m3u8`,
      );
    }
  });

  it('returns hlsMasterKey pointing at master.m3u8', async () => {
    const result = buildSyntheticPackage();
    const { hlsMasterKey } = await storePackagedHls(
      result,
      catalogTarget(),
      { upload: async () => {} },
    );

    expect(hlsMasterKey).toBe(`hls/${ARTIST_ID}/${TRACK_ID}/master.m3u8`);
  });

  it('persists a TrackKey doc with the correct keyHex and keyUri', async () => {
    const result = buildSyntheticPackage();
    await storePackagedHls(
      result,
      catalogTarget(),
      { upload: async () => {} },
    );

    const [row] = await keysFor(TRACK_ID);
    expect(row).toBeDefined();
    expect(row?.keyHex).toBe(FAKE_KEY_HEX);
    expect(row?.keyUri).toBe('key');
    // The discriminator Mongo had no column for. A locker key filed as a
    // catalog track would still be found by id, so nothing else here can tell
    // the two apart.
    expect(row?.kind).toBe('track');
  });

  it('upserts TrackKey on re-import (idempotent)', async () => {
    const result = buildSyntheticPackage();
    const updatedResult = { ...result, keyHex: 'cafecafecafecafecafecafecafecafe' };

    await storePackagedHls(result, catalogTarget(), { upload: async () => {} });
    await storePackagedHls(updatedResult, catalogTarget(), { upload: async () => {} });

    const rows = await keysFor(TRACK_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.keyHex).toBe('cafecafecafecafecafecafecafecafe');
  });

  it('a locker target writes under hls/uploads/, never into the catalog artist space', async () => {
    const result = buildSyntheticPackage();
    const uploaded: string[] = [];

    const { hlsMasterKey, hls } = await storePackagedHls(result, lockerTarget(), {
      upload: async (key: string) => {
        uploaded.push(key);
      },
    });

    expect(hlsMasterKey).toBe(`hls/uploads/${OWNER_ID}/${UPLOAD_ID}/master.m3u8`);
    for (const key of [...uploaded, hlsMasterKey, ...hls.map((r) => r.manifestKey)]) {
      expect(key.startsWith(`hls/uploads/${OWNER_ID}/${UPLOAD_ID}/`)).toBe(true);
    }
  });

  it('a locker target files the AES key under the UPLOAD id', async () => {
    // `GET /api/uploads/:id/stream/key` looks it up by the upload id; filed under
    // anything else the locker plays back silence.
    const result = buildSyntheticPackage();
    await storePackagedHls(result, lockerTarget(), { upload: async () => {} });

    expect(await keysFor(UPLOAD_ID)).toHaveLength(1);
    expect(await keysFor(TRACK_ID)).toHaveLength(0);
  });

  it('every locker key keeps the upload id as a whole path segment above the manifest', async () => {
    /**
     * This is the exact predicate `compliance/takedown.ts` `hlsDirectoryPrefix()`
     * applies: find the upload id as a segment, and require it NOT to be the last
     * one. Fail it and a copyright purge deletes the documents while leaving every
     * .ts segment in the bucket — silently, with only a WARN.
     */
    const result = buildSyntheticPackage();
    const { hlsMasterKey, hls } = await storePackagedHls(result, lockerTarget(), {
      upload: async () => {},
    });

    for (const key of [hlsMasterKey, ...hls.map((r) => r.manifestKey)]) {
      const segments = key.split('/');
      const index = segments.indexOf(UPLOAD_ID);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(segments.length - 1);
      expect(`${segments.slice(0, index + 1).join('/')}/`).toBe(
        `hls/uploads/${OWNER_ID}/${UPLOAD_ID}/`,
      );
    }
  });
});
