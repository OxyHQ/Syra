import { z } from 'zod';
import { timestampsSchema } from './common';
import {
  catalogSourceSchema,
  catalogImageSizesSchema,
  externalIdsSchema,
  sourceProvenanceSchema,
  trackImageSchema,
} from './track';

export const artistStatsSchema = z.object({
  followers: z.number(),
  albums: z.number(),
  tracks: z.number(),
  totalPlays: z.number(),
  monthlyListeners: z.number().optional(),
});
export type ArtistStats = z.infer<typeof artistStatsSchema>;

export const artistStrikeSchema = z.object({
  _id: z.string().optional(),
  reason: z.string(),
  createdAt: z.string(),
  trackId: z.string().optional(),
});
export type ArtistStrike = z.infer<typeof artistStrikeSchema>;

export const artistLinksSchema = z.object({
  website: z.string().optional(),
  instagram: z.string().optional(),
  x: z.string().optional(),
  youtube: z.string().optional(),
});

export const artistSchema = timestampsSchema.extend({
  id: z.string(),
  _id: z.string().optional(),
  name: z.string(),
  bio: z.string().optional(),
  image: z.string().optional(),
  imageSizes: catalogImageSizesSchema.optional(),
  genres: z.array(z.string()).optional(),
  verified: z.boolean().optional(),
  popularity: z.number().optional(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  ownerOxyUserId: z.string().optional(),
  stats: artistStatsSchema,
  strikeCount: z.number().optional(),
  strikes: z.array(artistStrikeSchema).optional(),
  uploadsDisabled: z.boolean().optional(),
  lastStrikeAt: z.string().optional(),
  terminated: z.boolean().optional(),
  terminatedAt: z.string().optional(),
  terminationReason: z.string().optional(),
  source: catalogSourceSchema,
  externalIds: externalIdsSchema.optional(),
  sources: z.array(sourceProvenanceSchema).optional(),
  images: z.array(trackImageSchema).optional(),
  links: artistLinksSchema.optional(),
  country: z.string().optional(),
  claimable: z.boolean().optional(),
  claimedByOxyUserId: z.string().optional(),
});
export type Artist = z.infer<typeof artistSchema>;

export const artistWithContextSchema = artistSchema.extend({
  isFollowed: z.boolean().optional(),
});
export type ArtistWithContext = z.infer<typeof artistWithContextSchema>;

/**
 * Self-service artist registration fields.
 *
 * `verified` is deliberately NOT here, for the same reason it is absent from
 * `updateArtistRequestSchema` below — it is a platform-granted badge, never a
 * client input. It matters more on this schema than on that one: registration
 * is the self-service path, so a contract that accepted `verified` would invite
 * a caller to verify themselves at the very moment they create their own
 * profile. `registerAsArtist` hardcodes it to false server-side.
 */
export const createArtistRequestSchema = z.object({
  name: z.string(),
  bio: z.string().optional(),
  image: z.string().optional(),
  genres: z.array(z.string()).optional(),
});
export type CreateArtistRequest = z.infer<typeof createArtistRequestSchema>;

/**
 * Creator-editable artist profile fields.
 *
 * `verified` is deliberately NOT here. It is a platform-granted badge, so a shared
 * "update artist" contract that accepted it would read like permission and hand
 * self-verification to any endpoint written against this schema. Verification is set
 * server-side only — `registerAsArtist` hardcodes it to false. If a genuine admin
 * verification endpoint is ever added, give it its OWN schema rather than widening
 * this one.
 */
export const updateArtistRequestSchema = z.object({
  name: z.string().optional(),
  bio: z.string().optional(),
  image: z.string().optional(),
  genres: z.array(z.string()).optional(),
});
export type UpdateArtistRequest = z.infer<typeof updateArtistRequestSchema>;

export const followArtistRequestSchema = z.object({
  artistId: z.string(),
});
export type FollowArtistRequest = z.infer<typeof followArtistRequestSchema>;

export const unfollowArtistRequestSchema = z.object({
  artistId: z.string(),
});
export type UnfollowArtistRequest = z.infer<typeof unfollowArtistRequestSchema>;

export const artistInsightsSchema = z.object({
  totalPlays: z.number(),
  monthlyListeners: z.number(),
  followers: z.number(),
  topTracks: z.array(
    z.object({
      trackId: z.string(),
      title: z.string(),
      playCount: z.number(),
    })
  ),
  period: z.enum(['7days', '30days', 'alltime']).optional(),
});
export type ArtistInsights = z.infer<typeof artistInsightsSchema>;

export const artistDashboardSchema = z.object({
  artist: artistSchema,
  totalTracks: z.number(),
  totalAlbums: z.number(),
  totalPlays: z.number(),
  followers: z.number(),
  strikeCount: z.number(),
  uploadsDisabled: z.boolean(),
  recentTracks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      createdAt: z.string(),
      playCount: z.number(),
    })
  ),
  recentAlbums: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      createdAt: z.string(),
      totalTracks: z.number(),
    })
  ),
  copyrightRemovedTracks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      removedAt: z.string(),
      removedReason: z.string().optional(),
    })
  ),
});
export type ArtistDashboard = z.infer<typeof artistDashboardSchema>;
