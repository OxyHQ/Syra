import mongoose, { Schema, Document } from 'mongoose';

/**
 * How a user's "live" presence badge should surface across apps.
 *
 *  - `active`   — show me live whenever I host a live room (default).
 *  - `speaking` — show me live only while I'm actually an active speaker /
 *                 broadcasting, not merely hosting a live room in silence.
 */
export type LiveVisibility = 'active' | 'speaking';

export const LIVE_VISIBILITY_VALUES: readonly LiveVisibility[] = ['active', 'speaking'];

/** Applied when a user has never set a preference. */
export const DEFAULT_LIVE_VISIBILITY: LiveVisibility = 'active';

/** Runtime guard for untrusted (request-body) input. */
export function isLiveVisibility(value: unknown): value is LiveVisibility {
  return value === 'active' || value === 'speaking';
}

export interface IRoomUserPreference extends Document {
  /** Oxy user id — the owner of this preference row. One row per user. */
  userId: string;
  liveVisibility: LiveVisibility;
  createdAt: Date;
  updatedAt: Date;
}

const RoomUserPreferenceSchema = new Schema<IRoomUserPreference>({
  userId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  liveVisibility: {
    type: String,
    enum: LIVE_VISIBILITY_VALUES,
    default: DEFAULT_LIVE_VISIBILITY,
  },
}, { timestamps: true, versionKey: false });

export const RoomUserPreference = mongoose.model<IRoomUserPreference>(
  'RoomUserPreference',
  RoomUserPreferenceSchema,
);

export default RoomUserPreference;
