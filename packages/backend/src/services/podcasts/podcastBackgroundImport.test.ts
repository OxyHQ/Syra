import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'bun:test';
import { connect, clear, disconnect } from '../../test/mongo';
import { PodcastModel } from '../../models/Podcast';
import type { PodcastDirectoryCandidate } from './PodcastDirectory';
import {
  syncPodcastSearch,
  resetPodcastImportStateForTests,
  MAX_FEEDS_PER_SEARCH,
} from './podcastBackgroundImport';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);
beforeEach(() => resetPodcastImportStateForTests());

const NOW = 1_000_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function candidate(n: number, extra: Partial<PodcastDirectoryCandidate> = {}): PodcastDirectoryCandidate {
  return {
    feedUrl: `https://feeds.example/${n}.xml`,
    title: `Show ${n}`,
    author: `Author ${n}`,
    image: `https://img.example/${n}.jpg`,
    categories: [],
    ...extra,
  };
}

describe('syncPodcastSearch — shallow upsert + deep scheduling', () => {
  it('shallow-upserts candidates instantly (no feed fetch) and caps at MAX_FEEDS_PER_SEARCH', async () => {
    const enqueued: string[] = [];
    const many = Array.from({ length: 30 }, (_, i) => candidate(i));

    const result = await syncPodcastSearch('news', {
      search: async () => many,
      enqueue: (feedUrl) => enqueued.push(feedUrl),
      now: () => NOW,
    });

    expect(result.skipped).toBe(false);
    expect(result.candidates).toBe(MAX_FEEDS_PER_SEARCH); // 30 sliced to 25
    expect(result.shallowUpserted).toBe(MAX_FEEDS_PER_SEARCH);
    expect(await PodcastModel.countDocuments({})).toBe(MAX_FEEDS_PER_SEARCH);

    const doc = await PodcastModel.findOne({ feedUrl: 'https://feeds.example/0.xml' }).lean();
    expect(doc?.title).toBe('Show 0');
    expect(doc?.author).toBe('Author 0');
    expect(doc?.imageSourceUrl).toBe('https://img.example/0.jpg');
    expect(doc?.image).toBeUndefined(); // no Syra id yet (deep import re-hosts)
    expect(doc?.source).toBe('rss');
    expect(doc?.needsDeepImport).toBe(true);

    // Every new (needsDeepImport) show is enqueued for the background deep import.
    expect(result.deepEnqueued).toBe(MAX_FEEDS_PER_SEARCH);
    expect(enqueued).toHaveLength(MAX_FEEDS_PER_SEARCH);
  });

  it('REFRESHES an existing show and does NOT re-enqueue it when fresh', async () => {
    await PodcastModel.create({
      title: 'Old Title',
      author: 'Old Author',
      source: 'rss',
      feedUrl: 'https://feeds.example/0.xml',
      needsDeepImport: false,
      lastRefreshedAt: new Date(NOW), // fresh
    });

    const enqueued: string[] = [];
    const result = await syncPodcastSearch('tech', {
      search: async () => [candidate(0)],
      enqueue: (feedUrl) => enqueued.push(feedUrl),
      now: () => NOW,
    });

    const doc = await PodcastModel.findOne({ feedUrl: 'https://feeds.example/0.xml' }).lean();
    expect(doc?.title).toBe('Show 0'); // metadata refreshed from the directory
    expect(doc?.author).toBe('Author 0');
    expect(doc?.imageSourceUrl).toBe('https://img.example/0.jpg');
    expect(doc?.needsDeepImport).toBe(false); // not re-flagged
    expect(result.deepEnqueued).toBe(0); // fresh → no heavy re-fetch
    expect(enqueued).toHaveLength(0);
  });

  it('re-enqueues a STALE existing show for a deep refresh', async () => {
    await PodcastModel.create({
      title: 'Old',
      source: 'rss',
      feedUrl: 'https://feeds.example/0.xml',
      needsDeepImport: false,
      lastRefreshedAt: new Date(NOW - 2 * DAY_MS), // stale (> 24h)
    });

    const enqueued: string[] = [];
    const result = await syncPodcastSearch('stale', {
      search: async () => [candidate(0)],
      enqueue: (feedUrl) => enqueued.push(feedUrl),
      now: () => NOW,
    });

    expect(result.deepEnqueued).toBe(1);
    expect(enqueued).toEqual(['https://feeds.example/0.xml']);
  });

  it('throttles repeat syncs of the same query within the TTL window', async () => {
    const enqueued: string[] = [];
    const deps = {
      search: async () => [candidate(1)],
      enqueue: (feedUrl: string) => enqueued.push(feedUrl),
      now: () => NOW,
    };

    const first = await syncPodcastSearch('same', deps);
    const second = await syncPodcastSearch('same', deps);

    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
    expect(await PodcastModel.countDocuments({})).toBe(1); // not upserted twice
  });

  it('is a no-op for a blank query', async () => {
    const result = await syncPodcastSearch('   ', { search: async () => [candidate(1)], enqueue: () => {} });
    expect(result).toEqual({ skipped: true, candidates: 0, shallowUpserted: 0, deepEnqueued: 0 });
    expect(await PodcastModel.countDocuments({})).toBe(0);
  });
});
