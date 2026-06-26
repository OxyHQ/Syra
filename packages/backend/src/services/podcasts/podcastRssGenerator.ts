/**
 * Public RSS generator for Syra-hosted shows. Emits RSS 2.0 with the iTunes and
 * Podcasting 2.0 namespaces so the feed validates against Apple/Podcast Index
 * and can be submitted to external directories (Syra acts as the host).
 *
 * The enclosure points at the public progressive-download endpoint
 * (`/api/podcasts/episodes/:id/audio`), which serves the creator's original
 * uploaded file — HLS is the in-app encrypted path and is NOT a valid podcast
 * enclosure. Built with a small string builder (no heavy XML dependency).
 */

import type { IPodcast } from '../../models/Podcast';
import type { IEpisode } from '../../models/Episode';

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

function enclosureMime(episode: IEpisode): string {
  if (episode.enclosureType) return episode.enclosureType;
  const format = episode.audioSource?.format;
  return (format && FORMAT_MIME[format]) || 'audio/mpeg';
}

/**
 * Render a podcast + its episodes (newest first) into an RSS XML string.
 * `baseUrl` is the public API origin (e.g. `https://api.syra.fm`).
 */
export function generatePodcastRss(podcast: IPodcast, episodes: IEpisode[], baseUrl: string): string {
  const podcastId = podcast._id.toString();
  const selfUrl = `${baseUrl}/api/podcasts/${podcastId}/rss`;

  const channelLines: string[] = [
    `<title>${escapeXml(podcast.title)}</title>`,
    `<link>${escapeXml(podcast.link ?? `${baseUrl}/api/podcasts/${podcastId}`)}</link>`,
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
  if (podcast.image) {
    channelLines.push(`<itunes:image href="${escapeXml(podcast.image)}"/>`);
  }
  if (podcast.podcastGuid) {
    channelLines.push(`<podcast:guid>${escapeXml(podcast.podcastGuid)}</podcast:guid>`);
  }
  for (const category of podcast.categories ?? []) {
    channelLines.push(`<itunes:category text="${escapeXml(category)}"/>`);
  }
  for (const fund of podcast.funding ?? []) {
    channelLines.push(`<podcast:funding url="${escapeXml(fund.url)}">${escapeXml(fund.message ?? '')}</podcast:funding>`);
  }

  const itemLines: string[] = [];
  for (const episode of episodes) {
    const episodeId = episode._id.toString();
    const enclosureUrl = `${baseUrl}/api/podcasts/episodes/${episodeId}/audio`;
    const lines: string[] = [
      `<title>${escapeXml(episode.title)}</title>`,
      `<guid isPermaLink="false">${escapeXml(episode.guid)}</guid>`,
      `<pubDate>${episode.pubDate.toUTCString()}</pubDate>`,
      `<enclosure url="${escapeXml(enclosureUrl)}" length="${episode.enclosureLength ?? 0}" type="${escapeXml(enclosureMime(episode))}"/>`,
      `<itunes:duration>${Math.max(0, Math.round(episode.duration ?? 0))}</itunes:duration>`,
      `<itunes:episodeType>${episode.episodeType ?? 'full'}</itunes:episodeType>`,
      `<itunes:explicit>${episode.explicit ? 'true' : 'false'}</itunes:explicit>`,
    ];
    if (episode.description) lines.push(`<description>${cdata(episode.description)}</description>`);
    if (episode.summary) lines.push(`<itunes:summary>${cdata(episode.summary)}</itunes:summary>`);
    if (episode.season !== undefined) lines.push(`<itunes:season>${episode.season}</itunes:season>`);
    if (episode.episodeNumber !== undefined) lines.push(`<itunes:episode>${episode.episodeNumber}</itunes:episode>`);
    if (episode.image) lines.push(`<itunes:image href="${escapeXml(episode.image)}"/>`);

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
