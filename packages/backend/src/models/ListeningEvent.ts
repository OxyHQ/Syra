import mongoose, { Schema, Document } from 'mongoose';

/**
 * Where a play was initiated from. Used both as a recommendation signal (a play
 * started from "radio" is a weaker taste signal than one the user searched for)
 * and to attribute discovery surfaces.
 */
export type ListeningSource =
  | 'search'
  | 'library'
  | 'playlist'
  | 'album'
  | 'artist'
  | 'radio'
  | 'recommendation'
  | 'charts'
  | 'queue'
  | 'unknown';

/**
 * ListeningEvent — one durable, immutable record per finished (or abandoned)
 * play. Unlike `RecentlyPlayed` (a small, capped, per-user recency list for the
 * "Jump back in" UI), this collection is the canonical engagement signal that
 * powers the recommendation engine:
 *
 *   - Global popularity is recomputed from real plays (not just provider counts).
 *   - Per-user taste profiles are learned from the genre/artist of plays,
 *     weighted by how engaged the play was (completion vs. skip) and recency.
 *   - Track↔track and artist↔artist co-occurrence (the "fans also listened to"
 *     graph) is mined from each user's sequence of events.
 *
 * Events are bounded by a TTL index so the collection never grows unbounded;
 * the precomputed aggregates (popularity, taste, relations) are the durable
 * artifacts, not the raw events.
 */
export interface IListeningEvent extends Document {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  trackId: string;
  artistId: string;
  /** Lowercased primary genre at play time, if known. */
  genre?: string;
  /** Track length in seconds (snapshot) — used to compute completion ratio. */
  durationSec?: number;
  /** Seconds actually listened before the play ended. */
  listenedSec: number;
  /** listenedSec / durationSec, clamped to [0, 1]. 0 when duration unknown. */
  completion: number;
  /** True when the user advanced away before a meaningful portion played. */
  skipped: boolean;
  /** Surface the play started from. */
  source: ListeningSource;
  playedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const LISTENING_SOURCES: ListeningSource[] = [
  'search',
  'library',
  'playlist',
  'album',
  'artist',
  'radio',
  'recommendation',
  'charts',
  'queue',
  'unknown',
];

/** Raw events expire after 90 days; the learned aggregates persist. */
const LISTENING_EVENT_TTL_SEC = 90 * 24 * 60 * 60;

const ListeningEventSchema = new Schema<IListeningEvent>(
  {
    oxyUserId: { type: String, required: true, index: true },
    trackId: { type: String, required: true, index: true },
    artistId: { type: String, required: true, index: true },
    genre: { type: String },
    durationSec: { type: Number },
    listenedSec: { type: Number, required: true, default: 0, min: 0 },
    completion: { type: Number, required: true, default: 0, min: 0, max: 1 },
    skipped: { type: Boolean, required: true, default: false },
    source: { type: String, enum: LISTENING_SOURCES, default: 'unknown' },
    playedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true },
);

// Co-occurrence mining walks each user's events in time order.
ListeningEventSchema.index({ oxyUserId: 1, playedAt: 1 });
// Global popularity recompute scans recent events grouped by track.
ListeningEventSchema.index({ playedAt: -1 });
// Bound collection size; recommendations rely on precomputed aggregates.
ListeningEventSchema.index({ playedAt: 1 }, { expireAfterSeconds: LISTENING_EVENT_TTL_SEC });

export const ListeningEventModel: mongoose.Model<IListeningEvent> =
  (mongoose.models.ListeningEvent as mongoose.Model<IListeningEvent>) ??
  mongoose.model<IListeningEvent>('ListeningEvent', ListeningEventSchema);

export { LISTENING_SOURCES };
