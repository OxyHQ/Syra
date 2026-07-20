import mongoose, { Schema, type Document } from 'mongoose';

export interface INotificationSuppression extends Document {
  oxyUserId: string;
  /** Composite suppression key — either an exact-entity key or a coalescing-group key. */
  key: string;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Records that a notification was already emitted for a (user, key) pair, so the notifier
 * can refuse to emit again.
 *
 * Two distinct keys use this one collection:
 *  - EXACT   `<event>:<entityId>` — never notify the same user about the same thing twice,
 *    even across retries, re-imports, or a second app instance.
 *  - COALESCE `<event>:group:<groupId>` — at most one notification per group per window,
 *    so a show that publishes three episodes in an hour produces one push, not three.
 *
 * The unique index is what enforces it: the notifier INSERTS first and treats a duplicate-key
 * error as "already notified, skip". Checking-then-writing would race under concurrent feed
 * refreshes and let duplicates through — the insert is the decision, not a lookup before it.
 *
 * `expiresAt` drives a TTL index so this collection self-prunes.
 */
const NotificationSuppressionSchema = new Schema<INotificationSuppression>(
  {
    oxyUserId: { type: String, required: true },
    key: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

NotificationSuppressionSchema.index({ oxyUserId: 1, key: 1 }, { unique: true });
NotificationSuppressionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const NotificationSuppressionModel: mongoose.Model<INotificationSuppression> =
  mongoose.models.NotificationSuppression ??
  mongoose.model<INotificationSuppression>('NotificationSuppression', NotificationSuppressionSchema);
