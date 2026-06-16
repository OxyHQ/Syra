import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IImportJob extends Document {
  provider: 'audius' | 'cc';
  query: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ImportJobSchema = new Schema<IImportJob>(
  {
    provider: {
      type: String,
      enum: ['audius', 'cc'],
      required: true,
    },
    query: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },
    total: { type: Number, default: 0 },
    imported: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    error: { type: String },
  },
  { timestamps: true },
);

export const ImportJobModel: Model<IImportJob> =
  (mongoose.models.ImportJob as Model<IImportJob>) ??
  mongoose.model<IImportJob>('ImportJob', ImportJobSchema);
