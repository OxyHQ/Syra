import mongoose, { Schema, Document } from 'mongoose';
import {
  Album,
  AlbumExternalIds,
  CatalogSource,
  ImageLicence,
  PROVENANCE_PROVIDERS,
  SourceProvenance,
} from '@syra/shared-types';
import type { CatalogImageSizes } from '@syra/shared-types/track';

export interface IAlbum extends Omit<Album, 'id' | '_id' | 'createdAt' | 'updatedAt'>, Document {
  _id: mongoose.Types.ObjectId;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  updatedAt: Date;
}

const AlbumExternalIdsSchema = new Schema<AlbumExternalIds>({
  isrc: { type: String },
  musicbrainzReleaseId: { type: String },
}, { _id: false });

const ImageLicenceSchema = new Schema<ImageLicence>({
  licence: { type: String, required: true },
  licenceUrl: { type: String },
  attribution: { type: String, required: true },
  sourceUrl: { type: String, required: true },
}, { _id: false });

const SourceProvenanceSchema = new Schema<SourceProvenance>({
  // The provenance LOG's vocabulary, wider than `CatalogSource`: it records
  // which external source supplied each field, so a claiming artist can see and
  // overwrite exactly what came from outside.
  provider: { type: String, enum: PROVENANCE_PROVIDERS, required: true },
  externalId: { type: String, required: true },
  importedAt: { type: String, required: true },
  fields: [{ type: String }],
}, { _id: false });

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

const AlbumSchema = new Schema<IAlbum>({
  title: { type: String, required: true, index: true },
  artistId: { type: String, required: true, index: true },
  artistName: { type: String, required: true, index: true },
  releaseDate: { type: String, required: true, index: true },
  // REQUIRED, and load-bearing rather than incidental: an album is not created
  // at all unless real cover art was found (embedded in the file, or recovered
  // from Cover Art Archive by release MBID) — its tracks stay individually
  // discoverable under the artist instead. Never invent a placeholder: it is
  // indistinguishable from real art at every later read, so it can never be
  // cleaned up.
  coverArt: { type: String, required: true },
  coverArtSizes: { type: CatalogImageSizesSchema },
  // Licence + authorship of `coverArt` when it came from Cover Art Archive.
  // Without somewhere to store it the importer must skip the image, and since
  // `coverArt` is required the album would never be created.
  coverArtLicence: { type: ImageLicenceSchema },
  genre: [{ type: String, index: true }],
  // From the right-hand side of TRCK (`3/12`), not from counting the files that
  // happened to be uploaded — a partial upload must not redefine the album.
  totalTracks: { type: Number, default: 0 },
  totalDiscs: { type: Number },
  totalDuration: { type: Number, default: 0 }, // in seconds
  type: { type: String, enum: ['album', 'single', 'ep', 'compilation'], default: 'album', index: true },
  label: { type: String },
  catalogNumber: { type: String },
  media: { type: String },
  releaseCountry: { type: String },
  // A string, not a Date: TDOR is routinely a bare year on a reissue.
  originalReleaseDate: { type: String },
  copyright: { type: String },
  // Dedup tier 1 for album resolution. The sparse-unique index is declared here
  // inline and is NOT repeated below.
  upc: { type: String, unique: true, sparse: true },
  popularity: { type: Number, default: 0, min: 0, max: 100 },
  playCount: { type: Number, default: 0 },
  favoriteCount: { type: Number, default: 0 },
  repostCount: { type: Number, default: 0 },
  isExplicit: { type: Boolean, default: false, index: true },
  // Creator-controlled container visibility. Absent means available, so existing albums
  // need no backfill. Mirrors `Track.isAvailable`, but hides only the CONTAINER — the
  // album's tracks stay individually discoverable unless they are unpublished too.
  isAvailable: { type: Boolean, default: true, index: true },
  primaryColor: { type: String },
  secondaryColor: { type: String },
  // Catalog provenance
  source: { type: String, enum: ['upload', 'cc'] as CatalogSource[], index: true },
  externalIds: { type: AlbumExternalIdsSchema },
  sources: [{ type: SourceProvenanceSchema }],
}, {
  timestamps: true,
});

// Indexes for common queries
AlbumSchema.index({ artistId: 1, releaseDate: -1 });
AlbumSchema.index({ title: 'text', artistName: 'text' }); // Text search
AlbumSchema.index({ popularity: -1 });
AlbumSchema.index({ releaseDate: -1 });
// External identifier lookups
AlbumSchema.index({ 'externalIds.isrc': 1 }, { sparse: true });
/**
 * Dedup tier 2 for album resolution, behind `upc`.
 *
 * Unique, so two concurrent uploads of the same release cannot each create an
 * album: the loser reads the `E11000` and uses the winner's row, the same way
 * `upc` already works. Sparse, because most releases have no MBID at all and
 * they must not all collide on a single missing-value slot.
 */
AlbumSchema.index({ 'externalIds.musicbrainzReleaseId': 1 }, { unique: true, sparse: true });

export const AlbumModel: mongoose.Model<IAlbum> =
  (mongoose.models.Album as mongoose.Model<IAlbum>) ??
  mongoose.model<IAlbum>('Album', AlbumSchema);
