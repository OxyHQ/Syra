import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { podcasts } from '../../db/schema/podcasts';
import { findEpisodeById, insertEpisode } from '../../db/podcasts/episodes';
import { loadEpisodeHls } from '../../db/podcasts/hydrate';
import { ingestEpisode } from './ingestEpisode';
import { HLS_BITRATES_KBPS, LOCKER_HLS_BITRATES_KBPS } from '../ingest/hlsPackager';
import type { PackageOptions, PackageResult } from '../ingest/hlsPackager';
import type { StoreHlsTarget, StoredHls } from '../ingest/hlsStorage';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

/**
 * Podcast episodes are a SHIPPED feature that shares `packageToEncryptedHls` and
 * `storePackagedHls` with the music pipeline. Both of those grew options for the
 * personal-locker path — a single-rendition ladder and a caller-supplied S3 key
 * builder — and an episode inheriting either by accident would typecheck, pass,
 * and silently downgrade every episode's audio or scatter its objects.
 *
 * These tests pin the episode path to the CATALOGUE ladder and to its existing
 * `hls/{podcastId}/{episodeId}/…` layout. There was no coverage of this call at
 * all before, which is why the exposure was invisible.
 */

/**
 * A real `podcasts` row, not a bare id.
 *
 * `episodes.podcast_id` is a foreign key now, so an episode fixture pointing at
 * a show that does not exist fails with `23503` rather than inserting the way
 * the Mongo fixture did. Created per test file, in `beforeAll`.
 */
const PODCAST_ID = uuidv7();

const CANNED_PACKAGE_RESULT: PackageResult = {
  outputDir: '/tmp/fake-episode-output',
  masterPlaylistPath: 'master.m3u8',
  renditions: [
    { bitrateKbps: 96, playlistPath: '96/stream.m3u8' },
    { bitrateKbps: 160, playlistPath: '160/stream.m3u8' },
    { bitrateKbps: 320, playlistPath: '320/stream.m3u8' },
  ],
  keyHex: 'abadcafeabadcafeabadcafeabadcafe',
  keyUri: '/api/podcasts/episodes/fake/key',
  loudnessLufs: -16.1,
};

const CANNED_STORED: StoredHls = {
  hls: CANNED_PACKAGE_RESULT.renditions.map((r) => ({
    manifestKey: `hls/${PODCAST_ID}/e/${r.bitrateKbps}/stream.m3u8`,
    bitrateKbps: r.bitrateKbps,
    encrypted: true,
  })),
  hlsMasterKey: `hls/${PODCAST_ID}/e/master.m3u8`,
};

const happyDeps = {
  fetchSource: async () => ({ localPath: '/tmp/fake-episode.mp3', cleanup: () => {} }),
  packageHls: async () => CANNED_PACKAGE_RESULT,
  storeHls: async () => CANNED_STORED,
};

async function createShow() {
  await getDb()
    .insert(podcasts)
    .values({ id: PODCAST_ID, title: 'A Show', source: 'syra', status: 'active' })
    .onConflictDoNothing();
}

async function createEpisode() {
  await createShow();
  return insertEpisode({
    podcastId: PODCAST_ID,
    podcastTitle: 'A Show',
    title: 'An Episode',
    guid: `guid-${uuidv7()}`,
    pubDate: new Date(),
    source: 'syra',
    status: 'processing',
    audioSourceUrl: '/api/podcasts/episodes/fake/audio',
    audioSourceFormat: 'mp3',
  });
}

describe('ingestEpisode — shared-pipeline regression guards', () => {
  it('packages with the CATALOGUE ladder, never the single-rendition locker one', async () => {
    const episode = await createEpisode();
    let received: PackageOptions | undefined;

    await ingestEpisode(episode.id, {
      ...happyDeps,
      packageHls: async (opts: PackageOptions) => {
        received = opts;
        return CANNED_PACKAGE_RESULT;
      },
    });

    // Omitting the ladder is what selects the catalogue default; asserting the
    // absence is asserting that no locker ladder leaked in.
    expect(received?.bitratesKbps).toBeUndefined();
    expect(HLS_BITRATES_KBPS).not.toEqual(LOCKER_HLS_BITRATES_KBPS);
  });

  it('ends up with three renditions, not one', async () => {
    const episode = await createEpisode();
    const episodeId = episode.id;

    await ingestEpisode(episodeId, happyDeps);

    const reloaded = await findEpisodeById(episodeId);
    expect(reloaded?.status).toBe('ready');
    // The ladder is `episode_hls_renditions` now, and `position` is what keeps
    // the order the Mongo array had — so this asserts the ORDER too, which is
    // what a bitrate list read back out of a set would silently lose.
    const hls = (await loadEpisodeHls([episodeId])).get(episodeId) ?? [];
    expect(hls).toHaveLength(HLS_BITRATES_KBPS.length);
    expect(hls.map((r) => r.bitrateKbps)).toEqual([...HLS_BITRATES_KBPS]);
  });

  it('keeps its own hls/{podcastId}/{episodeId}/ layout, not the locker prefix', async () => {
    const episode = await createEpisode();
    const episodeId = episode.id;
    let target: StoreHlsTarget | undefined;

    await ingestEpisode(episodeId, {
      ...happyDeps,
      storeHls: async (_result: PackageResult, storeTarget: StoreHlsTarget) => {
        target = storeTarget;
        return CANNED_STORED;
      },
    });

    expect(target?.recordId).toBe(episodeId);
    expect(target?.buildKey('master.m3u8')).toBe(`hls/${PODCAST_ID}/${episodeId}/master.m3u8`);
    expect(target?.buildKey('master.m3u8').startsWith('hls/uploads/')).toBe(false);
  });

  it('records failed rather than leaving the episode processing forever', async () => {
    const episode = await createEpisode();
    const episodeId = episode.id;

    await expect(
      ingestEpisode(episodeId, {
        ...happyDeps,
        packageHls: async (): Promise<PackageResult> => {
          throw new Error('ffmpeg exploded');
        },
      }),
    ).rejects.toThrow('ffmpeg exploded');

    expect((await findEpisodeById(episodeId))?.status).toBe('failed');
  });
});
