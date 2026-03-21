import mongoose, { Schema, Document } from 'mongoose';
import { Album } from '@syra/shared-types';

export interface IAlbum extends Omit<Album, 'id'>, Document {
  _id: mongoose.Types.ObjectId;
}

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
}, {
  timestamps: true,
});

// Indexes for common queries
AlbumSchema.index({ artistId: 1, releaseDate: -1 });
AlbumSchema.index({ title: 'text', artistName: 'text' }); // Text search
AlbumSchema.index({ popularity: -1 });
AlbumSchema.index({ releaseDate: -1 });

export const AlbumModel = mongoose.model<IAlbum>('Album', AlbumSchema);

