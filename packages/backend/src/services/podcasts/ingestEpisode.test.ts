import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { podcasts } from '../../db/schema/podcasts';
import { eq } from 'drizzle-orm';
import {
  findEpisodeById,
  findEpisodeIdsAwaitingHls,
  insertEpisode,
} from '../../db/podcasts/episodes';
import { loadEpisodeHls } from '../../db/podcasts/hydrate';
import { enqueueDeferredEpisodeIngests, ingestEpisode } from './ingestEpisode';
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

async function createShow(visibility: 'private' | 'unlisted' | 'public' = 'public') {
  await getDb()
    .insert(podcasts)
    .values({ id: PODCAST_ID, title: 'A Show', source: 'syra', status: 'active', visibility })
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

    const reloaded = (await findEpisodeById(episodeId))?.episode;
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

    expect((await findEpisodeById(episodeId))?.episode.status).toBe('failed');
  });
});

describe('ingestEpisode — a private show gets no HLS ladder', () => {
  /**
   * WHY the refusal exists, since a reader will reasonably ask why a transcode
   * cares about visibility: a variant playlist hands the player a presigned S3
   * URL per segment, valid for `SEGMENT_URL_TTL_SEC` (six hours) with no auth of
   * its own. Once one is out, no change to `podcasts.visibility` can recall it.
   * For a public or unlisted show that is the intended trade; for a private one
   * it is not a trade at all, so the ladder is never built.
   */
  it('refuses to package, and leaves the episode ALONE rather than failing it', async () => {
    await createShow('private');
    const episode = await insertEpisode({
      podcastId: PODCAST_ID,
      podcastTitle: 'A Show',
      title: 'A Private Episode',
      guid: `guid-${uuidv7()}`,
      pubDate: new Date(),
      source: 'syra',
      status: 'processing',
      audioSourceUrl: '/api/podcasts/episodes/fake/audio',
      audioSourceFormat: 'mp3',
    });

    let packaged = false;
    await ingestEpisode(episode.id, {
      ...happyDeps,
      packageHls: async () => {
        packaged = true;
        return CANNED_PACKAGE_RESULT;
      },
    });

    expect(packaged).toBe(false);

    // NOT `failed`, and that is the load-bearing half. `findEpisodeIdsAwaitingHls`
    // finds a deferred episode by its missing `hls_master_key`, and marking it
    // failed would be indistinguishable from a transcode that genuinely broke —
    // but more importantly, nothing failed: it is waiting for its show.
    const reloaded = (await findEpisodeById(episode.id))?.episode;
    expect(reloaded?.status).toBe('processing');
    expect(reloaded?.hlsMasterKey).toBeNull();
  });

  it('packages the SAME episode once the show stops being private', async () => {
    /**
     * The positive control for the refusal above, on the same fixture: the
     * episode, the deps and the pipeline are identical and only the show's
     * visibility differs, so "it did not package" cannot be explained by a
     * broken fixture.
     *
     * It also exercises the transition path `updatePodcast` takes —
     * `enqueueDeferredEpisodeIngests` finds the episode by its missing
     * `hls_master_key`, which is the reason the refusal above must not have
     * written one.
     */
    await createShow('private');
    const episode = await insertEpisode({
      podcastId: PODCAST_ID,
      podcastTitle: 'A Show',
      title: 'A Published Episode',
      guid: `guid-${uuidv7()}`,
      pubDate: new Date(),
      source: 'syra',
      status: 'processing',
      audioSourceUrl: '/api/podcasts/episodes/fake/audio',
      audioSourceFormat: 'mp3',
    });

    await ingestEpisode(episode.id, happyDeps);
    expect((await findEpisodeById(episode.id))?.episode.hlsMasterKey).toBeNull();

    await getDb().update(podcasts).set({ visibility: 'public' }).where(eq(podcasts.id, PODCAST_ID));
    await ingestEpisode(episode.id, happyDeps);

    const reloaded = (await findEpisodeById(episode.id))?.episode;
    expect(reloaded?.status).toBe('ready');
    expect(reloaded?.hlsMasterKey).toBe(CANNED_STORED.hlsMasterKey);
  });

  it('enqueueDeferredEpisodeIngests picks up exactly the episodes with no ladder', async () => {
    await createShow('public');

    /**
     * No `audioSourceFormat`, and that is what makes this test DETERMINISTIC
     * rather than timed.
     *
     * `enqueueDeferredEpisodeIngests` is fire-and-forget by design — a show with
     * a long back catalogue must not block the PATCH on ffmpeg — so the effect
     * has to be observable without waiting on a real transcode. An episode with
     * a source URL but no format is selected by `findEpisodeIdsAwaitingHls`
     * (which filters on `audio_source_url`) and then refused by `ingestEpisode`
     * on its very first check, before any S3 call: it writes `failed` and
     * returns. So "it was picked up and run" is observable in milliseconds and
     * touches no network.
     */
    const withoutLadder = await insertEpisode({
      podcastId: PODCAST_ID,
      podcastTitle: 'A Show',
      title: 'Deferred',
      guid: `guid-${uuidv7()}`,
      pubDate: new Date(),
      source: 'syra',
      status: 'processing',
      audioSourceUrl: '/api/podcasts/episodes/fake/audio',
    });
    const withLadder = await insertEpisode({
      podcastId: PODCAST_ID,
      podcastTitle: 'A Show',
      title: 'Already transcoded',
      guid: `guid-${uuidv7()}`,
      pubDate: new Date(),
      source: 'syra',
      status: 'ready',
      audioSourceUrl: '/api/podcasts/episodes/fake/audio',
      audioSourceFormat: 'mp3',
      hlsMasterKey: 'hls/already/master.m3u8',
    });

    // The SELECTION, first and on its own: `enqueueDeferredEpisodeIngests` is a
    // loop over this, so asserting the ids is what says the loop runs over the
    // right set rather than over every episode of the show.
    expect(await findEpisodeIdsAwaitingHls(PODCAST_ID)).toEqual([withoutLadder.id]);

    await enqueueDeferredEpisodeIngests(PODCAST_ID);
    // One tick for the fire-and-forget promises to settle. The refusal above is
    // synchronous after a single `update`, so this needs no polling.
    await Bun.sleep(50);

    const deferred = (await findEpisodeById(withoutLadder.id))?.episode;
    expect(deferred?.status).toBe('failed');

    // The one that already had a ladder was NOT touched — the discriminator
    // that makes the query a filter rather than "every episode of the show".
    const untouched = (await findEpisodeById(withLadder.id))?.episode;
    expect(untouched?.status).toBe('ready');
    expect(untouched?.hlsMasterKey).toBe('hls/already/master.m3u8');
  });
});
