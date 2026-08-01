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
  /**
   * A file in the user's private locker is about to expire for inactivity
   * (T−14d). Enabled by default like every other event, because the opt-out
   * shape means a new member needs no backfill — and "your music is about to be
   * deleted" is the last thing anyone should have to opt IN to.
   */
  'upload.expiring',
  /**
   * A file was REMOVED from the user's private locker by the platform — a
   * copyright takedown of that recording, or the termination of an account.
   *
   * The counterpart to `upload.expiring`, and needed for the same reason: a file
   * disappearing from someone's own library with no explanation is
   * indistinguishable from a bug, and they cannot appeal a removal nobody told
   * them about. Like every event here it is opt-OUT, so nobody has to have opted
   * in to be told their music is gone.
   */
  'upload.removed',
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
