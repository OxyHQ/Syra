import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { connect, clear, disconnect } from '../../test/mongo';
import { TrackKeyModel } from '../../models/TrackKey';
import { storePackagedHls } from './hlsStorage';
import type { PackageResult } from './hlsPackager';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

// ── Synthetic package dir ─────────────────────────────────────────────────

let packageDir: string;

const TRACK_ID = 'aabbccddeeff001122334455';
const ARTIST_ID = 'ffeeddccbbaa554433221100';
const FAKE_KEY_HEX = 'deadbeefdeadbeefdeadbeefdeadbeef';
const BITRATES = [96, 160, 320] as const;

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

    await storePackagedHls(result, { trackId: TRACK_ID, artistId: ARTIST_ID }, { upload: fakeUpload });

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
      { trackId: TRACK_ID, artistId: ARTIST_ID },
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
      { trackId: TRACK_ID, artistId: ARTIST_ID },
      { upload: async () => {} },
    );

    expect(hlsMasterKey).toBe(`hls/${ARTIST_ID}/${TRACK_ID}/master.m3u8`);
  });

  it('persists a TrackKey doc with the correct keyHex and keyUri', async () => {
    const result = buildSyntheticPackage();
    await storePackagedHls(
      result,
      { trackId: TRACK_ID, artistId: ARTIST_ID },
      { upload: async () => {} },
    );

    const doc = await TrackKeyModel.findOne({ trackId: TRACK_ID });
    expect(doc).not.toBeNull();
    expect(doc?.keyHex).toBe(FAKE_KEY_HEX);
    expect(doc?.keyUri).toBe('key');
  });

  it('upserts TrackKey on re-import (idempotent)', async () => {
    const result = buildSyntheticPackage();
    const updatedResult = { ...result, keyHex: 'cafecafecafecafecafecafecafecafe' };

    await storePackagedHls(result, { trackId: TRACK_ID, artistId: ARTIST_ID }, { upload: async () => {} });
    await storePackagedHls(updatedResult, { trackId: TRACK_ID, artistId: ARTIST_ID }, { upload: async () => {} });

    const docs = await TrackKeyModel.find({ trackId: TRACK_ID });
    expect(docs).toHaveLength(1);
    expect(docs[0].keyHex).toBe('cafecafecafecafecafecafecafecafe');
  });
});
