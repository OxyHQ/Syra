/**
 * Public RSS generator for Syra-hosted shows. Emits RSS 2.0 with the iTunes and
 * Podcasting 2.0 namespaces so the feed validates against Apple/Podcast Index
 * and can be submitted to external directories (Syra acts as the host).
 *
 * The enclosure points at the public progressive-download endpoint
 * (`/api/podcasts/episodes/:id/audio`), which serves the creator's original
 * uploaded file — HLS is the in-app encrypted path and is NOT a valid podcast
 * enclosure. Built with a small string builder (no heavy XML dependency).
 *
 * ## It takes DTOs now, not documents
 *
 * It used to take `IPodcast`/`IEpisode` and read `podcast.categories`,
 * `podcast.funding`, `episode.audioSource` and `episode.pubDate` straight off
 * the Mongo document. Four of those are child tables or flattened columns since
 * `schema/podcasts.ts`, so a `podcasts` ROW cannot answer them — only a
 * serialized `Podcast`/`Episode` can, and the caller is already building both.
 * Taking the DTO also means this module has no database dependency at all, which
 * is what makes it testable with a literal.
 */

import type { Episode, Podcast } from '@syra/shared-types';

const FORMAT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  flac: 'audio/flac',
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Wrap free HTML in CDATA, neutralising any embedded `]]>` terminator. */
function cdata(value: string): string {
  return `<![CDATA[${value.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function enclosureMime(episode: Episode): string {
  if (episode.enclosureType) return episode.enclosureType;
  const format = episode.audioSource?.format;
  return (format && FORMAT_MIME[format]) || 'audio/mpeg';
}

/**
 * Make an artwork reference absolute against the public API origin.
 *
 * The Mongo version emitted `podcast.image` verbatim, and that field held a bare
 * 24-character image id — so every `<itunes:image href="…">` in every generated
 * feed carried a hex string where a URL belongs. Apple and Podcast Index both
 * reject that, silently, by showing no artwork. The DTO normalises the id to
 * `/api/images/:id`, which is a real path but still relative, and an RSS feed is
 * read by a third party that has no origin to resolve it against. So it is made
 * absolute here.
 *
 * This is a FIX, not a port — the old output was never usable — and it is called
 * out rather than folded in silently because a reviewer diffing the two will see
 * a URL that did not used to be there.
 */
function absoluteImage(image: string | undefined, baseUrl: string): string | undefined {
  if (!image) return undefined;
  if (image.startsWith('http://') || image.startsWith('https://')) return image;
  return `${baseUrl}${image.startsWith('/') ? '' : '/'}${image}`;
}

/**
 * Render a podcast + its episodes (newest first) into an RSS XML string.
 * `baseUrl` is the public API origin (e.g. `https://api.syra.fm`).
 */
export function generatePodcastRss(
  podcast: Podcast,
  episodes: readonly Episode[],
  baseUrl: string
): string {
  const selfUrl = `${baseUrl}/api/podcasts/${podcast.id}/rss`;

  const channelLines: string[] = [
    `<title>${escapeXml(podcast.title)}</title>`,
    `<link>${escapeXml(podcast.link ?? `${baseUrl}/api/podcasts/${podcast.id}`)}</link>`,
    `<language>${escapeXml(podcast.language ?? 'en')}</language>`,
    `<atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>`,
    `<itunes:type>${podcast.type === 'serial' ? 'serial' : 'episodic'}</itunes:type>`,
    `<itunes:explicit>${podcast.explicit ? 'true' : 'false'}</itunes:explicit>`,
  ];

  if (podcast.description) {
    channelLines.push(`<description>${cdata(podcast.description)}</description>`);
    channelLines.push(`<itunes:summary>${cdata(podcast.description)}</itunes:summary>`);
  }
  if (podcast.author) {
    channelLines.push(`<itunes:author>${escapeXml(podcast.author)}</itunes:author>`);
  }
  const showImage = absoluteImage(podcast.image, baseUrl);
  if (showImage) {
    channelLines.push(`<itunes:image href="${escapeXml(showImage)}"/>`);
  }
  if (podcast.podcastGuid) {
    channelLines.push(`<podcast:guid>${escapeXml(podcast.podcastGuid)}</podcast:guid>`);
  }
  for (const category of podcast.categories ?? []) {
    channelLines.push(`<itunes:category text="${escapeXml(category)}"/>`);
  }
  for (const fund of podcast.funding ?? []) {
    channelLines.push(
      `<podcast:funding url="${escapeXml(fund.url)}">${escapeXml(fund.message ?? '')}</podcast:funding>`
    );
  }

  const itemLines: string[] = [];
  for (const episode of episodes) {
    const enclosureUrl = `${baseUrl}/api/podcasts/episodes/${episode.id}/audio`;
    const lines: string[] = [
      `<title>${escapeXml(episode.title)}</title>`,
      `<guid isPermaLink="false">${escapeXml(episode.guid)}</guid>`,
      `<pubDate>${new Date(episode.pubDate).toUTCString()}</pubDate>`,
      `<enclosure url="${escapeXml(enclosureUrl)}" length="${episode.enclosureLength ?? 0}" type="${escapeXml(enclosureMime(episode))}"/>`,
      `<itunes:duration>${Math.max(0, Math.round(episode.duration ?? 0))}</itunes:duration>`,
      `<itunes:episodeType>${episode.episodeType ?? 'full'}</itunes:episodeType>`,
      `<itunes:explicit>${episode.explicit ? 'true' : 'false'}</itunes:explicit>`,
    ];
    if (episode.description) lines.push(`<description>${cdata(episode.description)}</description>`);
    if (episode.summary) lines.push(`<itunes:summary>${cdata(episode.summary)}</itunes:summary>`);
    if (episode.season !== undefined) lines.push(`<itunes:season>${episode.season}</itunes:season>`);
    if (episode.episodeNumber !== undefined) {
      lines.push(`<itunes:episode>${episode.episodeNumber}</itunes:episode>`);
    }
    /**
     * The episode's OWN artwork only.
     *
     * `toEpisodeDto` fills `image` from the parent show when the episode carries
     * none, which is right for a client rendering a list and wrong here: an RSS
     * item with no `<itunes:image>` already inherits the channel's, so emitting
     * the show's cover on every item just triples the feed size. The DTO cannot
     * tell the caller which of the two it returned, so this compares.
     */
    const episodeImage = absoluteImage(episode.image, baseUrl);
    if (episodeImage && episode.image !== podcast.image) {
      lines.push(`<itunes:image href="${escapeXml(episodeImage)}"/>`);
    }

    itemLines.push(`    <item>\n      ${lines.join('\n      ')}\n    </item>`);
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    '  <channel>',
    `    ${channelLines.join('\n    ')}`,
    itemLines.join('\n'),
    '  </channel>',
    '</rss>',
  ].join('\n');
}
