import { z } from 'zod';
import { timestampsSchema } from './common';
import {
  attributableImageSchema,
  catalogSourceSchema,
  catalogImageSizesSchema,
  externalIdsSchema,
  imageLicenceSchema,
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

/**
 * Outbound links for an artist.
 *
 * The last five come from MusicBrainz URL relationships, which is the only
 * source that supplies them for an artist nobody at Syra has ever met.
 */
export const artistLinksSchema = z.object({
  website: z.string().optional(),
  instagram: z.string().optional(),
  x: z.string().optional(),
  youtube: z.string().optional(),
  discogs: z.string().optional(),
  wikidata: z.string().optional(),
  wikipedia: z.string().optional(),
  bandcamp: z.string().optional(),
  soundcloud: z.string().optional(),
});

/**
 * What KIND of artist this is, as MusicBrainz classifies it.
 *
 * Load-bearing for enrichment rather than decorative: a `person` can have a
 * birth date and a photograph of a face, a `group` has members and a founding
 * date, and a `character` has neither. Filling the wrong ones is how a profile
 * ends up asserting that a band was born in 1973.
 */
export const artistTypeSchema = z.enum([
  'person',
  'group',
  'orchestra',
  'choir',
  'character',
  'other',
]);
export type ArtistType = z.infer<typeof artistTypeSchema>;

/**
 * A member of a group.
 *
 * Same shape as a track credit minus `role` — the relationship IS the role —
 * plus the interval, because membership changes and a former member is still a
 * true fact about the band. `catalogEntityId` is set only at high confidence,
 * for the same reason it is on a credit: a member linked to the wrong artist's
 * page is worse than a member linked to nothing.
 */
export const artistMemberSchema = z.object({
  name: z.string(),
  nameKey: z.string(),
  catalogEntityId: z.string().optional(),
  /** ISO-8601, possibly partial. */
  from: z.string().optional(),
  until: z.string().optional(),
});
export type ArtistMember = z.infer<typeof artistMemberSchema>;

/**
 * How this artist profile came to exist.
 *
 * `registered` — a person signed up in the studio and owns the profile.
 * `contributed` — the profile was created from the tags of a file somebody else
 *   uploaded, so that the recording has an attributable home. A contributed
 *   profile is always written `claimable: true`: nobody has proven they are this
 *   artist, and the real one may still arrive.
 *
 * The distinction is load-bearing rather than descriptive: a contributed profile
 * is impersonation surface, which is why claiming one is reviewed and never
 * auto-granted.
 */
export const artistOriginSchema = z.enum(['registered', 'contributed']);
export type ArtistOrigin = z.infer<typeof artistOriginSchema>;

/**
 * External identifiers for an artist.
 *
 * Extends the shared catalog ids with `musicbrainzArtistId` — the only strong,
 * globally stable artist identifier an uploaded file can carry (Picard writes it
 * as `MUSICBRAINZ_ARTISTID`). It stays off the shared `externalIds` shape
 * because a track and an album have no use for it.
 */
export const artistExternalIdsSchema = externalIdsSchema.extend({
  musicbrainzArtistId: z.string().optional(),
  /** International Standard Name Identifier. */
  isni: z.string().optional(),
  /** Interested Parties Information code (rights societies). */
  ipi: z.string().optional(),
  wikidataId: z.string().optional(),
  discogsArtistId: z.string().optional(),
});
export type ArtistExternalIds = z.infer<typeof artistExternalIdsSchema>;

export const artistSchema = timestampsSchema.extend({
  id: z.string(),
  _id: z.string().optional(),
  name: z.string(),
  /**
   * `name` normalised for matching: NFKD, diacritics stripped, lowercased,
   * punctuation and runs of whitespace collapsed.
   *
   * This is the key an uploaded file's plain-text artist tag resolves against,
   * and it is unique among artists — without it two concurrent uploads of the
   * same artist each create a profile and the catalog gains a permanent
   * duplicate that no later write can merge away.
   */
  nameKey: z.string().optional(),
  bio: z.string().optional(),
  image: z.string().optional(),
  imageSizes: catalogImageSizesSchema.optional(),
  /**
   * Licence and authorship of the CURRENT `image`, when it came from outside.
   *
   * Stored beside the image and rendered on the profile, because that is what
   * CC BY-SA actually requires — attribution held in a table nobody displays
   * discharges nothing. Absent means the image is the artist's own upload, which
   * needs no third-party credit.
   */
  imageLicence: imageLicenceSchema.optional(),
  genres: z.array(z.string()).optional(),
  verified: z.boolean().optional(),
  /** Name for alphabetical ordering — `Beatles, The`, `Hendrix, Jimi`. */
  sortName: z.string().optional(),
  /**
   * MusicBrainz's short parenthetical that tells two identically-named artists
   * apart ("UK punk band", "Swedish producer"). The one piece of text that makes
   * a name-collision survivable in a list.
   */
  disambiguation: z.string().optional(),
  artistType: artistTypeSchema.optional(),
  /**
   * ISO-8601 and possibly PARTIAL — MusicBrainz and Wikidata both state bare
   * years routinely. Strings for the same reason `originalReleaseDate` is one:
   * coercing `1973` to a Date invents a day and a month the source never
   * claimed, and the profile then displays them as fact.
   */
  activeFrom: z.string().optional(),
  activeUntil: z.string().optional(),
  /**
   * Other names this artist is credited under.
   *
   * Display and search only — NEVER a dedup key. `nameKey` is unique among
   * artists; letting an alias resolve an identity would let one artist's
   * pseudonym silently absorb a different artist who happens to use it as their
   * primary name.
   */
  aliases: z.array(z.string()).optional(),
  /** Labels associated with the artist. Plural because artists move. */
  labels: z.array(z.string()).optional(),
  members: z.array(artistMemberSchema).optional(),
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
  externalIds: artistExternalIdsSchema.optional(),
  sources: z.array(sourceProvenanceSchema).optional(),
  images: z.array(trackImageSchema).optional(),
  links: artistLinksSchema.optional(),
  country: z.string().optional(),
  claimable: z.boolean().optional(),
  claimedByOxyUserId: z.string().optional(),
  /** Optional: profiles created before contributed artists existed carry no origin. */
  origin: artistOriginSchema.optional(),
  /**
   * Whether this artist accepts recordings uploaded by other people onto their
   * profile. Default `false`, and it is the ONLY thing that unblocks a
   * contribution to an artist somebody has already claimed — attaching a
   * stranger's file to a present artist's page is the impersonation risk itself,
   * so the artist has to opt into it.
   */
  acceptsContributions: z.boolean().optional(),
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

/**
 * A candidate profile photo, offered to the artist and shown to NOBODY else.
 *
 * An `0x07`/`0x08`/`0x0A` picture frame in somebody's MP3, or a Commons image
 * matched by MBID, is a guess about what an artist looks like. Publishing a
 * guess turns "a picture inside this stranger's file" into catalog content on
 * every surface in the product, attached to a real person's name — so a
 * suggestion is only ever surfaced in the claim flow, where the artist accepts
 * or discards it.
 *
 * DELIBERATELY ABSENT FROM {@link artistSchema}. That is the enforcement: the
 * public artist DTO has no field for this, so no profile serializer can emit it
 * even by spreading a document — and the Mongoose path is `select: false`, so
 * the document it would spread does not contain it either. A boolean like
 * `isPublic: false` on the main image would have been a rule to remember; this
 * is a shape that cannot express the mistake.
 *
 * The image is an {@link attributableImageSchema}, so a Commons-sourced
 * suggestion carries its licence from the moment it is proposed — the artist is
 * accepting a specific image under a specific licence, not a URL.
 */
export const artistImageSuggestionSchema = z.object({
  image: attributableImageSchema,
  proposedAt: z.string(),
  /** The uploader whose file carried the embedded picture, when that is the source. */
  proposedByOxyUserId: z.string().optional(),
  /** The `UserUpload` the embedded picture came out of, for the evidence trail. */
  sourceUploadId: z.string().optional(),
});
export type ArtistImageSuggestion = z.infer<typeof artistImageSuggestionSchema>;

/**
 * The claim-flow-only response carrying pending photo suggestions.
 *
 * Its own schema rather than a field on `artistSchema`, so the only endpoint
 * that can return suggestions is one written against this type — and that
 * endpoint is behind the claim's ownership check.
 */
export const artistImageSuggestionsResponseSchema = z.object({
  suggestions: z.array(artistImageSuggestionSchema),
});
export type ArtistImageSuggestionsResponse = z.infer<typeof artistImageSuggestionsResponseSchema>;

/**
 * Where a claim on a contributed artist profile stands.
 *
 * There is no "auto-approved" value and there never will be. A contributed
 * profile is created from a stranger's file tags, so granting it on request
 * would hand anyone the page of any artist not yet on Syra — every claim is
 * reviewed by a human.
 */
export const artistClaimStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type ArtistClaimStatus = z.infer<typeof artistClaimStatusSchema>;

export const artistClaimSchema = timestampsSchema.extend({
  id: z.string(),
  _id: z.string().optional(),
  artistId: z.string(),
  /** The Oxy user asking to be recognised as this artist. */
  oxyUserId: z.string(),
  /** What the claimant offered as proof, in their own words. */
  evidence: z.string(),
  status: artistClaimStatusSchema,
  resolvedAt: z.string().optional(),
  /** Oxy user id of the reviewer who approved or rejected it. */
  resolvedBy: z.string().optional(),
  resolutionNote: z.string().optional(),
});
export type ArtistClaim = z.infer<typeof artistClaimSchema>;

export const createArtistClaimRequestSchema = z.object({
  evidence: z.string().min(1),
});
export type CreateArtistClaimRequest = z.infer<typeof createArtistClaimRequestSchema>;

/**
 * A reviewer's decision. `pending` is absent on purpose — this contract exists to
 * END a review, and re-submitting `pending` would silently undo a resolution.
 */
export const resolveArtistClaimRequestSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  resolutionNote: z.string().optional(),
});
export type ResolveArtistClaimRequest = z.infer<typeof resolveArtistClaimRequestSchema>;

export const artistClaimResponseSchema = z.object({
  claim: artistClaimSchema,
});
export type ArtistClaimResponse = z.infer<typeof artistClaimResponseSchema>;

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
