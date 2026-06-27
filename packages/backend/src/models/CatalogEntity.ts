import mongoose, { Schema, Document } from 'mongoose';
import {
  Artist,
  ArtistStats,
  CatalogSource,
  ExternalIds,
  SourceProvenance,
  TrackImage,
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
  image?: string;
  imageSizes?: CatalogImageSizes;
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
}

/** A `type:'person'` catalog entity — the podcast host/guest credit identity. */
export interface IPerson extends ICatalogEntity {
  type: 'person';
  /** Lowercased/trimmed name for low-confidence (name-only) dedup. */
  nameKey?: string;
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

const ExternalIdsSchema = new Schema<ExternalIds>({
  isrc: { type: String },
  audiusId: { type: String },
}, { _id: false });

const SourceProvenanceSchema = new Schema<SourceProvenance>({
  provider: { type: String, enum: ['upload', 'cc', 'audius'] as CatalogSource[], required: true },
  externalId: { type: String, required: true },
  importedAt: { type: String, required: true },
  fields: [{ type: String }],
}, { _id: false });

const ArtistImageSchema = new Schema<TrackImage>({
  url: { type: String, required: true },
  width: { type: Number },
  height: { type: Number },
  source: { type: String, enum: ['upload', 'cc', 'audius'] as CatalogSource[] },
}, { _id: false });

// ── Base schema (common identity fields) ────────────────────────────────────
const CatalogEntitySchema = new Schema<ICatalogEntity>({
  name: { type: String, required: true, index: true },
  image: { type: String }, // own S3 MongoDB ObjectId; converted to /api/images/:id in API responses
  imageSizes: { type: CatalogImageSizesSchema },
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
  source: { type: String, enum: ['upload', 'cc', 'audius'] as CatalogSource[], required: true, index: true },
  externalIds: { type: ExternalIdsSchema },
  sources: [{ type: SourceProvenanceSchema }],
  images: [{ type: ArtistImageSchema }],
  country: { type: String },
});

ArtistDiscriminatorSchema.index({ 'stats.followers': -1 });
ArtistDiscriminatorSchema.index({ verified: 1, popularity: -1 });
ArtistDiscriminatorSchema.index({ 'externalIds.audiusId': 1 }, { sparse: true });

// ── Person discriminator (type:'person') ────────────────────────────────────
const PersonDiscriminatorSchema = new Schema<IPerson>({
  nameKey: { type: String, index: true },
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
