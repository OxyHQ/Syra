import mongoose, { Schema, Document } from 'mongoose';
import {
  Artist,
  ArtistExternalIds,
  ArtistImageSuggestion,
  ArtistStats,
  AttributableImage,
  CatalogSource,
  ImageLicence,
  SourceProvenance,
  TrackImage,
  isDenylistedArtistName,
  normalizeNameKey,
  PROVENANCE_PROVIDERS,
  ArtistMember,
} from '@syra/shared-types';
import type { CatalogImageSizes } from '@syra/shared-types/track';

/**
 * CatalogEntity — the ONE neutral catalog identity collection (`catalogentities`),
 * a Mongoose single-collection-inheritance model with a `type` discriminator:
 *
 *  - `type: 'artist'` — a music artist (tracks/albums reference its `_id` via
 *    `Track.artistId`/`Album.artistId`). Carries the catalog + moderation fields.
 *  - `type: 'person'` — a podcast host/guest credit identity (Podcasting 2.0
 *    `<podcast:person>` + creator additions), shared across every show/episode.
 *
 * `ArtistModel`/`PersonModel` are the `type`-scoped discriminator handles —
 * Mongoose auto-injects the `type` filter on `find`/`findOne`/`count`/`update`
 * so artist queries never see persons (and vice-versa). NOTE: `aggregate()` does
 * NOT auto-scope — pipelines must `$match { type: 'artist' }` explicitly.
 *
 * Oxy users remain a SEPARATE system (`linkedOxyUserId` links an entity to an
 * Oxy account; it is not an Oxy user row).
 *
 * Person dedup is by STRONG keys only (`linkedOxyUserId` → `href`); a name-only
 * credit never merges across a strong-key entity, and never merges into a
 * `type:'artist'` row by loose name.
 */

/** Sub-document type for a single copyright strike stored in MongoDB */
export interface IStrike {
  _id?: mongoose.Types.ObjectId;
  reason: string;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  trackId?: string;
}

export type CatalogEntityType = 'artist' | 'person';

/** Fields common to every catalog entity (base discriminator schema). */
export interface ICatalogEntity extends Document {
  _id: mongoose.Types.ObjectId;
  type: CatalogEntityType;
  name: string;
  /**
   * `name` normalised for matching: NFKD, diacritics stripped, lowercased,
   * punctuation and runs of whitespace collapsed.
   *
   * On the BASE schema because both entity types key on it, but the two use it
   * for opposite purposes and so carry different indexes (see below): for a
   * person it is a low-confidence dedup hint, for an artist it is a UNIQUE key.
   */
  nameKey?: string;
  image?: string;
  imageSizes?: CatalogImageSizes;
  /**
   * Licence + authorship of the CURRENT `image`, when it came from outside.
   * Absent means the image is the entity's own upload, which credits nobody.
   */
  imageLicence?: ImageLicence;
  primaryColor?: string;
  secondaryColor?: string;
  bio?: string;
  links?: Artist['links'];
  popularity?: number;
  ownerOxyUserId?: string;
  claimable?: boolean;
  claimedByOxyUserId?: string;
  /** Links this entity to an Oxy account (strong dedup key for persons). */
  linkedOxyUserId?: string;
  /** Stable `<podcast:person>` URL identity (strong dedup key for persons). */
  href?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A `type:'artist'` catalog entity — the music-artist view. */
export interface IArtist
  extends Omit<Artist, 'id' | '_id' | 'lastStrikeAt' | 'terminatedAt' | 'strikes' | 'createdAt' | 'updatedAt'>,
    ICatalogEntity {
  type: 'artist';
  lastStrikeAt?: Date;
  terminatedAt?: Date;
  strikes?: IStrike[];
  /**
   * Candidate profile photos awaiting the artist's decision — server-only.
   *
   * Declared here rather than inherited from `Artist`, because `artistSchema`
   * deliberately has NO field for these: a suggestion is a guess about what
   * somebody looks like, extracted from a stranger's file or matched from
   * Commons, and publishing a guess attaches it to a real person's name across
   * the whole product. The public DTO cannot express it and the Mongoose path is
   * `select: false`, so a profile serializer can neither name it nor spread it.
   * It is read only by the claim flow.
   */
  imageSuggestions?: IArtistImageSuggestion[];
}

/** A `type:'person'` catalog entity — the podcast host/guest credit identity. */
export interface IPerson extends ICatalogEntity {
  type: 'person';
  /** Links this person to a `type:'artist'` entity (claimed/owned artist). */
  linkedArtistId?: mongoose.Types.ObjectId;
  /** External avatar URL (RSS persons; distinct from artist `image` S3 id). */
  img?: string;
}

const CatalogImageVariantSchema = new Schema({
  id: { type: String, required: true },
  url: { type: String, required: true },
  width: { type: Number, required: true },
  height: { type: Number, required: true },
}, { _id: false });

const CatalogImageSizesSchema = new Schema<CatalogImageSizes>({
  small: { type: CatalogImageVariantSchema },
  medium: { type: CatalogImageVariantSchema },
  large: { type: CatalogImageVariantSchema },
  xlarge: { type: CatalogImageVariantSchema },
  xxlarge: { type: CatalogImageVariantSchema },
  original: { type: CatalogImageVariantSchema },
}, { _id: false });

const LinksSchema = new Schema({
  website: { type: String },
  instagram: { type: String },
  x: { type: String },
  youtube: { type: String },
  // From MusicBrainz URL relationships — the only source that supplies these for
  // an artist nobody at Syra has ever met.
  discogs: { type: String },
  wikidata: { type: String },
  wikipedia: { type: String },
  bandcamp: { type: String },
  soundcloud: { type: String },
}, { _id: false });

const ArtistStatsSchema = new Schema<ArtistStats>({
  followers: { type: Number, default: 0 },
  albums: { type: Number, default: 0 },
  tracks: { type: Number, default: 0 },
  totalPlays: { type: Number, default: 0 },
  monthlyListeners: { type: Number, default: 0 },
}, { _id: false });

const StrikeSchema = new Schema({
  reason: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  trackId: { type: String },
}, { _id: true });

const ArtistExternalIdsSchema = new Schema<ArtistExternalIds>({
  isrc: { type: String },
  musicbrainzArtistId: { type: String },
  /** International Standard Name Identifier. */
  isni: { type: String },
  /** Interested Parties Information code (rights societies). */
  ipi: { type: String },
  wikidataId: { type: String },
  discogsArtistId: { type: String },
}, { _id: false });

/**
 * A member of a group. Mirrors `artistMemberSchema`.
 *
 * `nameKey` is indexed for the same reason `Track.credits.nameKey` is: it turns
 * "everything this person played on" into a lookup instead of a scan.
 */
const ArtistMemberSchema = new Schema<ArtistMember>({
  name: { type: String, required: true },
  nameKey: { type: String, required: true },
  catalogEntityId: { type: String },
  // Strings, not Dates: MusicBrainz states bare years, and coercing invents a
  // precision the source never claimed.
  from: { type: String },
  until: { type: String },
}, { _id: false });

const SourceProvenanceSchema = new Schema<SourceProvenance>({
  // The provenance LOG's vocabulary, wider than `CatalogSource` — it records
  // which external source supplied each field, so a claiming artist can see and
  // overwrite exactly what was filled in from outside.
  provider: { type: String, enum: PROVENANCE_PROVIDERS, required: true },
  externalId: { type: String, required: true },
  importedAt: { type: String, required: true },
  fields: [{ type: String }],
}, { _id: false });

/**
 * Licence + authorship of an image we did not create.
 *
 * Every field but `licenceUrl` is required: CC BY-SA is discharged by naming the
 * author and linking the work and its licence, so an image rehosted without them
 * is a breach rather than an untidy record. `sourceUrl` is the file/description
 * PAGE — a link to the raw bytes states neither the author nor the licence.
 */
const ImageLicenceSchema = new Schema<ImageLicence>({
  licence: { type: String, required: true },
  licenceUrl: { type: String },
  attribution: { type: String, required: true },
  sourceUrl: { type: String, required: true },
}, { _id: false });

/**
 * The image inside a suggestion.
 *
 * `licence` is required exactly when `origin` is `external` — expressed as a
 * conditional `required`, which is how Mongoose says what the zod discriminated
 * union says: an own-upload has no third party to credit, an external image
 * cannot be stored without one. Mirrors `attributableImageSchema`.
 */
const AttributableImageSchema = new Schema<AttributableImage>({
  origin: { type: String, enum: ['upload', 'external'], required: true },
  url: { type: String, required: true },
  width: { type: Number },
  height: { type: Number },
  provider: {
    type: String,
    enum: ['wikimedia-commons', 'cover-art-archive', 'musicbrainz', 'discogs'],
    required(this: { origin?: string }) { return this.origin === 'external'; },
  },
  licence: {
    type: ImageLicenceSchema,
    required(this: { origin?: string }) { return this.origin === 'external'; },
  },
}, { _id: false });

/** A candidate profile photo as stored (`proposedAt` is a Date in Mongo). */
interface IArtistImageSuggestion extends Omit<ArtistImageSuggestion, 'proposedAt'> {
  proposedAt: Date;
}

const ArtistImageSuggestionSchema = new Schema<IArtistImageSuggestion>({
  image: { type: AttributableImageSchema, required: true },
  proposedAt: { type: Date, required: true, default: Date.now },
  proposedByOxyUserId: { type: String },
  sourceUploadId: { type: String },
}, { _id: false });

const ArtistImageSchema = new Schema<TrackImage>({
  url: { type: String, required: true },
  width: { type: Number },
  height: { type: Number },
  source: { type: String, enum: ['upload', 'cc'] as CatalogSource[] },
}, { _id: false });

// ── Base schema (common identity fields) ────────────────────────────────────
const CatalogEntitySchema = new Schema<ICatalogEntity>({
  name: { type: String, required: true, index: true },
  nameKey: { type: String },
  image: { type: String }, // own S3 MongoDB ObjectId; converted to /api/images/:id in API responses
  imageSizes: { type: CatalogImageSizesSchema },
  // Licence + authorship of the CURRENT `image`, when it came from outside.
  // Stored beside the image and rendered on the profile, because that is what
  // CC BY-SA requires — attribution held somewhere nobody displays discharges
  // nothing. Absent means the image is the entity's own upload.
  imageLicence: { type: ImageLicenceSchema },
  primaryColor: { type: String },
  secondaryColor: { type: String },
  bio: { type: String },
  links: { type: LinksSchema },
  popularity: { type: Number, default: 0 },
  ownerOxyUserId: { type: String },
  claimable: { type: Boolean, index: true },
  claimedByOxyUserId: { type: String },
  linkedOxyUserId: { type: String },
  href: { type: String },
}, {
  timestamps: true,
  discriminatorKey: 'type',
});

CatalogEntitySchema.index({ name: 'text' });
CatalogEntitySchema.index({ popularity: -1 });
CatalogEntitySchema.index({ ownerOxyUserId: 1 });
// Strong dedup keys (persons): one entity per Oxy user, one per podcast:person href.
CatalogEntitySchema.index({ linkedOxyUserId: 1 }, { unique: true, sparse: true });
CatalogEntitySchema.index({ href: 1 }, { unique: true, sparse: true });
/**
 * Name-key lookups, scoped by entity type.
 *
 * Compound with `type` rather than a bare `{ nameKey: 1 }`, and that is not a
 * preference: every discriminator's indexes are built on the ONE physical
 * `catalogentities` collection, so a bare `{ nameKey: 1 }` here and the artist's
 * unique one below would be two indexes on the same key pattern — MongoDB
 * rejects the second. Compounding also matches how the field is actually read,
 * since both discriminators inject their `type` into every query.
 */
CatalogEntitySchema.index({ type: 1, nameKey: 1 });

/**
 * `nameKey` is DERIVED from `name`, never supplied.
 *
 * A unique index over a field each caller fills for itself is a constraint over
 * whatever those callers happened to agree on — and they will not stay agreed.
 * Deriving it here means every `create()`/`save()` on either discriminator gets
 * the identical key from the identical function, so the index guards something
 * real. Anything a caller passed is overwritten rather than trusted: a
 * hand-written `nameKey` is either the same value or a bug.
 *
 * `findOneAndUpdate` upserts do NOT run document middleware, so a resolver
 * upserting by `nameKey` still computes it with `normalizeNameKey` at the call
 * site. That is the same function, which is the whole point.
 *
 * TAKES NO `next` PARAMETER, and that is not a style choice. Mongoose 9 / kareem
 * call document pre-hooks as `pre.fn.apply(context, $args)` with no trailing
 * callback (kareem/index.js:59), awaiting the hook only if it returns a promise.
 * For `pre('validate')` those `$args` are `[options]`, which is `null` on a
 * plain `create()` — so declaring a `next` parameter binds it to null and
 * calling it throws on EVERY save. This hook is synchronous: no parameter, no
 * return.
 */
CatalogEntitySchema.pre('validate', function setNameKey(this: ICatalogEntity) {
  if (this.isModified('name') || this.isNew) {
    this.nameKey = normalizeNameKey(this.name ?? '');
  }
});

// ── Artist discriminator (type:'artist') ────────────────────────────────────
const ArtistDiscriminatorSchema = new Schema<IArtist>({
  genres: [{ type: String, index: true }],
  verified: { type: Boolean, default: false, index: true },
  stats: { type: ArtistStatsSchema, default: () => ({
    followers: 0,
    albums: 0,
    tracks: 0,
    totalPlays: 0,
    monthlyListeners: 0,
  }) },
  strikeCount: { type: Number, default: 0, min: 0 },
  strikes: [{ type: StrikeSchema }],
  uploadsDisabled: { type: Boolean, default: false, index: true },
  lastStrikeAt: { type: Date },
  terminated: { type: Boolean, default: false, index: true },
  terminatedAt: { type: Date },
  terminationReason: { type: String },
  source: { type: String, enum: ['upload', 'cc'] as CatalogSource[], required: true, index: true },
  externalIds: { type: ArtistExternalIdsSchema },
  sources: [{ type: SourceProvenanceSchema }],
  images: [{ type: ArtistImageSchema }],
  country: { type: String },

  // ── Enrichment fields (MusicBrainz / Wikidata / Discogs) ──────────────────
  // These MUST exist here, not only on the zod `artistSchema`. Mongoose strict
  // mode DISCARDS a `$set` on an undeclared path silently — no throw, no warn —
  // while `IArtist` (derived from the zod type) makes the write typecheck. That
  // combination is invisible to tsc and to a green suite: the enrichment logged
  // eleven fields written and the database kept none of them.
  sortName: { type: String },
  disambiguation: { type: String },
  artistType: {
    type: String,
    enum: ['person', 'group', 'orchestra', 'choir', 'character', 'other'],
  },
  activeFrom: { type: String },
  activeUntil: { type: String },
  aliases: [{ type: String }],
  labels: [{ type: String }],
  members: [{ type: ArtistMemberSchema }],
  /**
   * How the profile came to exist. `registered` is the default because
   * self-service studio registration is the path that predates this field;
   * `contributed` profiles are written explicitly, together with
   * `claimable: true`.
   */
  origin: { type: String, enum: ['registered', 'contributed'], default: 'registered', index: true },
  /**
   * Whether this artist lets other people publish recordings onto their profile.
   * `false` by default, and the only thing that unblocks a contribution to an
   * already-claimed artist — attaching a stranger's file to a present artist's
   * page is the impersonation risk itself, so it is opt-in and theirs to give.
   */
  acceptsContributions: { type: Boolean, default: false },
  /**
   * Candidate profile photos awaiting the artist's decision — `select: false`.
   *
   * A suggestion is a GUESS about what somebody looks like, taken from a
   * stranger's file or matched from Commons. Publishing a guess attaches it to a
   * real person's name on every surface in the product, which is why it is only
   * ever surfaced in the claim flow. `select: false` is what makes that
   * structural rather than a rule to remember: a profile serializer cannot
   * spread a field the query never fetched, and `artistSchema` has no name for
   * it either, so it cannot be emitted deliberately either.
   */
  imageSuggestions: { type: [ArtistImageSuggestionSchema], select: false },
});

ArtistDiscriminatorSchema.index({ 'stats.followers': -1 });
ArtistDiscriminatorSchema.index({ verified: 1, popularity: -1 });

/**
 * ONE artist per normalised name.
 *
 * The race this closes is real and currently open: two uploads naming the same
 * artist arrive together, both find nothing, both insert, and the catalog holds
 * a permanent duplicate that no later write can merge. Only the index can
 * decide; the loser reads the `E11000` and uses the winner's row.
 *
 * Partial rather than `sparse`, because the constraint has to be ARTISTS-only
 * and `sparse` cannot say that. Persons share this collection and dedup by
 * strong keys — two hosts genuinely called "Jane Smith" are two persons — so a
 * collection-wide sparse-unique index on `nameKey` would forbid a legitimate
 * person and, worse, make an artist and an unrelated podcast guest collide.
 * `$type: 'string'` rather than `$exists: true` so an explicit `nameKey: null`
 * cannot occupy the single null slot and block every other artist.
 */
ArtistDiscriminatorSchema.index(
  { nameKey: 1 },
  { unique: true, partialFilterExpression: { type: 'artist', nameKey: { $type: 'string' } } },
);

/** "Everything this person played on" — one indexed lookup, not a scan over members[]. */
ArtistDiscriminatorSchema.index({ 'members.nameKey': 1 });

/** MusicBrainz artist MBID — the one strong artist identifier an uploaded file can carry. */
ArtistDiscriminatorSchema.index(
  { 'externalIds.musicbrainzArtistId': 1 },
  { unique: true, sparse: true },
);

/**
 * An artist is never a tagger's placeholder.
 *
 * "Unknown Artist" and "Various Artists" are what a tagger writes when it has
 * nothing. Admitted once, the row is permanent, and every untagged upload
 * afterwards attaches itself to it — while the recordings underneath have no
 * real attribution left to restore, so nobody can ever split them apart again.
 * This is the single path by which a catalog fills with irreversible garbage,
 * which is why the guard lives on the SCHEMA rather than in each caller.
 *
 * A DISCRIMINATOR HOOK, not a validator on the `name` path: the two
 * discriminators SHARE the base schema's `SchemaType` objects, so attaching a
 * validator to `name` attaches it to persons as well — and a podcast guest
 * genuinely credited as "Unknown" is a different claim about a different kind of
 * row. Verified the hard way; a `person validation failed` from an artist-only
 * rule is what that mistake looks like. Discriminator middleware runs only for
 * its own model.
 *
 * Same reason this takes no `next` parameter as the base hook above.
 */
ArtistDiscriminatorSchema.pre('validate', function rejectPlaceholderArtistName() {
  if (isDenylistedArtistName(this.name ?? '')) {
    throw new Error(
      `"${this.name}" is a placeholder, not an artist, and cannot become a catalog entity.`,
    );
  }
});


// ── Person discriminator (type:'person') ────────────────────────────────────
const PersonDiscriminatorSchema = new Schema<IPerson>({
  linkedArtistId: { type: Schema.Types.ObjectId, ref: 'CatalogEntity' },
  img: { type: String },
});

PersonDiscriminatorSchema.index({ linkedArtistId: 1 }, { sparse: true });

export const CatalogEntityModel: mongoose.Model<ICatalogEntity> =
  (mongoose.models.CatalogEntity as mongoose.Model<ICatalogEntity>) ??
  mongoose.model<ICatalogEntity>('CatalogEntity', CatalogEntitySchema);

export const ArtistModel: mongoose.Model<IArtist> =
  (CatalogEntityModel.discriminators?.artist as mongoose.Model<IArtist>) ??
  CatalogEntityModel.discriminator<IArtist>('artist', ArtistDiscriminatorSchema);

export const PersonModel: mongoose.Model<IPerson> =
  (CatalogEntityModel.discriminators?.person as mongoose.Model<IPerson>) ??
  CatalogEntityModel.discriminator<IPerson>('person', PersonDiscriminatorSchema);

