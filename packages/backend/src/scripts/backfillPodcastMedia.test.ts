import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../test/mongo';
import { PodcastModel } from '../models/Podcast';
import { EpisodeModel } from '../models/Episode';
import { setCatalogImageMirrorImplementationForTests } from '../services/catalog/catalogImageAssets';
import { backfillPodcasts, backfillEpisodes } from './backfillPodcastMedia';

beforeAll(connect);
afterEach(async () => {
  await clear();
  setCatalogImageMirrorImplementationForTests();
});
afterAll(disconnect);

const SYRA_ID = '5f9d88b9c1f4e2a3b4c5d6e7';

function mockMirror(): void {
  setCatalogImageMirrorImplementationForTests(async () => ({
    imageId: SYRA_ID,
    imageSizes: { large: { id: SYRA_ID, url: `/api/images/${SYRA_ID}`, width: 640, height: 640 } },
    primaryColor: '#111111',
    secondaryColor: '#222222',
    sourceUrlHash: 'u',
    sourceContentHash: 'c',
  }));
}

describe('backfill keyset pagination', () => {
  it('processes EVERY podcast across multiple pages, skips done docs, and terminates', async () => {
    mockMirror();

    // 25 need backfill (external url, no re-hosted variants) → 3 pages at batchSize 10.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        PodcastModel.create({
          title: `Show ${i}`,
          source: 'rss',
          feedUrl: `https://feeds.example/${i}.xml`,
          imageSourceUrl: `https://img.example/${i}.jpg`,
          status: 'active',
        }),
      ),
    );
    // 3 already-done (re-hosted variants present) → must be skipped.
    const doneId = new mongoose.Types.ObjectId().toString();
    await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        PodcastModel.create({
          title: `Done ${i}`,
          source: 'rss',
          feedUrl: `https://feeds.example/done-${i}.xml`,
          image: doneId,
          imageSizes: { large: { id: doneId, url: `/api/images/${doneId}`, width: 640, height: 640 } },
          status: 'active',
        }),
      ),
    );

    const stats = await backfillPodcasts(10);

    expect(stats.processed).toBe(25);
    expect(stats.rehosted).toBe(25);

    // A backfilled show now carries the Syra id + variants + color, external as fallback.
    const sample = await PodcastModel.findOne({ feedUrl: 'https://feeds.example/0.xml' }).lean();
    expect(sample?.image).toBe(SYRA_ID);
    expect(sample?.imageSizes?.large?.id).toBe(SYRA_ID);
    expect(sample?.primaryColor).toBe('#111111');
    expect(sample?.imageSourceUrl).toBe('https://img.example/0.jpg');

    // Done docs untouched.
    const done = await PodcastModel.findOne({ feedUrl: 'https://feeds.example/done-0.xml' }).lean();
    expect(done?.image).toBe(doneId);

    // All 25 needing backfill are now re-hosted → a second run is a no-op (idempotent).
    const second = await backfillPodcasts(10);
    expect(second.processed).toBe(0);
    expect(second.rehosted).toBe(0);
  });

  it('paginates episodes the same way (multi-page, terminates)', async () => {
    mockMirror();
    const podcastId = new mongoose.Types.ObjectId();

    await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        EpisodeModel.create({
          podcastId,
          podcastTitle: 'Show',
          title: `Episode ${i}`,
          guid: `guid-${i}`,
          pubDate: new Date(),
          source: 'rss',
          imageSourceUrl: `https://img.example/e${i}.jpg`,
          status: 'ready',
        }),
      ),
    );

    const stats = await backfillEpisodes(10); // 2 pages (10 + 5)
    expect(stats.processed).toBe(15);
    expect(stats.rehosted).toBe(15);

    const sample = await EpisodeModel.findOne({ guid: 'guid-0' }).lean();
    expect(sample?.image).toBe(SYRA_ID);
    expect(sample?.imageSizes?.large?.id).toBe(SYRA_ID);
  });
});
