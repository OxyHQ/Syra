import { z } from 'zod';
import { entityProfileSchema, type EntityProfile } from '@syra/shared-types';
import { publicApi } from '@/utils/api';
import { normalizeAlbumImages, normalizeTrackImages } from '@/utils/catalogImages';

/**
 * Unified entity profile service — `GET /api/p/:id` returns the merged
 * Artist + Person profile (`EntityProfile`): identity (name/avatar/image/bio),
 * the entity's `music` (tracks + albums) when it is/links a music artist, and
 * `appearsIn` (podcasts/episodes) when it is/links a podcast host/guest.
 *
 * Catalog read → `publicApi`. Music track/album cover ids are normalized through
 * the shared catalog image pipeline (same as `musicService`); podcast/episode
 * artwork resolves at render via the shared catalog picker `pickCatalogImageUrl`
 * (Syra-hosted `image`/`imageSizes` first, external `imageSourceUrl` last).
 */

const entityProfileResponseSchema = z.object({
  data: entityProfileSchema.passthrough(),
}).passthrough();

export const entityService = {
  async getEntityProfile(id: string): Promise<EntityProfile> {
    const response = await publicApi.get<unknown>(`/p/${id}`);
    const parsed = entityProfileResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Invalid entity profile response: ${parsed.error.message}`);
    }
    const profile = parsed.data.data;

    return {
      ...profile,
      music: profile.music
        ? {
            tracks: profile.music.tracks.map(normalizeTrackImages),
            albums: profile.music.albums.map(normalizeAlbumImages),
          }
        : undefined,
    };
  },
};
