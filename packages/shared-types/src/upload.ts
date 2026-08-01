import { z } from 'zod';
import { timestampsSchema } from './common';
import { lyricsLineSchema } from './lyrics';
import {
  audioFormatSchema,
  catalogImageSizesSchema,
  hlsRenditionSchema,
  playableKindSchema,
  playableTrackSchema,
  releaseEditionFields,
  trackSchema,
  trackStatusSchema,
} from './track';

/**
 * Listener uploads — the private locker and the public contribution path.
 *
 * A locker file is a `UserUpload`, NOT a `Track`. The two live in separate
 * collections because `playableTrackFilter()` has no owner dimension and never
 * will: teaching every catalog read, container pipeline and playback gate to
 * exclude somebody else's private file is a rule that only has to be forgotten
 * once. With a separate collection the leak is impossible by construction.
 *
 * The cost — the player and the queue now handle two sources — is paid once, by
 * serialising a `UserUpload` to {@link userUploadAsTrackSchema}: a Track-shaped
 * DTO tagged `kind: 'upload'`, so rows, the player and the queue UI render it
 * unchanged and only stream resolution and the queue reference branch on kind.
 */

/** Where the uploader wants the file to end up. */
export const uploadDestinationSchema = z.enum(['private', 'public']);
export type UploadDestination = z.infer<typeof uploadDestinationSchema>;

/**
 * How much a single provenance signal weighs.
 *
 * `blocking` is not "a lot of points" — it short-circuits the public path on its
 * own, regardless of score, because the marker names the buyer or the store
 * (iTunes purchase atoms carry the purchaser's Apple ID) and no accumulation of
 * clean signals makes that file the uploader's to distribute.
 */
export const provenanceMarkerWeightSchema = z.enum(['low', 'medium', 'high', 'blocking']);
export type ProvenanceMarkerWeight = z.infer<typeof provenanceMarkerWeightSchema>;

/**
 * One forensic signal found in (or absent from) an uploaded file.
 *
 * `code` is a stable machine identifier (e.g. `itunes.purchase-atoms`), never a
 * sentence — it is what a screening test asserts on and what an appeal quotes,
 * so it must survive copy rewording. `detail` carries the human-readable
 * specifics (which atom, which ISRC) for the evidence chain.
 */
export const provenanceMarkerSchema = z.object({
  code: z.string(),
  weight: provenanceMarkerWeightSchema,
  detail: z.string().optional(),
});
export type ProvenanceMarker = z.infer<typeof provenanceMarkerSchema>;

/**
 * What the screening concluded.
 *
 * `commercial` means the file is a known commercial release; `suspect` means the
 * signals lean that way without proving it; `clean` means nothing was found.
 * The verdict never stands alone in storage or in an API response — the markers
 * that produced it travel with it, so a block can always be explained.
 */
export const provenanceVerdictSchema = z.enum(['clean', 'suspect', 'commercial']);
export type ProvenanceVerdict = z.infer<typeof provenanceVerdictSchema>;

export const provenanceReportSchema = z.object({
  markers: z.array(provenanceMarkerSchema),
  score: z.number(),
  verdict: provenanceVerdictSchema,
});
export type ProvenanceReport = z.infer<typeof provenanceReportSchema>;

/**
 * Where the locker's copy of the audio lives.
 *
 * A bare S3 key, not a URL: locker audio is served only through
 * `GET /api/uploads/:id/stream` after an ownership check, so there is no
 * playable address to hand out. Server-side shape — it is absent from
 * {@link userUploadAsTrackSchema}, the DTO that actually goes over the wire.
 */
export const uploadAudioSourceSchema = z.object({
  key: z.string(),
  format: audioFormatSchema,
});
export type UploadAudioSource = z.infer<typeof uploadAudioSourceSchema>;

/** Hard ceiling on a stored {@link rawTagsSchema} payload. */
export const RAW_TAGS_MAX_BYTES = 32 * 1024;

/**
 * The file's native tag block, verbatim.
 *
 * Kept for three jobs nothing else can do: auditing a DMCA claim against what
 * the file actually declared, re-parsing later without asking the user for the
 * file again, and debugging the extractor itself.
 *
 * NEVER SERVED TO A CLIENT. That is enforced mechanically rather than by
 * convention — the Mongoose paths are `select: false`, so a query does not fetch
 * it unless it explicitly asks, and it is absent from
 * {@link userUploadAsTrackSchema}, the DTO that actually goes over the wire. A
 * future serializer therefore cannot leak it by spreading a document, because
 * the document it spreads does not contain it.
 *
 * Stored as a JSON STRING, not a nested object: tag keys are arbitrary
 * user-supplied text (`TXXX` descriptions, Vorbis comments, iTunes `----`
 * atoms), and a key with a `$` or a `.` in it is a document Mongo will fight
 * over. A string is inert. `truncated` and `originalByteLength` are what make a
 * capped dump honest — without them a truncated payload reads as a complete one.
 */
export const rawTagsSchema = z.object({
  /** Which tag container it came from — `ID3v2.4`, `vorbis`, `iTunes`, … */
  format: z.string().optional(),
  json: z.string(),
  truncated: z.boolean(),
  originalByteLength: z.number(),
});
export type RawTags = z.infer<typeof rawTagsSchema>;

/**
 * Lyrics as they came out of the file's own tags (`USLT` plain, `SYLT` synced).
 *
 * Deliberately shaped like the existing `Lyrics` collection — `synced`, `lines`,
 * `plain` — so promoting a locker file to the catalog copies these straight in
 * with no translation step to get wrong.
 *
 * Embedded HERE and nowhere else: a catalog `Track` must NOT grow a lyrics
 * field, because `Lyrics` (keyed unique by `trackId`) is already the single
 * authority for one, and a second embedded copy is exactly the two-fields-one-
 * truth problem that `metadata.isrc` was just deleted for. A locker file has no
 * `Track` row to key that collection by, which is why it carries its own.
 */
export const uploadLyricsSchema = z.object({
  synced: z.boolean(),
  lines: z.array(lyricsLineSchema).optional(),
  plain: z.string().optional(),
  language: z.string().optional(),
});
export type UploadLyrics = z.infer<typeof uploadLyricsSchema>;

/**
 * A file in a listener's private locker — the full stored record.
 *
 * This is the shape the `UserUpload` model persists, not the shape clients read:
 * it carries the storage key and the retention bookkeeping. Clients get
 * {@link userUploadAsTrackSchema}.
 *
 * The Chromaprint `fingerprint` array is deliberately absent from every shape in
 * this file. It is thousands of integers, it is only ever consumed by the
 * matcher inside the backend, and shipping it would let a client enumerate the
 * catalog's acoustic index.
 */
export const userUploadSchema = timestampsSchema.extend({
  ...releaseEditionFields,

  id: z.string(),
  _id: z.string().optional(),
  ownerOxyUserId: z.string(),

  title: z.string(),
  /**
   * Absent when the file carried no artist tag and none could be resolved.
   *
   * Valid, not an error: a private locker exists precisely for the odd files
   * nobody has catalogued, and rejecting an untagged file would reject exactly
   * the material people upload a locker to preserve. The PUBLIC path is the one
   * that requires an artist — without attribution there is no claimable profile
   * and nobody to send a takedown to.
   */
  artistName: z.string().optional(),
  /**
   * `albumartist` (`TPE2` / `ALBUMARTIST` / `aART`) — the container's artist,
   * which differs from the track's on compilations and guest features. It is one
   * of the three inputs to {@link albumKey}, so it is stored rather than derived.
   */
  albumArtistName: z.string().optional(),
  albumName: z.string().optional(),
  /**
   * `buildAlbumKey(albumArtistName, albumName, year)`.
   *
   * The locker has NO Album collection — album pages are an aggregation over
   * this field. That is the whole point: a private file must not create a
   * catalog container, and grouping by a stored key gives the full album
   * structure with zero catalog contamination.
   */
  albumKey: z.string().optional(),
  trackNumber: z.number().optional(),
  discNumber: z.number().optional(),
  year: z.number().optional(),
  genres: z.array(z.string()).optional(),
  lyrics: uploadLyricsSchema.optional(),

  duration: z.number(),
  codec: z.string().optional(),
  bitrateKbps: z.number().optional(),
  sizeBytes: z.number(),

  sha256: z.string(),
  /** Duration the fingerprint was computed over — the candidate bucket for matching. */
  fingerprintDurationSec: z.number().optional(),

  coverArt: z.string().optional(),
  coverArtSizes: catalogImageSizesSchema.optional(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),

  audioSource: uploadAudioSourceSchema.optional(),
  hls: z.array(hlsRenditionSchema).optional(),
  hlsMasterKey: z.string().optional(),
  loudnessLufs: z.number().optional(),

  status: trackStatusSchema,

  /** The catalog track this file turned out to be, when the uploader kept their own copy anyway. */
  matchedTrackId: z.string().optional(),
  /** Set only on a HIGH-confidence artist resolution; a medium-confidence name stays unlinked text. */
  resolvedArtistId: z.string().optional(),

  lastPlayedAt: z.string().optional(),
  playCount: z.number(),
  /** `max(lastPlayedAt, createdAt) + 365d`, pushed forward on every play. */
  expiresAt: z.string().optional(),
  deletionNoticeSentAt: z.string().optional(),
  deletedAt: z.string().optional(),

  provenance: provenanceReportSchema.optional(),
  /** Server-only; see {@link rawTagsSchema}. Never present in a client response. */
  rawTags: rawTagsSchema.optional(),
});
export type UserUpload = z.infer<typeof userUploadSchema>;

/**
 * A locker file serialised into the catalog's Track shape.
 *
 * Structurally a `Track`, so every component that already renders a track —
 * rows, the player, the queue — takes one with no change. `id` is the
 * `UserUpload` id, and it is only ever addressable together with `kind`.
 *
 * Two fields are Track-required and can be empty here, which is the price of
 * the shared shape: `artistId` is `''` until an artist is resolved with high
 * confidence, and `artistName` is `''` when the file carried no artist tag. The
 * UI renders its own "Unknown artist" for an empty name rather than the backend
 * shipping a language-specific string.
 */
export const userUploadAsTrackSchema = trackSchema.extend({
  kind: z.literal('upload'),
  /**
   * The album grouping key — see {@link userUploadSchema}.
   *
   * On the wire because the locker has no Album collection: the client groups
   * its own rows by this value, so without it there is no album view at all.
   * Not sensitive — it is derived from the file's own tags.
   */
  albumKey: z.string().optional(),
  /**
   * The album's artist, for the grouping HEADER.
   *
   * `artistName` is the TRACK's artist and differs per row on a compilation, so
   * a group labelled from it would show whichever track happened to sort first.
   * Grouping by `albumKey` without this is a group nothing can title correctly.
   */
  albumArtistName: z.string().optional(),
  /**
   * When this file is due for deletion — user-facing, not bookkeeping.
   *
   * Retention promises the owner a warning before anything is removed, and the
   * T−14d notification alone cannot satisfy that: a listener who opens the app
   * without reading a notification has no way to see that a file is expiring.
   * The rest of the retention fields (`deletedAt`, `deletionNoticeSentAt`) stay
   * server-side — they are the sweeper's state, not the user's.
   */
  expiresAt: z.string().optional(),
});
export type UserUploadAsTrack = z.infer<typeof userUploadAsTrackSchema>;

/**
 * Anything the player can play, tagged with where it came from.
 *
 * A plain union rather than `z.discriminatedUnion`, because the catalog arm's
 * tag is defaulted (see {@link playableTrackSchema}) — an untagged catalog
 * response has no discriminator to switch on until it has been parsed. The
 * upload arm is listed first so a `kind: 'upload'` payload never gets a chance
 * to be read as a catalog track.
 */
export const playableItemSchema = z.union([userUploadAsTrackSchema, playableTrackSchema]);
export type PlayableItem = z.infer<typeof playableItemSchema>;

/**
 * The address of one playable item: which collection, then which document.
 *
 * The queue stores these instead of bare track ids. An id alone is ambiguous
 * across two collections, and resolving it by trying the catalog and falling
 * back to the locker would be an owner check that runs only on the second try.
 */
export const playableRefSchema = z.object({
  kind: playableKindSchema,
  id: z.string(),
});
export type PlayableRef = z.infer<typeof playableRefSchema>;

/**
 * The multipart body that accompanies an uploaded audio file.
 *
 * `duration` is deliberately absent. It is read from the file with `ffprobe`;
 * it used to be a text box a human typed into, validated only as `> 0`, which
 * is a field that can disagree with the audio it describes.
 *
 * Every metadata field is an OVERRIDE of what was extracted from the file's
 * tags — omitted means "keep what the file said", not "clear it".
 */
export const uploadTrackRequestSchema = z.object({
  destination: uploadDestinationSchema,
  title: z.string().optional(),
  artistName: z.string().optional(),
  albumName: z.string().optional(),
  trackNumber: z.number().int().positive().optional(),
  discNumber: z.number().int().positive().optional(),
  year: z.number().int().optional(),
  genres: z.array(z.string()).optional(),
  /** Cover art as an uploaded image id (MongoDB ObjectId), never a URL or blob. */
  coverArt: z.string().optional(),
  isExplicit: z.boolean().optional(),
  /**
   * The uploader's signed statement that they may distribute this recording.
   * Required by the backend when `destination` is `public`; ignored otherwise.
   */
  /**
   * Image asset id for the ARTIST's photo, distinct from `coverArt`, which is
   * the release. Required on the public path only when the target artist has no
   * photo yet — either because this contribution creates the profile, or because
   * an earlier one left it bare. An artist who already has a photo keeps it:
   * their branding is not a contributor's to overwrite.
   */
  artistImage: z.string().optional(),
  attestation: z.string().optional(),
});
export type UploadTrackRequest = z.infer<typeof uploadTrackRequestSchema>;

/** Fields a listener may edit on a file already in their locker. */
export const updateUserUploadRequestSchema = z.object({
  title: z.string().optional(),
  artistName: z.string().optional(),
  albumName: z.string().optional(),
  trackNumber: z.number().int().positive().optional(),
  discNumber: z.number().int().positive().optional(),
  year: z.number().int().optional(),
  genres: z.array(z.string()).optional(),
  coverArt: z.string().optional(),
});
export type UpdateUserUploadRequest = z.infer<typeof updateUserUploadRequestSchema>;

/**
 * Why the public path refused a file — machine-readable, so the client can
 * explain what is missing instead of echoing a sentence it cannot reason about.
 *
 * An ENUM rather than a free string, deliberately. These codes are what a client
 * switches on; a `string` lets a new code ship without any consumer noticing it
 * fell through, which is the failure mode the code exists to prevent. Adding a
 * value here is one line, and it makes every switch a compile error until it is
 * handled — that is the point.
 *
 *  - `artist_unresolved`           no artist could be resolved from the file.
 *                                  The public path REJECTS rather than silently
 *                                  falling back to the locker: without
 *                                  attribution there is no claimable profile and
 *                                  nobody to send a takedown to, and a silent
 *                                  downgrade would leave the uploader believing
 *                                  they had published.
 *  - `artist_not_found`            an artist id was supplied but no such artist
 *                                  exists.
 *  - `artist_name_denylisted`      the name is a tagger's placeholder ("Unknown
 *                                  Artist", "Various Artists"), which must never
 *                                  become a catalog entity.
 *  - `artist_contributions_closed` case B — the artist is claimed by somebody
 *                                  else and has not enabled
 *                                  `acceptsContributions`.
 *  - `artist_uploads_disabled`     the target artist is under copyright strikes
 *                                  or terminated.
 *  - `attestation_required`        `destination: 'public'` with no signed
 *                                  statement.
 *  - `commercial_provenance`       screening found a blocking marker — iTunes
 *                                  purchase atoms, store provenance, a label
 *                                  release.
 */
export const uploadBlockedReasonSchema = z.enum([
  'artist_unresolved',
  'artist_not_found',
  'artist_name_denylisted',
  /**
   * The catalogue refuses a release with no usable cover art. Distinct from the
   * artist codes because the fix is different and the user can act on it: attach
   * an image, or keep the file private. "Usable" means it clears the catalogue
   * minimum — an embedded thumbnail is stored and shown in the owner's own
   * library, but promoting a 200px image to a catalogue page is the thing the
   * minimum exists to prevent.
   */
  'cover_art_required',
  /**
   * The file carries no ISRC. Required on the public path because it is the only
   * thing that identifies the RECORDING exactly: from it the artist resolves via
   * MusicBrainz to a specific person with an ISNI, instead of being matched on a
   * name. Name matching fails in both directions — `C. Giró` and `Carlota Giró`
   * become two profiles, while two genuinely different artists sharing a name are
   * forced into one by the unique name key.
   */
  'isrc_required',
  'artist_contributions_closed',
  'artist_uploads_disabled',
  /**
   * The UPLOADER is barred, not the destination — their Oxy account crossed the
   * repeat-infringer threshold. Distinct from `artist_uploads_disabled` because
   * the two say opposite things to the person reading them: one means "this
   * profile is closed", the other means "you are", and only the second is worth
   * offering an appeal for.
   */
  'contributor_blocked',
  'attestation_required',
  'commercial_provenance',
]);
export type UploadBlockedReason = z.infer<typeof uploadBlockedReasonSchema>;

/**
 * What happened to an uploaded file — the one contract every upload path ends in.
 *
 * A discriminated union rather than a bag of optional fields, so a caller cannot
 * read `trackId` off a `blocked` result: each outcome carries exactly what that
 * outcome means and nothing else.
 *
 *  - `matched`   the bytes are already in the public catalog, so they were NOT
 *                stored again; the client adds the existing track to the library.
 *  - `duplicate` the uploader already has this file in their own locker.
 *  - `stored`    kept privately, as uploaded.
 *  - `published` contributed to the public catalog.
 *  - `blocked`   refused for the public catalog. `code` is what the client
 *                switches on, `message` is what it shows, and `markers` is the
 *                evidence — so the decision can always be explained and the
 *                locker offered as the alternative. Two fields because one
 *                string cannot be both stable enough to branch on and free
 *                enough to reword or translate.
 */
export const uploadOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('matched'), trackId: z.string() }),
  z.object({ outcome: z.literal('duplicate'), uploadId: z.string() }),
  z.object({ outcome: z.literal('stored'), upload: userUploadAsTrackSchema }),
  z.object({ outcome: z.literal('published'), trackId: z.string() }),
  z.object({
    outcome: z.literal('blocked'),
    /** Stable machine identifier — what the client switches on. */
    code: uploadBlockedReasonSchema,
    /** Human-readable, safe to show the uploader; free to be reworded or translated. */
    message: z.string(),
    markers: z.array(provenanceMarkerSchema),
  }),
]);
export type UploadOutcome = z.infer<typeof uploadOutcomeSchema>;

/**
 * A signed statement that the uploader may distribute a contributed recording.
 *
 * Stored with the request metadata that produced it: an attestation with no
 * record of who made it, from where and against which screening result is not
 * evidence of anything, and evidence is the entire reason it exists.
 */
export const contributionAttestationSchema = timestampsSchema.extend({
  id: z.string(),
  _id: z.string().optional(),
  trackId: z.string(),
  uploaderOxyUserId: z.string(),
  statement: z.string(),
  acceptedAt: z.string(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
  provenanceReport: provenanceReportSchema.optional(),
  /**
   * The file's tags as they were at signing time — server-only, see
   * {@link rawTagsSchema}. Kept on the attestation as well as the upload because
   * the upload can be deleted and the evidence for a published recording has to
   * outlive it.
   */
  rawTags: rawTagsSchema.optional(),
});
export type ContributionAttestation = z.infer<typeof contributionAttestationSchema>;
