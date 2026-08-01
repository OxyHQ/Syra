import { z } from 'zod';
import {
  artistClaimResponseSchema,
  entityProfileSchema,
  type ArtistClaim,
  type EntityProfile,
} from '@syra/shared-types';
import { api, publicApi } from '@/utils/api';
import {
  normalizeAlbumImages,
  normalizePlaylistImages,
  normalizeTrackImages,
} from '@/utils/catalogImages';

/**
 * Unified entity profile service — `GET /api/p/:id` returns the merged
 * Artist + Person profile (`EntityProfile`): identity (name/avatar/image/bio),
 * the entity's `music` (tracks + albums) when it is/links a music artist, and
 * `appearsIn` (podcasts/episodes) when it is/links a podcast host/guest.
 *
 * Catalog read → `publicApi`. Music track/album cover ids are normalized through
 * the shared catalog image pipeline (same as `musicService`); podcast/episode
 * artwork resolves at render via the shared catalog picker `resolvePodcastArtwork`
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

    // EVERY shelf that renders artwork is normalized, not just `music`. The
    // catalog ships bare image ids; a section whose ids never pass through here
    // renders a grid of blank cards, which looks like missing data rather than a
    // missing conversion.
    return {
      ...profile,
      music: profile.music
        ? {
            tracks: profile.music.tracks.map(normalizeTrackImages),
            albums: profile.music.albums.map(normalizeAlbumImages),
          }
        : undefined,
      discography: profile.discography
        ? {
            albums: profile.discography.albums.map(normalizeAlbumImages),
            singlesAndEps: profile.discography.singlesAndEps.map(normalizeAlbumImages),
            compilations: profile.discography.compilations.map(normalizeAlbumImages),
          }
        : undefined,
      creditedOn: profile.creditedOn?.map((credited) => ({
        ...credited,
        track: normalizeTrackImages(credited.track),
      })),
      playlists: profile.playlists?.map(normalizePlaylistImages),
    };
  },

  /**
   * Ask to be recognised as this artist.
   *
   * NEVER grants anything: the backend opens a PENDING `ArtistClaim` for a human
   * to review, because an auto-granted claim on a profile built from a stranger's
   * file tags is the impersonation risk the whole contribution path is designed
   * around.
   */
  async claimArtist(artistId: string, evidence: string): Promise<ArtistClaim> {
    const response = await api.post<unknown>(`/artists/${artistId}/claim`, { evidence });
    const parsed = artistClaimResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Invalid artist claim response: ${parsed.error.message}`);
    }
    return parsed.data.claim;
  },
};
