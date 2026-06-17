import mongoose, { Schema, Document } from 'mongoose';
import {
  CatalogSource,
  ExternalIds,
  Playlist,
  PlaylistCollaborator,
  PlaylistVisibility,
  SourceProvenance,
} from '@syra/shared-types';
import type { CatalogImageSizes } from '@syra/shared-types/track';

export interface IPlaylist extends Omit<Playlist, 'id' | '_id'>, Document {
  _id: mongoose.Types.ObjectId;
}

const PlaylistCollaboratorSchema = new Schema<PlaylistCollaborator>({
  oxyUserId: { type: String, required: true },
  username: { type: String, required: true },
  role: { type: String, enum: ['owner', 'editor', 'viewer'], default: 'viewer' },
  addedAt: { type: String, required: true },
}, { _id: false });

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

const PlaylistSchema = new Schema<IPlaylist>({
  name: { type: String, required: true, index: true },
  description: { type: String },
  ownerOxyUserId: { type: String, required: true },
  ownerUsername: { type: String, required: true },
  coverArt: { type: String },
  coverArtSizes: { type: CatalogImageSizesSchema },
  visibility: { type: String, enum: Object.values(PlaylistVisibility), default: PlaylistVisibility.PRIVATE, index: true },
  trackCount: { type: Number, default: 0 },
  totalDuration: { type: Number, default: 0 },
  followers: { type: Number, default: 0 },
  primaryColor: { type: String },
  secondaryColor: { type: String },
  collaborators: [{ type: PlaylistCollaboratorSchema }],
  source: { type: String, enum: ['upload', 'cc', 'audius'] as CatalogSource[], index: true },
  externalIds: { type: ExternalIdsSchema },
  sources: [{ type: SourceProvenanceSchema }],
}, {
  timestamps: true,
});

PlaylistSchema.index({ ownerOxyUserId: 1, createdAt: -1 });
PlaylistSchema.index({ name: 'text', description: 'text' });
PlaylistSchema.index({ visibility: 1, followers: -1 });
PlaylistSchema.index({ 'externalIds.audiusId': 1 }, { sparse: true });

export const PlaylistModel = mongoose.model<IPlaylist>('Playlist', PlaylistSchema);
