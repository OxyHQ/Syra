import mongoose, { Schema, Document } from 'mongoose';
import type {
  ContributionAttestation,
  ProvenanceMarker,
  ProvenanceReport,
  RawTags,
} from '@syra/shared-types';

/**
 * ContributionAttestation — the evidence chain behind a contributed track.
 *
 * When somebody publishes a recording they did not upload as its artist, the
 * statement they signed is the only thing standing between Syra and the claim
 * that it distributed the work on its own initiative. An attestation stored
 * without who made it, from where, when, and against which screening result is
 * not evidence — and evidence is the entire reason the record exists. So the
 * request context and the provenance report that was current at signing time are
 * part of the document, captured once and never rewritten.
 *
 * One row per contributed track: the attestation belongs to the publication, and
 * a second publication of the same recording is a second decision to defend.
 */
export interface IContributionAttestation
  extends Omit<ContributionAttestation, 'id' | '_id' | 'createdAt' | 'updatedAt' | 'acceptedAt'>,
    Document {
  _id: mongoose.Types.ObjectId;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  acceptedAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  updatedAt: Date;
}

const ProvenanceMarkerSchema = new Schema<ProvenanceMarker>({
  code: { type: String, required: true },
  weight: { type: String, enum: ['low', 'medium', 'high', 'blocking'], required: true },
  detail: { type: String },
}, { _id: false });

const ProvenanceReportSchema = new Schema<ProvenanceReport>({
  markers: { type: [ProvenanceMarkerSchema], default: [] },
  score: { type: Number, required: true },
  verdict: { type: String, enum: ['clean', 'suspect', 'commercial'], required: true },
}, { _id: false });

const RawTagsSchema = new Schema<RawTags>({
  format: { type: String },
  json: { type: String, required: true },
  truncated: { type: Boolean, required: true },
  originalByteLength: { type: Number, required: true },
}, { _id: false });

const ContributionAttestationSchema = new Schema<IContributionAttestation>({
  trackId: { type: String, required: true, unique: true, index: true },
  uploaderOxyUserId: { type: String, required: true, index: true },
  /** The exact wording the uploader agreed to, stored verbatim — a later edit to the copy must not change what a past signature says. */
  statement: { type: String, required: true },
  acceptedAt: { type: Date, required: true },
  ip: { type: String },
  userAgent: { type: String },
  provenanceReport: { type: ProvenanceReportSchema },
  /**
   * The file's tags as they stood at signing time — `select: false`, same
   * mechanical guard as on `UserUpload`. Duplicated here rather than referenced,
   * because the upload can be deleted and the evidence for a PUBLISHED recording
   * has to outlive it.
   */
  rawTags: { type: RawTagsSchema, select: false },
}, {
  timestamps: true,
});

export const ContributionAttestationModel: mongoose.Model<IContributionAttestation> =
  (mongoose.models.ContributionAttestation as mongoose.Model<IContributionAttestation>) ??
  mongoose.model<IContributionAttestation>('ContributionAttestation', ContributionAttestationSchema);
