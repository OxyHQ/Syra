import mongoose, { Document, Model, Schema } from 'mongoose';

export interface ILyricsLine {
  timeMs: number;
  text: string;
}

export interface ILyrics extends Document {
  trackId: string;
  synced: boolean;
  lines: ILyricsLine[];
  plain?: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

const LyricsLineSchema = new Schema<ILyricsLine>(
  { timeMs: { type: Number, required: true }, text: { type: String, required: true } },
  { _id: false },
);

const LyricsSchema = new Schema<ILyrics>(
  {
    trackId: { type: String, required: true, unique: true, index: true },
    synced: { type: Boolean, default: false },
    lines: { type: [LyricsLineSchema], default: [] },
    plain: { type: String },
    source: { type: String, required: true },
  },
  { timestamps: true },
);

export const LyricsModel: Model<ILyrics> =
  (mongoose.models.Lyrics as Model<ILyrics>) ??
  mongoose.model<ILyrics>('Lyrics', LyricsSchema);
