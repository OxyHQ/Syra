/**
 * Creating a Syra-hosted show owned by a person: the one row shape `POST
 * /api/podcasts` and the MCP `generate-episode` tool (for a new show) both
 * write. Artwork, credits and categories are the caller's to resolve first.
 */

import { uuidv7 } from '@oxy.so/db';
import type { CreatePodcastRequest } from '@syra/shared-types';
import { env } from '../../config/env';
import {
  insertPodcast,
  type PodcastChildValues,
  type PodcastValues,
} from '../../db/podcasts/podcasts';
import type { PodcastRow } from '../../db/podcasts/serialize';

export async function insertHostedPodcast(
  ownerOxyUserId: string,
  request: CreatePodcastRequest,
  options: {
    /** Minted by the caller when something (an adopted cover) is referenced by it first. */
    readonly id?: string;
    readonly values?: PodcastValues;
    readonly children?: PodcastChildValues;
  } = {},
): Promise<PodcastRow> {
  const id = options.id ?? uuidv7();
  return insertPodcast(
    {
      id,
      title: request.title,
      description: request.description,
      author: request.author,
      imageId: null,
      language: request.language,
      explicit: request.explicit ?? false,
      link: request.link,
      type: request.type ?? 'episodic',
      source: 'syra',
      ownerOxyUserId,
      claimable: false,
      status: 'active',
      /**
       * The one place a show's audience is CHOSEN: validated by
       * `createPodcastRequestSchema` (the same tuple as the column's CHECK);
       * absent means `'public'`, the column default. RSS-mirrored shows are
       * created by the import path, which never names this column.
       */
      visibility: request.visibility ?? 'public',
      aiGenerated: request.aiGenerated ?? false,
      // The public RSS URL is derived from the id, which is why it is minted here.
      feedUrl: `${env.STREAM_KEY_BASE_URL}/api/podcasts/${id}/rss`,
      ...options.values,
    },
    { categories: request.categories ?? [], ...options.children },
  );
}
