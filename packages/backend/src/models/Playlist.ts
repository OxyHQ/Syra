import mongoose, { Schema, Document } from 'mongoose';
import { Playlist, PlaylistCollaborator, PlaylistVisibility } from '@syra/shared-types';

export interface IPlaylist extends Omit<Playlist, 'id'>, Document {
  _id: mongoose.Types.ObjectId;
}

const PlaylistCollaboratorSchema = new Schema<PlaylistCollaborator>({
  oxyUserId: { type: String, required: true },
  username: { type: String, required: true },
  role: { type: String, enum: ['owner', 'editor', 'viewer'], default: 'viewer' },
  addedAt: { type: String, required: true },
}, { _id: false });

const PlaylistSchema = new Schema<IPlaylist>({
  name: { type: String, required: true, index: true },
  description: { type: String },
  ownerOxyUserId: { type: String, required: true },
  ownerUsername: { type: String, required: true },
  coverArt: { type: String },
  visibility: { type: String, enum: Object.values(PlaylistVisibility), default: PlaylistVisibility.PRIVATE, index: true },
  trackCount: { type: Number, default: 0 },
  totalDuration: { type: Number, default: 0 }, // in seconds
  followers: { type: Number, default: 0 },
  isPublic: { type: Boolean, default: false, index: true },
  primaryColor: { type: String },
  secondaryColor: { type: String },
  collaborators: [{ type: PlaylistCollaboratorSchema }],
}, {
  timestamps: true,
});

// Indexes for common queries
PlaylistSchema.index({ ownerOxyUserId: 1, createdAt: -1 });
PlaylistSchema.index({ name: 'text', description: 'text' }); // Text search
PlaylistSchema.index({ visibility: 1, followers: -1 });
PlaylistSchema.index({ isPublic: 1, followers: -1 });

export const PlaylistModel = mongoose.model<IPlaylist>('Playlist', PlaylistSchema);

