import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { catalogEntities, tracks } from '../../db/schema/catalog';
import { userUploads } from '../../db/schema/creators';
import { episodes, podcasts } from '../../db/schema/podcasts';
import { trackKeys } from '../../db/schema/trackKeys';
import { storePackagedHls } from './hlsStorage';
import { getS3HlsKey, getS3LockerHlsKey } from '../../config/s3.config';
import type { PackageResult } from './hlsPackager';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

/**
 * Every `track_keys` row filed under one id, ON THE ARM THAT ID BELONGS TO.
 *
 * Three reads and not one `where id = ?`, because that is exactly the
 * distinction the table now draws: each id space has its own column with its
 * own foreign key, so a key filed under the wrong arm resolves to nothing
 * rather than to somebody else's key.
 */
function catalogKeysFor(id: string) {
  return getDb().select().from(trackKeys).where(eq(trackKeys.trackId, id));
}

function lockerKeysFor(id: string) {
  return getDb().select().from(trackKeys).where(eq(trackKeys.userUploadId, id));
}

function episodeKeysFor(id: string) {
  return getDb().select().from(trackKeys).where(eq(trackKeys.episodeId, id));
}

// ── Real parent rows ──────────────────────────────────────────────────────

/**
 * The ids these tests file keys under are real rows now, re-seeded per test
 * because `clearDb` truncates between them.
 *
 * They used to be hard-coded 24-char hex literals naming nothing, which worked
 * while `track_keys.track_id` carried no constraint. Each column references its
 * parent `ON DELETE cascade` now, so an id that names no row is refused at the
 * insert — the whole point of the change, and what would otherwise make these
 * fixtures a test of nothing.
 */
let ARTIST_ID: string;
let TRACK_ID: string;
let UPLOAD_ID: string;
let EPISODE_ID: string;
let PODCAST_ID: string;

const OWNER_ID = 'oxy-locker-owner';
const FAKE_KEY_HEX = 'deadbeefdeadbeefdeadbeefdeadbeef';
const BITRATES = [96, 160, 320] as const;

let seedCounter = 0;

beforeEach(async () => {
  const db = getDb();
  seedCounter += 1;

  const [artist] = await db
    .insert(catalogEntities)
    .values({ name: 'HLS Storage Artist', type: 'artist', source: 'upload' })
    .returning({ id: catalogEntities.id });
  ARTIST_ID = artist.id;

  const [track] = await db
    .insert(tracks)
    .values({
      title: 'HLS Storage Track',
      artistId: artist.id,
      artistName: 'HLS Storage Artist',
      duration: 180,
      source: 'upload',
    })
    .returning({ id: tracks.id });
  TRACK_ID = track.id;

  const [upload] = await db
    .insert(userUploads)
    .values({
      ownerOxyUserId: OWNER_ID,
      title: 'HLS Storage Upload',
      duration: 210,
      sizeBytes: 5_242_880,
      sha256: seedCounter.toString(16).padStart(64, '0'),
      status: 'ready',
    })
    .returning({ id: userUploads.id });
  UPLOAD_ID = upload.id;

  const [podcast] = await db
    .insert(podcasts)
    .values({ title: 'HLS Storage Show', feedUrl: `https://example.test/${seedCounter}.xml`, source: 'syra' })
    .returning({ id: podcasts.id });
  PODCAST_ID = podcast.id;

  const [episode] = await db
    .insert(episodes)
    .values({
      podcastId: podcast.id,
      podcastTitle: 'HLS Storage Show',
      title: 'HLS Storage Episode',
      guid: `hls-storage-episode-${seedCounter}`,
      pubDate: new Date('2026-01-01T00:00:00.000Z'),
      source: 'syra',
    })
    .returning({ id: episodes.id });
  EPISODE_ID = episode.id;
});

// ── Synthetic package dir ─────────────────────────────────────────────────

let packageDir: string;

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

/** Episode target: `hls/{podcastId}/{episodeId}/`, exactly as `ingestEpisode` builds it. */
function episodeTarget() {
  return {
    kind: 'episode' as const,
    recordId: EPISODE_ID,
    buildKey: (relPath: string) => getS3HlsKey(PODCAST_ID, EPISODE_ID, relPath),
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

    const [row] = await catalogKeysFor(TRACK_ID);
    expect(row).toBeDefined();
    expect(row?.keyHex).toBe(FAKE_KEY_HEX);
    expect(row?.keyUri).toBe('key');
    // The arm, which is what `kind` used to assert and the three columns now
    // enforce: filed on `track_id`, and the other two explicitly null rather
    // than merely absent. `track_keys_one_parent_check` would refuse any other
    // combination, so this is a check on the WRITER choosing the right one.
    expect(row?.userUploadId).toBeNull();
    expect(row?.episodeId).toBeNull();
  });

  it('upserts TrackKey on re-import (idempotent)', async () => {
    const result = buildSyntheticPackage();
    const updatedResult = { ...result, keyHex: 'cafecafecafecafecafecafecafecafe' };

    await storePackagedHls(result, catalogTarget(), { upload: async () => {} });
    await storePackagedHls(updatedResult, catalogTarget(), { upload: async () => {} });

    const rows = await catalogKeysFor(TRACK_ID);
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

    expect(await lockerKeysFor(UPLOAD_ID)).toHaveLength(1);
    expect(await catalogKeysFor(TRACK_ID)).toHaveLength(0);
  });

  it('an episode target files the AES key under the EPISODE id', async () => {
    // The third arm, and the one with the least coverage elsewhere: an episode
    // key filed on `track_id` would fail no constraint — `episodes.id` and
    // `tracks.id` are both uuid v7 — it would simply never be found by
    // `GET /api/podcasts/episodes/:id/stream/key`, and the episode would play
    // back silence.
    const result = buildSyntheticPackage();
    await storePackagedHls(result, episodeTarget(), { upload: async () => {} });

    expect(await episodeKeysFor(EPISODE_ID)).toHaveLength(1);
    expect(await catalogKeysFor(EPISODE_ID)).toHaveLength(0);
    expect(await lockerKeysFor(EPISODE_ID)).toHaveLength(0);
  });

  it('re-ingesting an episode rotates its key in place rather than inserting a second row', async () => {
    // The upsert's conflict target is selected by `kind`. A fixed
    // `target: trackKeys.trackId` would never conflict here — `track_id` is
    // null on this row and Postgres treats nulls as distinct — so the second
    // call would insert a SECOND row and fail `track_keys_episode_id_key`.
    const result = buildSyntheticPackage();
    await storePackagedHls(result, episodeTarget(), { upload: async () => {} });
    await storePackagedHls(
      { ...result, keyHex: 'cafecafecafecafecafecafecafecafe' },
      episodeTarget(),
      { upload: async () => {} },
    );

    const rows = await episodeKeysFor(EPISODE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.keyHex).toBe('cafecafecafecafecafecafecafecafe');
  });

  it('re-ingesting a locker upload rotates its key in place rather than inserting a second row', async () => {
    // Same conflict-target reasoning as the episode case above, on the arm that
    // actually ships today.
    const result = buildSyntheticPackage();
    await storePackagedHls(result, lockerTarget(), { upload: async () => {} });
    await storePackagedHls(
      { ...result, keyHex: 'cafecafecafecafecafecafecafecafe' },
      lockerTarget(),
      { upload: async () => {} },
    );

    const rows = await lockerKeysFor(UPLOAD_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.keyHex).toBe('cafecafecafecafecafecafecafecafe');
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
