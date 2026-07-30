import mongoose, { Document, Model, Schema } from 'mongoose';

/**
 * A report a listener filed in Syra.
 *
 * Two status axes, because they answer two different questions and one field
 * cannot hold both. `localStatus` is where the report is in SYRA's pipeline —
 * stored, queued, delivered, failed, closed. `status` is what a jury concluded. A
 * report is routinely `submitted` with no verdict yet, and `closed` with a verdict
 * of `dismissed`.
 *
 * ## This is NOT the copyright flow, and the two must never merge
 *
 * `CopyrightReport` already exists and is a real DMCA pipeline: reports, admin
 * resolution, three strikes, artist termination, `copyrightRemoved` takedown. It
 * stays exactly where it is.
 *
 * The reason is not tidiness — the contract itself says so. The universal
 * taxonomy has forty codes across eleven families and NOT ONE of them is
 * copyright, infringement or intellectual property; the nearest, `commerce.counterfeit`,
 * is about goods. That absence is deliberate: DMCA carries statutory process,
 * counter-notice and safe-harbour consequences, and §7.5 routes material with
 * legal weight to specialists rather than to a randomly drawn jury. A community
 * vote is the wrong instrument for it and there is no code to express the
 * allegation with.
 *
 * So: CrowdSource decides conduct and content on the catalog; `CopyrightReport`
 * decides copyright. Two questions, two processes, no overlap — and deliberately
 * no `copyright` value in {@link ReportCategory}, so nobody can file one here by
 * accident.
 */

/**
 * What Syra will accept a report ABOUT.
 *
 * Wider than what it can deliver, and deliberately so — see
 * `moderation/subjects/registry.ts`. A type with a subject provider is sent for
 * community review; a type without one is stored with the reason and never leaves.
 */
export enum ReportedType {
  /** A user's public playlist. */
  PLAYLIST = 'playlist',
  /** A user-created house (community). */
  HOUSE = 'house',
  /** A Syra artist profile. */
  ARTIST = 'artist',
  /** A track in the catalog. */
  TRACK = 'track',
  /** A live or ended audio room. */
  ROOM = 'room',
  /**
   * A mirrored podcast show. Accepted, never delivered — see the registry: the
   * publisher is a third party outside Syra with no Oxy identity.
   */
  PODCAST = 'podcast',
  /** A mirrored podcast episode. Accepted, never delivered, same reason. */
  EPISODE = 'episode',
  /**
   * A listener's account. Accepted, never delivered — Oxy owns identity and a
   * plain listener has no Syra-side profile to snapshot. (An ARTIST does, which is
   * why that one is deliverable and this one is not.)
   */
  USER = 'user',
}

/**
 * What the reporter says is wrong.
 *
 * No `copyright` value, on purpose — see the note at the top of this file.
 */
export enum ReportCategory {
  SPAM = 'spam',
  HARASSMENT = 'harassment',
  HATE_SPEECH = 'hate_speech',
  EXPLICIT_CONTENT = 'explicit_content',
  IMPERSONATION = 'impersonation',
  VIOLENCE = 'violence',
  OTHER = 'other',
}

/** What a jury concluded. `PENDING` until one has. */
export enum ReportStatus {
  PENDING = 'pending',
  REVIEWED = 'reviewed',
  RESOLVED = 'resolved',
  DISMISSED = 'dismissed',
}

/**
 * Where the report is in Syra's own pipeline.
 *
 * `received` and `delivery_failed` are NOT the same claim. `received` means there
 * was never a route out of this application for this kind of object;
 * `delivery_failed` means there is one and it did not work this time. Only the
 * second is worth retrying, and only the first is a deliberate state.
 */
export type ModerationLocalStatus =
  | 'received'
  | 'queued'
  | 'submitted'
  | 'delivery_failed'
  | 'closed';

export const MODERATION_LOCAL_STATUSES: readonly ModerationLocalStatus[] = [
  'received',
  'queued',
  'submitted',
  'delivery_failed',
  'closed',
];

export interface IReport extends Document {
  /**
   * Declared explicitly because a bare `Document` types `_id` as `unknown`, and
   * the report id IS the `externalReportId` the whole CrowdSource side is keyed on.
   */
  _id: mongoose.Types.ObjectId;
  reportedType: ReportedType;
  reportedId: string;
  /** The reporter's Oxy user id, which IS the §11.14 binding proof. */
  reporter: string;
  categories: ReportCategory[];
  details?: string;

  status: ReportStatus;
  localStatus: ModerationLocalStatus;
  localStatusReason?: string;
  lastDeliveryError?: string;

  crowdSourceReportId?: string;
  crowdSourceCaseId?: string;
  crowdSourceMerged?: boolean;
  /** §5.6: the digest of the exact representation that was sent for review. */
  contentSnapshotHash?: string;
  submittedAt?: Date;

  decisionId?: string;
  decisionRevision?: number;
  decisionOutcome?: string;
  decisionStatus?: string;
  decidedAt?: Date;
  enforcedAction?: string;
  enforcedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const ReportSchema = new Schema<IReport>(
  {
    reportedType: {
      type: String,
      enum: Object.values(ReportedType),
      required: true,
      index: true,
    },
    /**
     * A String, not an ObjectId. Syra addresses several of its own nouns by
     * string id already, and this value travels verbatim into the envelope —
     * casting it through an ObjectId would either throw on a legitimate id or
     * silently change what a binding proof is checked against.
     */
    reportedId: { type: String, required: true },
    reporter: { type: String, required: true, index: true },
    categories: {
      type: [{ type: String, enum: Object.values(ReportCategory) }],
      required: true,
      validate: {
        validator: (categories: string[]) => categories.length > 0,
        message: 'A report must carry at least one category.',
      },
    },
    details: { type: String, maxlength: 2000 },

    status: {
      type: String,
      enum: Object.values(ReportStatus),
      default: ReportStatus.PENDING,
      index: true,
    },
    localStatus: {
      type: String,
      enum: MODERATION_LOCAL_STATUSES,
      default: 'received',
      index: true,
    },
    localStatusReason: { type: String, maxlength: 300 },
    lastDeliveryError: { type: String, maxlength: 2000 },

    crowdSourceReportId: { type: String },
    crowdSourceCaseId: { type: String, index: true },
    crowdSourceMerged: { type: Boolean },
    contentSnapshotHash: { type: String },
    submittedAt: { type: Date },

    decisionId: { type: String },
    decisionRevision: { type: Number },
    decisionOutcome: { type: String },
    decisionStatus: { type: String },
    decidedAt: { type: Date },
    enforcedAction: { type: String },
    enforcedAt: { type: Date },
  },
  { timestamps: true },
);

/**
 * One report per reporter per object.
 *
 * A unique index rather than a check in the handler: two concurrent submissions
 * from the same client are the ordinary case (a double tap), and a read-then-write
 * leaves exactly the gap where the second one lands.
 */
ReportSchema.index({ reporter: 1, reportedType: 1, reportedId: 1 }, { unique: true });
ReportSchema.index({ localStatus: 1, createdAt: 1 });

export type LeanReport = Omit<IReport, keyof Document> & { _id: mongoose.Types.ObjectId };

export const ReportModel: Model<IReport> =
  mongoose.models.Report || mongoose.model<IReport>('Report', ReportSchema);
