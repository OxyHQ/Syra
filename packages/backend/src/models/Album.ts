import mongoose, { Schema, Document } from 'mongoose';
import { Album, CatalogSource, ExternalIds, SourceProvenance } from '@syra/shared-types';

export interface IAlbum extends Omit<Album, 'id'>, Document {
  _id: mongoose.Types.ObjectId;
}

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

const AlbumSchema = new Schema<IAlbum>({
  title: { type: String, required: true, index: true },
  artistId: { type: String, required: true, index: true },
  artistName: { type: String, required: true, index: true },
  releaseDate: { type: String, required: true, index: true },
  coverArt: { type: String, required: true },
  genre: [{ type: String, index: true }],
  totalTracks: { type: Number, default: 0 },
  totalDuration: { type: Number, default: 0 }, // in seconds
  type: { type: String, enum: ['album', 'single', 'ep', 'compilation'], default: 'album', index: true },
  label: { type: String },
  copyright: { type: String },
  upc: { type: String, unique: true, sparse: true },
  popularity: { type: Number, default: 0, min: 0, max: 100 },
  isExplicit: { type: Boolean, default: false, index: true },
  primaryColor: { type: String },
  secondaryColor: { type: String },
  // Catalog provenance
  externalIds: { type: ExternalIdsSchema },
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

export const AlbumModel = mongoose.model<IAlbum>('Album', AlbumSchema);
