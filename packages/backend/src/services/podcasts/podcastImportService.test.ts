import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { SafeFetchResult } from '@oxyhq/core/server';
import { connect, clear, disconnect } from '../../test/mongo';
import { PodcastModel } from '../../models/Podcast';
import { setCatalogImageMirrorImplementationForTests } from '../catalog/catalogImageAssets';
import { importFeed } from './podcastImportService';
import type { PodcastDirectoryCandidate } from './PodcastDirectory';

beforeAll(connect);
afterEach(async () => {
  await clear();
  setCatalogImageMirrorImplementationForTests(); // restore real mirror
});
afterAll(disconnect);

const SYRA_IMAGE_ID = '5f9d88b9c1f4e2a3b4c5d6e7';
const EXTERNAL_COVER = 'https://image.simplecastcdn.com/the-daily-cover.jpg';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>The Daily</title>
    <itunes:author>The New York Times</itunes:author>
    <itunes:image href="${EXTERNAL_COVER}"/>
    <item>
      <title>Episode One</title>
      <guid>ep-1</guid>
      <enclosure url="https://cdn.example/ep1.mp3" type="audio/mpeg"/>
      <pubDate>Wed, 01 Jan 2025 08:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

function fakeFetch(): SafeFetchResult {
  return {
    status: 200,
    headers: {},
    finalUrl: 'https://feeds.example/daily.xml',
    response: Readable.from([Buffer.from(FEED, 'utf-8')]) as unknown as IncomingMessage,
  };
}

const candidate: PodcastDirectoryCandidate = {
  feedUrl: 'https://feeds.example/daily.xml',
  title: 'The Daily',
  author: 'The New York Times',
  image: EXTERNAL_COVER,
  categories: [],
};

describe('importFeed — cover re-host (search/bulk-import deep path)', () => {
  it('replaces the external cover URL with a Syra S3 image id + sizes + primaryColor', async () => {
    setCatalogImageMirrorImplementationForTests(async (_images, context) => {
      expect(context.entityType).toBe('podcast'); // re-host runs as a podcast cover
      return {
        imageId: SYRA_IMAGE_ID,
        imageSizes: { large: { id: SYRA_IMAGE_ID, url: `/api/images/${SYRA_IMAGE_ID}`, width: 640, height: 640 } },
        primaryColor: '#123456',
        secondaryColor: '#654321',
        sourceUrlHash: 'u',
        sourceContentHash: 'c',
      };
    });

    const result = await importFeed(candidate.feedUrl, { directory: candidate, fetch: fakeFetch });

    const podcast = await PodcastModel.findById(result.podcast._id).lean();
    // `image` is a Syra id (resolves via /api/images/:id), NOT the external CDN url.
    expect(podcast?.image).toBe(SYRA_IMAGE_ID);
    expect(podcast?.image).not.toBe(EXTERNAL_COVER);
    expect(podcast?.imageSizes?.large?.id).toBe(SYRA_IMAGE_ID);
    expect(podcast?.primaryColor).toBe('#123456');
    // The external URL is kept only as a fallback.
    expect(podcast?.imageSourceUrl).toBe(EXTERNAL_COVER);
    // Deep import done → flag cleared.
    expect(podcast?.needsDeepImport).toBe(false);
  });

  it('keeps the external URL as a fallback when re-hosting fails (never stores it in `image`)', async () => {
    setCatalogImageMirrorImplementationForTests(async () => undefined); // mirror fails

    const result = await importFeed(candidate.feedUrl, { directory: candidate, fetch: fakeFetch });

    const podcast = await PodcastModel.findById(result.podcast._id).lean();
    expect(podcast?.image).toBeUndefined(); // never the external URL
    expect(podcast?.imageSourceUrl).toBe(EXTERNAL_COVER);
  });
});
