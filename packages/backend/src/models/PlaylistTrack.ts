import mongoose, { Schema, Document } from 'mongoose';

/**
 * PlaylistTrack - Links tracks to playlists with order information
 */
export interface IPlaylistTrack extends Document {
  _id: mongoose.Types.ObjectId;
  playlistId: mongoose.Types.ObjectId;
  trackId: string;
  addedAt: string;
  addedBy?: string; // oxyUserId who added the track
  order: number; // position in playlist
  createdAt: string;
  updatedAt: string;
}

const PlaylistTrackSchema = new Schema<IPlaylistTrack>({
  playlistId: { type: Schema.Types.ObjectId, ref: 'Playlist', required: true, index: true },
  trackId: { type: String, required: true, index: true },
  addedAt: { type: String, required: true },
  addedBy: { type: String },
  order: { type: Number, required: true },
}, {
  timestamps: true,
});

// Unique constraint: one track can only appear once in a playlist at a specific order
PlaylistTrackSchema.index({ playlistId: 1, order: 1 }, { unique: true });
PlaylistTrackSchema.index({ playlistId: 1, trackId: 1 });

export const PlaylistTrackModel = mongoose.model<IPlaylistTrack>('PlaylistTrack', PlaylistTrackSchema);






