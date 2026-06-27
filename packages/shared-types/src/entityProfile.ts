import { z } from 'zod';
import { artistLinksSchema, artistStatsSchema } from './artist';
import { trackSchema, catalogImageSizesSchema } from './track';
import { albumSchema } from './album';
import { podcastSchema } from './podcast';
import { episodeSchema } from './episode';

/**
 * A `/p/:id` target is a unified entity: either a music **artist** or a podcast
 * host/guest **person**. The two identities can be linked (`Person.linkedArtistId`),
 * so a single profile may carry BOTH music (artist) and podcast appearances (person).
 */
export const entityKindSchema = z.enum(['artist', 'person']);
export type EntityKind = z.infer<typeof entityKindSchema>;

/** Artist music — tracks + albums (empty arrays when the artist has no catalog). */
export const entityMusicSchema = z.object({
  tracks: z.array(trackSchema),
  albums: z.array(albumSchema),
});
export type EntityMusic = z.infer<typeof entityMusicSchema>;

/** Podcast appearances — shows the entity hosts/guests in, plus crediting episodes. */
export const entityAppearsInSchema = z.object({
  podcasts: z.array(podcastSchema),
  episodes: z.array(episodeSchema).optional(),
});
export type EntityAppearsIn = z.infer<typeof entityAppearsInSchema>;

/**
 * `GET /api/p/:id` response — the merged Artist+Person profile.
 *  - `kind:'artist'` → `music` present (their tracks/albums); `appearsIn` present
 *    when a `Person` links to this artist (the host/guest's podcast appearances).
 *  - `kind:'person'` → `appearsIn` present (podcasts/episodes crediting them);
 *    `music` present when `linkedArtistId` resolves a music artist.
 *  - `image` is the artist cover (file id / `/api/images/:id`); `avatar` is the
 *    Oxy avatar file id for an Oxy-linked person. `linkedArtistId`/`linkedOxyUserId`
 *    expose the cross-links for the frontend.
 *  - Artist display fields (`genres`/`secondaryColor`/`verified`/`stats`/`imageSizes`)
 *    are present on the artist branch (and the person→linkedArtist case) so `/p/[id]`
 *    matches what the old artist screen rendered (primary+secondary gradient, hero
 *    size variants, follower/listener stats).
 */
export const entityProfileSchema = z.object({
  id: z.string(),
  kind: entityKindSchema,
  name: z.string(),
  displayName: z.string().optional(),
  username: z.string().optional(),
  image: z.string().optional(),
  imageSizes: catalogImageSizesSchema.optional(),
  avatar: z.string().optional(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  bio: z.string().optional(),
  genres: z.array(z.string()).optional(),
  verified: z.boolean().optional(),
  stats: artistStatsSchema.optional(),
  links: artistLinksSchema.optional(),
  linkedArtistId: z.string().optional(),
  linkedOxyUserId: z.string().optional(),
  music: entityMusicSchema.optional(),
  appearsIn: entityAppearsInSchema.optional(),
});
export type EntityProfile = z.infer<typeof entityProfileSchema>;
