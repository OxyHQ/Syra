import mongoose, { Schema, Document } from 'mongoose';

export interface ICopyrightReport extends Document {
  _id: mongoose.Types.ObjectId;
  trackId: string;
  artistId: string;
  reporterOxyUserId?: string; // Optional - public reports may not have user
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string; // Admin Oxy user ID
}

const CopyrightReportSchema = new Schema<ICopyrightReport>({
  trackId: { type: String, required: true, index: true },
  artistId: { type: String, required: true, index: true },
  reporterOxyUserId: { type: String, index: true },
  reason: { type: String, required: true },
  status: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected'], 
    default: 'pending',
    index: true 
  },
  createdAt: { type: Date, default: Date.now },
  resolvedAt: { type: Date },
  resolvedBy: { type: String },
}, {
  timestamps: true,
});

// Indexes for common queries
CopyrightReportSchema.index({ trackId: 1, status: 1 });
CopyrightReportSchema.index({ artistId: 1, status: 1 });
CopyrightReportSchema.index({ status: 1, createdAt: -1 });

export const CopyrightReportModel = mongoose.model<ICopyrightReport>('CopyrightReport', CopyrightReportSchema);






