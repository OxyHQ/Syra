import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../../test/mongo';
import { EpisodeModel } from '../../models/Episode';
import { ingestEpisode } from './ingestEpisode';
import { HLS_BITRATES_KBPS, LOCKER_HLS_BITRATES_KBPS } from '../ingest/hlsPackager';
import type { PackageOptions, PackageResult } from '../ingest/hlsPackager';
import type { StoreHlsTarget, StoredHls } from '../ingest/hlsStorage';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

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

const PODCAST_ID = new mongoose.Types.ObjectId();

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
    manifestKey: `hls/${PODCAST_ID.toString()}/e/${r.bitrateKbps}/stream.m3u8`,
    bitrateKbps: r.bitrateKbps,
    encrypted: true,
  })),
  hlsMasterKey: `hls/${PODCAST_ID.toString()}/e/master.m3u8`,
};

const happyDeps = {
  fetchSource: async () => ({ localPath: '/tmp/fake-episode.mp3', cleanup: () => {} }),
  packageHls: async () => CANNED_PACKAGE_RESULT,
  storeHls: async () => CANNED_STORED,
};

async function createEpisode() {
  return EpisodeModel.create({
    podcastId: PODCAST_ID,
    podcastTitle: 'A Show',
    title: 'An Episode',
    guid: `guid-${new mongoose.Types.ObjectId().toString()}`,
    pubDate: new Date(),
    source: 'syra',
    status: 'processing',
    audioSource: { url: '/api/podcasts/episodes/fake/audio', format: 'mp3' },
  });
}

describe('ingestEpisode — shared-pipeline regression guards', () => {
  it('packages with the CATALOGUE ladder, never the single-rendition locker one', async () => {
    const episode = await createEpisode();
    let received: PackageOptions | undefined;

    await ingestEpisode(episode._id.toString(), {
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
    const episodeId = episode._id.toString();

    await ingestEpisode(episodeId, happyDeps);

    const reloaded = await EpisodeModel.findById(episodeId);
    expect(reloaded?.status).toBe('ready');
    expect(reloaded?.hls).toHaveLength(HLS_BITRATES_KBPS.length);
    expect(reloaded?.hls?.map((r) => r.bitrateKbps)).toEqual([...HLS_BITRATES_KBPS]);
  });

  it('keeps its own hls/{podcastId}/{episodeId}/ layout, not the locker prefix', async () => {
    const episode = await createEpisode();
    const episodeId = episode._id.toString();
    let target: StoreHlsTarget | undefined;

    await ingestEpisode(episodeId, {
      ...happyDeps,
      storeHls: async (_result: PackageResult, storeTarget: StoreHlsTarget) => {
        target = storeTarget;
        return CANNED_STORED;
      },
    });

    expect(target?.recordId).toBe(episodeId);
    expect(target?.buildKey('master.m3u8')).toBe(
      `hls/${PODCAST_ID.toString()}/${episodeId}/master.m3u8`,
    );
    expect(target?.buildKey('master.m3u8').startsWith('hls/uploads/')).toBe(false);
  });

  it('records failed rather than leaving the episode processing forever', async () => {
    const episode = await createEpisode();
    const episodeId = episode._id.toString();

    await expect(
      ingestEpisode(episodeId, {
        ...happyDeps,
        packageHls: async (): Promise<PackageResult> => {
          throw new Error('ffmpeg exploded');
        },
      }),
    ).rejects.toThrow('ffmpeg exploded');

    expect((await EpisodeModel.findById(episodeId))?.status).toBe('failed');
  });
});
