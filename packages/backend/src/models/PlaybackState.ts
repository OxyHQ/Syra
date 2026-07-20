import mongoose, { Schema, Document } from 'mongoose';
import type { CatalogSource } from '@syra/shared-types';

export interface IPlaybackState extends Document {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  trackId?: string;
  source?: CatalogSource;
  positionMs: number;
  isPlaying: boolean;
  queue: string[];
  contextType?: string;
  contextId?: string;
  repeat: 'off' | 'all' | 'one';
  shuffle: boolean;
  volume: number;
  activeDeviceId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CATALOG_SOURCES: CatalogSource[] = ['upload', 'cc'];

const PlaybackStateSchema = new Schema<IPlaybackState>(
  {
    oxyUserId: { type: String, required: true, unique: true, index: true },
    trackId: { type: String },
    source: { type: String, enum: CATALOG_SOURCES },
    positionMs: { type: Number, default: 0, min: 0 },
    isPlaying: { type: Boolean, default: false },
    queue: { type: [String], default: [] },
    contextType: { type: String },
    contextId: { type: String },
    repeat: { type: String, enum: ['off', 'all', 'one'], default: 'off' },
    shuffle: { type: Boolean, default: false },
    volume: { type: Number, default: 1, min: 0, max: 1 },
    activeDeviceId: { type: String },
  },
  { timestamps: true },
);

export const PlaybackStateModel: mongoose.Model<IPlaybackState> =
  (mongoose.models.PlaybackState as mongoose.Model<IPlaybackState>) ??
  mongoose.model<IPlaybackState>('PlaybackState', PlaybackStateSchema);
