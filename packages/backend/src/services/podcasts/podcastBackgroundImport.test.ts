import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'bun:test';
import { count, eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { podcasts } from '../../db/schema/podcasts';
import { findPodcastByFeedUrl } from '../../db/podcasts/podcasts';
import type { PodcastDirectoryCandidate } from './PodcastDirectory';
import {
  syncPodcastSearch,
  resetPodcastImportStateForTests,
  MAX_FEEDS_PER_SEARCH,
  MAX_THROTTLE_KEYS,
} from './podcastBackgroundImport';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);
beforeEach(() => resetPodcastImportStateForTests());

/** How many shows exist — the Mongo `countDocuments({})` equivalent. */
async function showCount(): Promise<number> {
  const [row] = await getDb().select({ total: count() }).from(podcasts);
  return row?.total ?? 0;
}

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
    expect(await showCount()).toBe(MAX_FEEDS_PER_SEARCH);

    const row = await findPodcastByFeedUrl('https://feeds.example/0.xml');
    expect(row?.title).toBe('Show 0');
    expect(row?.author).toBe('Author 0');
    expect(row?.imageSourceUrl).toBe('https://img.example/0.jpg');
    expect(row?.imageId).toBeNull(); // no Syra id yet (deep import re-hosts)
    expect(row?.source).toBe('rss');
    expect(row?.needsDeepImport).toBe(true);

    // Every new (needsDeepImport) show is enqueued for the background deep import.
    expect(result.deepEnqueued).toBe(MAX_FEEDS_PER_SEARCH);
    expect(enqueued).toHaveLength(MAX_FEEDS_PER_SEARCH);
  });

  it('REFRESHES an existing show and does NOT re-enqueue it when fresh', async () => {
    await getDb().insert(podcasts).values({
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

    const row = await findPodcastByFeedUrl('https://feeds.example/0.xml');
    expect(row?.title).toBe('Show 0'); // metadata refreshed from the directory
    expect(row?.author).toBe('Author 0');
    expect(row?.imageSourceUrl).toBe('https://img.example/0.jpg');
    expect(row?.needsDeepImport).toBe(false); // not re-flagged
    expect(result.deepEnqueued).toBe(0); // fresh → no heavy re-fetch
    expect(enqueued).toHaveLength(0);
  });

  it('re-enqueues a STALE existing show for a deep refresh', async () => {
    await getDb().insert(podcasts).values({
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
    expect(await showCount()).toBe(1); // not upserted twice
  });

  it('is a no-op for a blank query', async () => {
    const result = await syncPodcastSearch('   ', { search: async () => [candidate(1)], enqueue: () => {} });
    expect(result).toEqual({ skipped: true, candidates: 0, shallowUpserted: 0, deepEnqueued: 0 });
    expect(await showCount()).toBe(0);
  });
});

describe('syncPodcastSearch — the throttle map is bounded', () => {
  // `lastSyncAt` is keyed on the caller's own search string and reached without
  // authentication, so an unbounded map is a memory leak anyone can drive. These
  // assert the bound BEHAVIOURALLY — an evicted key stops being throttled — so
  // they keep working if the eviction strategy is ever rewritten.
  const noCandidates = { search: async () => [], enqueue: async () => {}, now: () => NOW };

  it('evicts the oldest key once the cap is exceeded, so it can sync again inside its TTL', async () => {
    const first = await syncPodcastSearch('oldest query', noCandidates);
    expect(first.skipped).toBe(false);

    for (let i = 0; i < MAX_THROTTLE_KEYS; i += 1) {
      await syncPodcastSearch(`filler query ${i}`, noCandidates);
    }

    // One millisecond later — far inside SEARCH_IMPORT_TTL_MS. Admitted only
    // because the key itself is gone.
    const again = await syncPodcastSearch('oldest query', { ...noCandidates, now: () => NOW + 1 });
    expect(again.skipped).toBe(false);
  });

  it('CONTROL: without exceeding the cap the same key stays throttled', async () => {
    // Without this, the test above passes just as well against a map that never
    // remembers anything at all.
    const first = await syncPodcastSearch('sticky query', noCandidates);
    expect(first.skipped).toBe(false);

    for (let i = 0; i < 10; i += 1) {
      await syncPodcastSearch(`few fillers ${i}`, noCandidates);
    }

    const again = await syncPodcastSearch('sticky query', { ...noCandidates, now: () => NOW + 1 });
    expect(again.skipped).toBe(true);
  });
});
