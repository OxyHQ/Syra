import { z } from 'zod';
import {
  artistLinksSchema,
  artistMemberSchema,
  artistOriginSchema,
  artistStatsSchema,
  artistTypeSchema,
} from './artist';
import {
  trackSchema,
  catalogImageSizesSchema,
  imageLicenceSchema,
  sourceProvenanceSchema,
} from './track';
import { albumSchema } from './album';
import { playlistSchema } from './playlist';
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

/**
 * An artist's own releases, split by the release-type enum already on `Album`.
 *
 * A split rather than a flag on each album, because the profile renders three
 * separate shelves and a client that had to partition the list itself would be
 * the second place the mapping from `single | ep` to "Singles & EPs" lives.
 */
export const entityDiscographySchema = z.object({
  albums: z.array(albumSchema),
  singlesAndEps: z.array(albumSchema),
  compilations: z.array(albumSchema),
});
export type EntityDiscography = z.infer<typeof entityDiscographySchema>;

/**
 * A track this artist took part in WITHOUT being its primary artist.
 *
 * Impossible to express before `Track.credits[]` existed: a track had one
 * `artistId` and nothing else, so a guest verse, a production credit or a remix
 * had nowhere to live. `roles` is what distinguishes "featured" from "produced",
 * and it is a list because one person is frequently several of them on one track.
 */
export const entityCreditedTrackSchema = z.object({
  track: trackSchema,
  /** `artist` (guest), `producer`, `composer`, `remixer`, … — as tagged. */
  roles: z.array(z.string()),
});
export type EntityCreditedTrack = z.infer<typeof entityCreditedTrackSchema>;

/**
 * What the client needs to explain this page to the artist it belongs to.
 *
 * A contributed profile is built from the tags of a file somebody else uploaded,
 * so three things are not obvious from the content alone: whether the real artist
 * may still claim it, which values on it nobody here wrote, and which recordings
 * a third party published. Without the last one a claimed artist sees a
 * discography containing tracks they never uploaded and no way to tell which.
 */
export const entityProfileStateSchema = z.object({
  origin: artistOriginSchema.optional(),
  /** Contributed and unclaimed — the client shows a claim call to action. */
  claimable: z.boolean(),
  claimed: z.boolean(),
  /** Whether this artist lets other people publish onto their profile. */
  acceptsContributions: z.boolean(),
  sources: z.array(sourceProvenanceSchema).optional(),
  /** Union of every field named in `sources[].fields` — "you did not write this". */
  externallySourcedFields: z.array(z.string()),
  /** Ids within `music.tracks` that a third party published, not the artist. */
  contributedTrackIds: z.array(z.string()),
});
export type EntityProfileState = z.infer<typeof entityProfileStateSchema>;

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
  country: z.string().optional(),
  /**
   * The licence and authorship of the profile photo, when it came from outside.
   *
   * On the RESPONSE, not merely in storage, because that is the whole point of
   * capturing it: CC BY-SA is discharged by NAMING the author and linking the
   * licence where the image is shown. Attribution held in a table nobody renders
   * discharges nothing, so a Commons photo shipped without this field is a
   * licence breach that no frontend change can repair.
   */
  imageLicence: imageLicenceSchema.optional(),
  /** Name for alphabetical ordering — `Beatles, The`. */
  sortName: z.string().optional(),
  /** MusicBrainz's parenthetical that tells two identically-named artists apart. */
  disambiguation: z.string().optional(),
  artistType: artistTypeSchema.optional(),
  /**
   * Possibly PARTIAL ISO-8601 — sources state bare years routinely, and widening
   * `1973` into a day would display an invented fact.
   */
  activeFrom: z.string().optional(),
  activeUntil: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  members: z.array(artistMemberSchema).optional(),
  music: entityMusicSchema.optional(),
  appearsIn: entityAppearsInSchema.optional(),
  /**
   * The artist sections. All optional, so a `kind:'person'` profile with no
   * linked artist simply omits them and nothing existing changes shape.
   *
   * `relatedArtists` is deliberately absent: `GET /api/artists/:id/related`
   * already serves them from the same co-listen graph and the profile screen
   * already reads that query. Duplicating them here would be two sources for one
   * shelf.
   */
  discography: entityDiscographySchema.optional(),
  creditedOn: z.array(entityCreditedTrackSchema).optional(),
  /** Playlists that include this artist AND that the requesting viewer may read. */
  playlists: z.array(playlistSchema).optional(),
  profileState: entityProfileStateSchema.optional(),
});
export type EntityProfile = z.infer<typeof entityProfileSchema>;
