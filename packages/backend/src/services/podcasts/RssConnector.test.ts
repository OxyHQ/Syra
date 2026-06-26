import { describe, it, expect } from 'bun:test';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { SafeFetchResult } from '@oxyhq/core/server';
import { parseFeedXml, fetchAndParse } from './RssConnector';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:podcast="https://podcastindex.org/namespace/1.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Test Show</title>
    <description>A great show</description>
    <itunes:author>Jane Host</itunes:author>
    <language>en-us</language>
    <link>https://example.com</link>
    <itunes:type>serial</itunes:type>
    <itunes:explicit>yes</itunes:explicit>
    <itunes:image href="https://img.example/cover.jpg"/>
    <podcast:guid>9b024349-ccf0-5f69-a609-6b82873eab3c</podcast:guid>
    <itunes:category text="Technology">
      <itunes:category text="Tech News"/>
    </itunes:category>
    <itunes:category text="Society &amp; Culture"/>
    <podcast:funding url="https://donate.example">Support us</podcast:funding>
    <item>
      <title>Episode One</title>
      <guid isPermaLink="false">ep-001</guid>
      <description>Plain desc</description>
      <content:encoded>Rich HTML desc</content:encoded>
      <itunes:summary>Summary one</itunes:summary>
      <enclosure url="https://cdn.example/ep1.mp3" type="audio/mpeg" length="123456"/>
      <itunes:duration>1:01:05</itunes:duration>
      <pubDate>Wed, 01 Jan 2025 08:00:00 GMT</pubDate>
      <itunes:season>2</itunes:season>
      <itunes:episode>10</itunes:episode>
      <itunes:episodeType>full</itunes:episodeType>
      <itunes:explicit>false</itunes:explicit>
      <itunes:image href="https://img.example/ep1.jpg"/>
      <podcast:chapters url="https://cdn.example/ep1-chapters.json" type="application/json+chapters"/>
      <podcast:transcript url="https://cdn.example/ep1.vtt" type="text/vtt" language="en"/>
      <podcast:person role="host" img="https://img.example/jane.jpg" href="https://example.com/jane">Jane Host</podcast:person>
      <podcast:person role="guest">Guest Gary</podcast:person>
    </item>
    <item>
      <title>Episode Two</title>
      <enclosure url="https://cdn.example/ep2.mp3" type="audio/mpeg"/>
      <itunes:duration>305</itunes:duration>
      <pubDate>Thu, 02 Jan 2025 08:00:00 GMT</pubDate>
    </item>
    <item>
      <description>no title, no guid, no enclosure — must be skipped</description>
    </item>
  </channel>
</rss>`;

/** Build a fake SafeFetchResult whose `response` is a real readable stream. */
function fakeResult(status: number, body: string, headers: Record<string, string> = {}): SafeFetchResult {
  return {
    status,
    headers,
    finalUrl: 'https://feed.example/rss',
    // A node Readable satisfies the IncomingMessage surface the code uses
    // (on('data'|'end'|'error'), destroy()).
    response: Readable.from([Buffer.from(body, 'utf-8')]) as unknown as IncomingMessage,
  };
}

describe('parseFeedXml — show', () => {
  it('maps iTunes/Podcasting 2.0 channel fields', () => {
    const { show } = parseFeedXml(FEED);
    expect(show.title).toBe('Test Show');
    expect(show.description).toBe('A great show');
    expect(show.author).toBe('Jane Host');
    expect(show.image).toBe('https://img.example/cover.jpg');
    expect(show.language).toBe('en-us');
    expect(show.link).toBe('https://example.com');
    expect(show.type).toBe('serial');
    expect(show.explicit).toBe(true);
    expect(show.podcastGuid).toBe('9b024349-ccf0-5f69-a609-6b82873eab3c');
  });

  it('collects nested + decoded categories', () => {
    const { show } = parseFeedXml(FEED);
    expect(show.categories).toContain('Technology');
    expect(show.categories).toContain('Tech News');
    expect(show.categories).toContain('Society & Culture');
  });

  it('maps podcast:funding with url + message text', () => {
    const { show } = parseFeedXml(FEED);
    expect(show.funding).toEqual([{ url: 'https://donate.example', message: 'Support us' }]);
  });
});

describe('parseFeedXml — episodes', () => {
  it('skips items with no title and no guid/enclosure', () => {
    const { episodes } = parseFeedXml(FEED);
    expect(episodes).toHaveLength(2);
  });

  it('maps a fully-populated episode incl. 2.0 tags', () => {
    const ep = parseFeedXml(FEED).episodes[0];
    expect(ep.guid).toBe('ep-001');
    expect(ep.title).toBe('Episode One');
    expect(ep.description).toBe('Rich HTML desc'); // content:encoded wins over <description>
    expect(ep.summary).toBe('Summary one');
    expect(ep.enclosureUrl).toBe('https://cdn.example/ep1.mp3');
    expect(ep.enclosureType).toBe('audio/mpeg');
    expect(ep.enclosureLength).toBe(123456);
    expect(ep.duration).toBe(3665); // 1:01:05 → 3665s
    expect(ep.pubDate instanceof Date).toBe(true);
    expect(ep.season).toBe(2);
    expect(ep.episodeNumber).toBe(10);
    expect(ep.episodeType).toBe('full');
    expect(ep.explicit).toBe(false);
    expect(ep.image).toBe('https://img.example/ep1.jpg');
    expect(ep.chapters).toEqual({ url: 'https://cdn.example/ep1-chapters.json', type: 'application/json+chapters' });
    expect(ep.transcripts).toEqual([{ url: 'https://cdn.example/ep1.vtt', type: 'text/vtt', language: 'en' }]);
    expect(ep.persons).toHaveLength(2);
    expect(ep.persons[0]).toEqual({
      name: 'Jane Host',
      role: 'host',
      group: undefined,
      img: 'https://img.example/jane.jpg',
      href: 'https://example.com/jane',
    });
    expect(ep.persons[1].name).toBe('Guest Gary');
    expect(ep.persons[1].role).toBe('guest');
  });

  it('falls back to the enclosure URL as guid and applies defaults', () => {
    const ep = parseFeedXml(FEED).episodes[1];
    expect(ep.guid).toBe('https://cdn.example/ep2.mp3'); // no <guid> → enclosure url
    expect(ep.duration).toBe(305); // plain seconds
    expect(ep.enclosureLength).toBeUndefined();
    expect(ep.episodeType).toBe('full'); // default
    expect(ep.explicit).toBe(false); // default
    expect(ep.transcripts).toEqual([]);
    expect(ep.persons).toEqual([]);
  });

  it('throws when there is no <channel>', () => {
    expect(() => parseFeedXml('<rss></rss>')).toThrow();
  });
});

describe('fetchAndParse — conditional GET', () => {
  it('returns notModified on a 304 without parsing', async () => {
    const result = await fetchAndParse('https://feed.example/rss', { etag: 'abc' }, {
      fetch: async () => fakeResult(304, ''),
    });
    expect(result.notModified).toBe(true);
    expect(result.etag).toBe('abc');
    expect(result.show).toBeUndefined();
  });

  it('parses a 200 body and surfaces etag/last-modified headers', async () => {
    const result = await fetchAndParse('https://feed.example/rss', {}, {
      fetch: async () => fakeResult(200, FEED, { etag: '"v2"', 'last-modified': 'Thu, 02 Jan 2025 08:00:00 GMT' }),
    });
    expect(result.notModified).toBe(false);
    expect(result.show?.title).toBe('Test Show');
    expect(result.episodes).toHaveLength(2);
    expect(result.etag).toBe('"v2"');
    expect(result.lastModified).toBe('Thu, 02 Jan 2025 08:00:00 GMT');
  });

  it('throws on a non-2xx/304 status', async () => {
    await expect(
      fetchAndParse('https://feed.example/rss', {}, { fetch: async () => fakeResult(500, '') }),
    ).rejects.toThrow();
  });
});
