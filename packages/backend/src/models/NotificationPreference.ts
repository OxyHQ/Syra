import mongoose, { Schema, type Document } from 'mongoose';

/**
 * Syra-specific notification event types.
 *
 * Oxy owns the CHANNEL switch (`NotificationPreferences.pushEnabled` on the Oxy user,
 * shared across every Oxy app). This is the Syra EVENT TAXONOMY — which kinds of Syra
 * activity a user wants to hear about at all. The two compose: Oxy's switch is the
 * master, these are the per-event opt-outs beneath it.
 */
export const SYRA_NOTIFICATION_EVENTS = [
  /** A show the user subscribes to published a new episode. */
  'episode.published',
  /** An artist the user follows released a track or album. */
  'artist.release',
  /** A live room the user can see just went live. */
  'room.started',
  /** Someone changed a playlist the user collaborates on. */
  'playlist.collaboration',
] as const;

export type SyraNotificationEvent = (typeof SYRA_NOTIFICATION_EVENTS)[number];

export interface INotificationPreference extends Document {
  oxyUserId: string;
  /** Event types the user has explicitly turned OFF. Absent from this set = enabled. */
  disabledEvents: SyraNotificationEvent[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Stored as an opt-OUT list rather than an opt-in map so a user with no document is
 * fully enabled, and so adding a new event type later does not require backfilling
 * every existing user to switch it on.
 */
const NotificationPreferenceSchema = new Schema<INotificationPreference>(
  {
    oxyUserId: { type: String, required: true, unique: true, index: true },
    disabledEvents: [{ type: String, enum: SYRA_NOTIFICATION_EVENTS }],
  },
  { timestamps: true },
);

export const NotificationPreferenceModel: mongoose.Model<INotificationPreference> =
  mongoose.models.NotificationPreference ??
  mongoose.model<INotificationPreference>('NotificationPreference', NotificationPreferenceSchema);
