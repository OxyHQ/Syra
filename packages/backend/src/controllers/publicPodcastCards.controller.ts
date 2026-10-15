import type { Request, Response } from 'express';
import { and, inArray } from 'drizzle-orm';
import {
  publicPodcastCardsRequestSchema,
  publicPodcastCardsResponseSchema,
} from '@syra.fm/contracts';
import { getDb } from '../db/postgres';
import { podcasts } from '../db/schema/podcasts';
import { listableShowFilter } from '../db/podcasts/visibility';

/** A single bounded query, with no owner exception and no external provider I/O. */
export async function getPublicPodcastCards(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const parsed = publicPodcastCardsRequestSchema.safeParse(req.body);
  if (!parsed.success || Object.keys(req.query).length > 0) {
    res.status(400).json({
      error: {
        code: 'bad_request',
        message: 'Expected 1–100 podcast IDs and no query parameters',
      },
    });
    return;
  }
  try {
    const ids = [...new Set(parsed.data.ids)];
    const rows = await getDb()
      .select({
        id: podcasts.id,
        title: podcasts.title,
        author: podcasts.author,
        imageId: podcasts.imageId,
        imageSourceUrl: podcasts.imageSourceUrl,
      })
      .from(podcasts)
      .where(and(listableShowFilter(), inArray(podcasts.id, ids)));
    const found = new Set(rows.map((row) => row.id));
    const items = rows.map((row) => ({
      id: row.id,
      title: row.title,
      ...(row.author === null ? {} : { author: row.author }),
      ...(row.imageId
        ? { artworkUrl: `https://api.syra.fm/api/images/${encodeURIComponent(row.imageId)}` }
        : row.imageSourceUrl && /^https?:\/\//.test(row.imageSourceUrl)
          ? { artworkUrl: row.imageSourceUrl }
          : {}),
      showUrl: `https://syra.fm/podcasts/${encodeURIComponent(row.id)}`,
    }));
    res.json(
      publicPodcastCardsResponseSchema.parse({
        items,
        unavailableIds: ids.filter((id) => !found.has(id)),
      }),
    );
  } catch {
    res
      .status(500)
      .json({ error: { code: 'internal_error', message: 'Unable to load podcast cards' } });
  }
}
