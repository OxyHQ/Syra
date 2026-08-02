import { z } from 'zod';
import { timestampsSchema } from './common';

export const catalogSourceSchema = z.enum(['upload', 'cc']);
export type CatalogSource = z.infer<typeof catalogSourceSchema>;

export const trackStatusSchema = z.enum(['processing', 'ready', 'failed']);
export type TrackStatus = z.infer<typeof trackStatusSchema>;

export const externalIdsSchema = z.object({
  isrc: z.string().optional(),
});
export type ExternalIds = z.infer<typeof externalIdsSchema>;

/**
 * An ISRC, once the punctuation people type into it has been removed.
 *
 * The code is twelve characters — `CCXXXYYNNNNN` — but it is PRINTED with
 * hyphens (`ES-A09-26-07944`) on the label copy, the distributor dashboard and
 * the registration certificate somebody is reading it off. Every one of those is
 * a place an uploader copies from, so the separators are stripped rather than
 * rejected: refusing the spelling the code is published in would fail exactly
 * the people who have the right code in front of them.
 *
 * Case is folded up because the standard defines the alphabet as uppercase, and
 * `Track.externalIds.isrc` is written uppercase by the publication path. A
 * lowercase copy of the same code would compare unequal to it and dedup as a
 * different recording.
 *
 * NOTE: no Unicode property escapes anywhere here — this module is bundled into
 * the apps and mobile Hermes rejects them at runtime. ASCII classes only.
 */
export function normalizeIsrc(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * The structure of a normalised ISRC, in the four parts the standard defines:
 * a two-letter country code, a three-character alphanumeric registrant, the two
 * final digits of the year of reference, and a five-digit designation.
 *
 * Written as four groups rather than the equivalent `\d{7}` tail so the shape it
 * is enforcing stays readable — a wrong-length designation and a wrong-length
 * year are different mistakes, and the pattern should say which parts exist.
 */
export const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{2}[0-9]{5}$/;

/**
 * A user-supplied ISRC: normalised first, then validated.
 *
 * Validating the NORMALISED form is what makes the hyphenated spelling legal
 * without the pattern having to admit hyphens in arbitrary positions, which
 * would also admit `E-S-A-0-9-2...`.
 *
 * A well-formed code is NOT a true one — twelve characters in the right shape
 * are trivially invented. This schema is the syntax gate only; whether the code
 * actually belongs to the uploaded recording is decided by the backend against
 * the audio itself (`services/uploads/isrcLookup.ts`), and a claim that cannot
 * be checked is refused rather than trusted.
 */
export const isrcSchema = z
  .string()
  .transform(normalizeIsrc)
  .refine((value) => ISRC_PATTERN.test(value), {
    message:
      'An ISRC is 12 characters: two country letters, three registrant characters, ' +
      'a two-digit year and a five-digit designation (for example ESA092607944).',
  });

/**
 * Who a single imported FIELD came from — the provenance log's vocabulary.
 *
 * Deliberately NOT `catalogSourceSchema`, which is a different question with a
 * different answer set. That one types `Track.source` — how the recording
 * entered Syra — and is a required enum on every track; widening it would make
 * `source: 'wikidata'` representable, which is meaningless. This one is the
 * audit trail: it records that a bio came from Wikidata or a photo from
 * Commons, so that a claiming artist can see exactly which fields were filled
 * in from outside and overwrite them. Without that distinction the plan's
 * "cada campo importado se registra en `sources[]` con proveedor y fecha" cannot
 * be expressed at all.
 *
 * A superset of `catalogSourceSchema`'s values, so every stored row and every
 * existing call site stays valid.
 */
export const provenanceProviderSchema = z.enum([
  'upload',
  'cc',
  'musicbrainz',
  'wikidata',
  'wikimedia-commons',
  'cover-art-archive',
  'discogs',
]);
export type ProvenanceProvider = z.infer<typeof provenanceProviderSchema>;

export const sourceProvenanceSchema = z.object({
  provider: provenanceProviderSchema,
  externalId: z.string(),
  importedAt: z.string(),
  /** The field paths this provider supplied, so a claim can revert exactly those. */
  fields: z.array(z.string()),
});
export type SourceProvenance = z.infer<typeof sourceProvenanceSchema>;

/** Every provenance provider, for Mongoose `enum` declarations. */
export const PROVENANCE_PROVIDERS = provenanceProviderSchema.options;

/**
 * A provider-supplied image URL, as it arrives.
 *
 * This is an INBOUND shape as much as a stored one — `integrations.ts` parses
 * external provider responses with it, and those responses carry no licence.
 * It is therefore NOT the place to make attribution mandatory: doing so would
 * reject the provider payload rather than the reuse of it.
 *
 * The licence attaches where an image is REHOSTED and DISPLAYED, which is a
 * separate act from listing a URL a provider gave us. That is
 * {@link attributableImageSchema} and {@link imageLicenceSchema} below.
 */
export const trackImageSchema = z.object({
  url: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  source: catalogSourceSchema.optional(),
});
export type TrackImage = z.infer<typeof trackImageSchema>;

/** Where an externally-sourced image was taken from. */
export const imageProviderSchema = z.enum([
  'wikimedia-commons',
  'cover-art-archive',
  'musicbrainz',
  'discogs',
]);
export type ImageProvider = z.infer<typeof imageProviderSchema>;

/**
 * The licence and authorship of an image we did not create.
 *
 * Every field except `licenceUrl` is REQUIRED, and that is the whole design.
 * CC BY-SA is satisfied by naming the author and linking the work and its
 * licence; an image rehosted without them is a licence breach, not an untidy
 * record. The plan's rule is "if you cannot capture the licence, do not import
 * the image" — expressed here as a type that cannot be constructed without one,
 * rather than as a sentence someone in a hurry will skip.
 */
export const imageLicenceSchema = z.object({
  /** Short identifier — `CC0-1.0`, `CC-BY-SA-4.0`, `PD`. */
  licence: z.string().min(1),
  /** The licence deed. Optional only because `PD` has no canonical deed URL. */
  licenceUrl: z.string().optional(),
  /** The author to credit, exactly as the source states it. */
  attribution: z.string().min(1),
  /**
   * The FILE PAGE, never the raw image URL.
   *
   * A direct link to the bytes provides neither the author nor the licence, so
   * it does not discharge attribution — the file page is what carries both.
   * `commons.wikimedia.org/wiki/File:Foo.jpg` is the page;
   * `upload.wikimedia.org/.../Foo.jpg` is the raw file.
   *
   * The refinement below checks the HOST, deliberately, and not the file
   * extension. A page URL legitimately ends in `.jpg` — that is the Commons
   * naming convention — so an extension rule rejects the CORRECT value, which is
   * the worst possible direction to fail in: it would push whoever hit it to
   * "fix" the error by supplying the raw URL instead. (An earlier version of
   * this file made exactly that mistake; the test that accepts a valid licence
   * is what caught it.) So the rule stays narrow: it refuses the raw-bytes host
   * it can actually prove is wrong, and does not guess for providers where the
   * URL alone cannot tell you.
   */
  sourceUrl: z.string().min(1),
}).refine(
  (licence) => !/^https?:\/\/upload\.wikimedia\.org\//i.test(licence.sourceUrl),
  {
    path: ['sourceUrl'],
    message:
      'sourceUrl must be the Commons file page (commons.wikimedia.org/wiki/File:…) that states the author and licence, not the raw upload.wikimedia.org image URL.',
  },
);
export type ImageLicence = z.infer<typeof imageLicenceSchema>;

/**
 * An image together with what makes it legal to display.
 *
 * A discriminated union rather than an optional `licence` field, because the
 * two cases have genuinely different obligations and only one of them can be
 * satisfied by omission:
 *
 *  - `upload`   — the bytes came from the uploaded file itself (an embedded
 *                 APIC/`covr` frame) or from a creator's own upload. It arrives
 *                 with the same provenance as the audio the uploader attested
 *                 to, so there is no third party to credit.
 *  - `external` — fetched from a rights-bearing source. `licence` is REQUIRED:
 *                 there is no way to construct this arm without capturing the
 *                 attribution, which is what stops "we will add the licence
 *                 later" from ever becoming a stored image.
 */
export const attributableImageSchema = z.discriminatedUnion('origin', [
  z.object({
    origin: z.literal('upload'),
    url: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
  }),
  z.object({
    origin: z.literal('external'),
    url: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
    provider: imageProviderSchema,
    licence: imageLicenceSchema,
  }),
]);
export type AttributableImage = z.infer<typeof attributableImageSchema>;

export const catalogImageVariantSchema = z.object({
  id: z.string(),
  url: z.string(),
  width: z.number(),
  height: z.number(),
});
export type CatalogImageVariant = z.infer<typeof catalogImageVariantSchema>;

export const catalogImageSizesSchema = z.object({
  small: catalogImageVariantSchema.optional(),
  medium: catalogImageVariantSchema.optional(),
  large: catalogImageVariantSchema.optional(),
  xlarge: catalogImageVariantSchema.optional(),
  xxlarge: catalogImageVariantSchema.optional(),
  original: catalogImageVariantSchema.optional(),
});
export type CatalogImageSizes = z.infer<typeof catalogImageSizesSchema>;

export const hlsRenditionSchema = z.object({
  manifestKey: z.string(),
  bitrateKbps: z.number(),
  encrypted: z.boolean(),
});
export type HlsRendition = z.infer<typeof hlsRenditionSchema>;

export const audioFormatSchema = z.enum(['mp3', 'flac', 'ogg', 'm4a', 'wav']);
export type AudioFormat = z.infer<typeof audioFormatSchema>;

export const audioSourceSchema = z.object({
  url: z.string(),
  format: audioFormatSchema,
  bitrate: z.number().optional(),
  duration: z.number().optional(),
});
export type AudioSource = z.infer<typeof audioSourceSchema>;

/**
 * Descriptive metadata a creator may edit.
 *
 * There is NO `isrc` here: `externalIds.isrc` is the single ISRC field, and it
 * is the one carrying the sparse-unique index that makes an ISRC a dedup key.
 * A second, free-text, un-indexed copy editable through `PATCH /tracks/:id`
 * would let a creator's typo silently diverge from the identifier the catalog
 * actually matches on.
 */
export const trackMetadataSchema = z.object({
  genre: z.array(z.string()).optional(),
  bpm: z.number().optional(),
  key: z.string().optional(),
  explicit: z.boolean().optional(),
  language: z.string().optional(),
  copyright: z.string().optional(),
  publisher: z.string().optional(),
});
export type TrackMetadata = z.infer<typeof trackMetadataSchema>;

/**
 * One credited contributor on a recording.
 *
 * Modelled on `episodePersonSchema` — the repo already resolves name credits to
 * `CatalogEntity` rows through that shape, so a second shape for the same job
 * would mean a second resolver.
 *
 * `role` is a free string, not an enum, for the same reason it is one there:
 * the roles arrive inside `TIPL`/`IPLS` involved-people lists, whose role labels
 * are written by whoever tagged the file. An enum would force the extractor to
 * drop every unrecognised label, which throws away a real credit to protect a
 * type. The canonical values are `artist`, `albumartist`, `composer`,
 * `lyricist`, `conductor`, `remixer`, `arranger`, `engineer`, `producer`,
 * `mixer` and `dj-mix`; anything else is preserved verbatim.
 *
 * `catalogEntityId` is set ONLY on a high-confidence resolution. A
 * medium-confidence name stays displayable text and links nowhere — a credit
 * pointing at the wrong artist's page is worse than a credit pointing nowhere.
 */
export const trackCreditSchema = z.object({
  name: z.string(),
  role: z.string(),
  /** `normalizeNameKey(name)` — the same key artists dedup by. */
  nameKey: z.string(),
  catalogEntityId: z.string().optional(),
});
export type TrackCredit = z.infer<typeof trackCreditSchema>;

/**
 * ReplayGain as the file declares it.
 *
 * Captured, never computed: these are the tagger's measurements and they are
 * evidence of how the file was produced (album gain present on every track of a
 * set is a CD-rip signal). Syra's own normalisation is `loudnessLufs`, which
 * ingest measures — the two must not be conflated.
 */
export const replayGainSchema = z.object({
  trackDb: z.number().optional(),
  albumDb: z.number().optional(),
  trackPeak: z.number().optional(),
});
export type ReplayGain = z.infer<typeof replayGainSchema>;

/**
 * Facts about the physical or digital EDITION a recording was taken from.
 *
 * Captured from tags and left as text. None of it creates an entity: a label
 * name in a tag is not a label profile, and a catalogue number is not a
 * release. Publish what can be sustained, store the rest.
 */
export const releaseEditionFields = {
  /** The right-hand side of `TRCK` (`3/12`), NOT a count of the uploaded files. */
  totalTracks: z.number().optional(),
  /** The right-hand side of `TPOS` (`1/2`). */
  totalDiscs: z.number().optional(),
  /**
   * `TDOR` — when the work was FIRST released, as opposed to when this edition
   * was. A string, not a date, because the tag is routinely a bare year or
   * year-month and coercing it to a Date would invent a precision the file
   * never claimed. (`releaseDate` is a real date because the catalog owns it.)
   */
  originalReleaseDate: z.string().optional(),
  catalogNumber: z.string().optional(),
  /**
   * The record label that issued this recording.
   *
   * NOT a duplicate of `metadata.publisher`: a publisher administers the
   * COMPOSITION's rights and a label owns the RECORDING, and they are routinely
   * different companies. `TPUB` maps to `metadata.publisher`; this field comes
   * from `TLAB` / Vorbis `LABEL` / `ORGANIZATION`. Do not merge them.
   */
  label: z.string().optional(),
  /** Edition medium as the source names it — `CD`, `Vinyl`, `Digital Media`, … */
  media: z.string().optional(),
  releaseCountry: z.string().optional(),
  replayGain: replayGainSchema.optional(),
  /** Free-text `COMM` / Vorbis `COMMENT`, kept verbatim. */
  comment: z.string().optional(),
  credits: z.array(trackCreditSchema).optional(),
} as const;

export const trackSchema = timestampsSchema.extend({
  ...releaseEditionFields,
  id: z.string(),
  _id: z.string().optional(),
  title: z.string(),
  artistId: z.string(),
  artistName: z.string(),
  albumId: z.string().optional(),
  albumName: z.string().optional(),
  duration: z.number(),
  trackNumber: z.number().optional(),
  discNumber: z.number().optional(),
  audioSource: audioSourceSchema.optional(),
  coverArt: z.string().optional(),
  coverArtSizes: catalogImageSizesSchema.optional(),
  metadata: trackMetadataSchema.optional(),
  genre: z.string().optional(),
  mood: z.string().optional(),
  tags: z.array(z.string()).optional(),
  releaseDate: z.string().optional(),
  isExplicit: z.boolean(),
  popularity: z.number().optional(),
  playCount: z.number().optional(),
  favoriteCount: z.number().optional(),
  repostCount: z.number().optional(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  isAvailable: z.boolean(),
  copyrightRemoved: z.boolean().optional(),
  removedAt: z.string().optional(),
  removedReason: z.string().optional(),
  removedBy: z.string().optional(),
  copyrightReportId: z.string().optional(),
  source: catalogSourceSchema,
  status: trackStatusSchema,
  externalIds: externalIdsSchema.optional(),
  sources: z.array(sourceProvenanceSchema).optional(),
  images: z.array(trackImageSchema).optional(),
  hls: z.array(hlsRenditionSchema).optional(),
  loudnessLufs: z.number().optional(),
  hlsMasterKey: z.string().optional(),
  /**
   * Whether a public 30s preview clip can be served for this track. Derived by
   * the backend serializer (guest-playable + has a regenerable source); the
   * `@syra/sdk` reads this to decide whether to offer a preview. Optional for
   * backward compatibility with older API responses.
   */
  previewAvailable: z.boolean().optional(),
});
export type Track = z.infer<typeof trackSchema>;

/**
 * Which collection a playable item comes from.
 *
 * `track` is the public catalog (`tracks`); `upload` is a listener's own file in
 * their private locker (`userUploads`). The two are separate collections on
 * purpose — a private upload can never leak into a catalog read because no
 * catalog query touches its collection — so anything that resolves a stream or
 * addresses a queue entry has to say which one it means.
 */
export const playableKindSchema = z.enum(['track', 'upload']);
export type PlayableKind = z.infer<typeof playableKindSchema>;

/**
 * A catalog track as the player sees it: the Track DTO tagged with its kind.
 *
 * Deliberately a separate schema rather than a `kind` field on {@link trackSchema}:
 * every existing serializer and every stored API response predates the tag, so a
 * required discriminator on `trackSchema` itself would reject them at parse time.
 * The tag is defaulted, so a response that omits it still parses to `'track'`,
 * and the resulting type is a sound discriminated-union member.
 */
export const playableTrackSchema = trackSchema.extend({
  kind: z.literal('track').default('track'),
});
export type PlayableTrack = z.infer<typeof playableTrackSchema>;

export const trackWithContextSchema = trackSchema.extend({
  isLiked: z.boolean().optional(),
  isInPlaylist: z.boolean().optional(),
  playlists: z.array(z.string()).optional(),
});
export type TrackWithContext = z.infer<typeof trackWithContextSchema>;

export const createTrackRequestSchema = z.object({
  title: z.string(),
  artistId: z.string(),
  albumId: z.string().optional(),
  duration: z.number(),
  audioSource: audioSourceSchema,
  coverArt: z.string().optional(),
  metadata: trackMetadataSchema.optional(),
  isExplicit: z.boolean().optional(),
});
export type CreateTrackRequest = z.infer<typeof createTrackRequestSchema>;

export const updateTrackRequestSchema = z.object({
  title: z.string().optional(),
  albumId: z.string().optional(),
  trackNumber: z.number().optional(),
  discNumber: z.number().optional(),
  coverArt: z.string().optional(),
  metadata: trackMetadataSchema.partial().optional(),
  isAvailable: z.boolean().optional(),
});
export type UpdateTrackRequest = z.infer<typeof updateTrackRequestSchema>;
