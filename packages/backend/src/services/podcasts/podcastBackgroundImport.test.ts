import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'bun:test';
import { connect, clear, disconnect } from '../../test/mongo';
import { PodcastModel } from '../../models/Podcast';
import type { PodcastDirectoryCandidate } from './PodcastDirectory';
import {
  runPodcastSearchImport,
  resetPodcastImportStateForTests,
  MAX_FEEDS_PER_SEARCH,
} from './podcastBackgroundImport';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);
beforeEach(() => resetPodcastImportStateForTests());

function candidate(n: number, extra: Partial<PodcastDirectoryCandidate> = {}): PodcastDirectoryCandidate {
  return {
    feedUrl: `https://feeds.example/${n}.xml`,
    title: `Show ${n}`,
    categories: [],
    ...extra,
  };
}

describe('runPodcastSearchImport — cap + dedup', () => {
  it('caps the number of feeds enqueued per search at MAX_FEEDS_PER_SEARCH', async () => {
    const enqueued: string[] = [];
    const many = Array.from({ length: 30 }, (_, i) => candidate(i));

    const result = await runPodcastSearchImport('news', {
      search: async () => many,
      enqueue: (feedUrl) => enqueued.push(feedUrl),
    });

    expect(result.skipped).toBe(false);
    expect(result.candidates).toBe(MAX_FEEDS_PER_SEARCH); // 30 sliced to 25
    expect(result.enqueued).toBe(MAX_FEEDS_PER_SEARCH);
    expect(enqueued).toHaveLength(MAX_FEEDS_PER_SEARCH);
  });

  it('dedupes candidates already in the catalog (by feedUrl and podcastGuid)', async () => {
    await PodcastModel.create({ title: 'Existing A', source: 'rss', feedUrl: 'https://feeds.example/0.xml', claimable: true });
    await PodcastModel.create({ title: 'Existing B', source: 'rss', feedUrl: 'https://feeds.example/other.xml', podcastGuid: 'guid-1', claimable: true });

    const enqueued: string[] = [];
    const candidates = [
      candidate(0), // existing by feedUrl → skipped
      candidate(1, { podcastGuid: 'guid-1' }), // existing by podcastGuid → skipped
      candidate(2), // new → enqueued
    ];

    const result = await runPodcastSearchImport('tech', {
      search: async () => candidates,
      enqueue: (feedUrl) => enqueued.push(feedUrl),
    });

    expect(result.candidates).toBe(3);
    expect(result.enqueued).toBe(1);
    expect(enqueued).toEqual(['https://feeds.example/2.xml']);
  });

  it('throttles repeat imports of the same query within the TTL window', async () => {
    const enqueued: string[] = [];
    const deps = {
      search: async () => [candidate(1)],
      enqueue: (feedUrl: string) => enqueued.push(feedUrl),
      now: () => 1_000, // frozen clock → second call is within TTL
    };

    const first = await runPodcastSearchImport('same', deps);
    const second = await runPodcastSearchImport('same', deps);

    expect(first.skipped).toBe(false);
    expect(first.enqueued).toBe(1);
    expect(second.skipped).toBe(true);
    expect(second.enqueued).toBe(0);
    expect(enqueued).toHaveLength(1); // not enqueued twice
  });

  it('is a no-op for a blank query', async () => {
    const result = await runPodcastSearchImport('   ', { search: async () => [candidate(1)], enqueue: () => {} });
    expect(result).toEqual({ skipped: true, candidates: 0, enqueued: 0 });
  });
});
