import mongoose, { Schema, Document } from 'mongoose';

/**
 * UserLibrary - User's personal music library (liked tracks, saved albums, followed artists)
 */
export interface IUserLibrary extends Document {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  likedTracks: string[]; // track IDs
  savedAlbums: string[]; // album IDs
  followedArtists: string[]; // artist IDs
  createdAt: string;
  updatedAt: string;
}

const UserLibrarySchema = new Schema<IUserLibrary>({
  oxyUserId: { type: String, required: true, unique: true, index: true },
  likedTracks: [{ type: String, index: true }],
  savedAlbums: [{ type: String, index: true }],
  followedArtists: [{ type: String, index: true }],
}, {
  timestamps: true,
});

export const UserLibraryModel = mongoose.model<IUserLibrary>('UserLibrary', UserLibrarySchema);






