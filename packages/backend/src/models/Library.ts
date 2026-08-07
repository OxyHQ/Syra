import mongoose, { Schema, Document } from 'mongoose';

/**
 * What is left of `UserLibrary`: podcast subscriptions, and nothing else.
 *
 * The document used to carry five arrays — `likedTracks`, `savedAlbums`,
 * `followedArtists`, `savedPlaylists`, `subscribedPodcasts`. Task 11 ported
 * four of them to real junction tables (`db/library/membership.ts`), and this
 * model is narrowed to the fifth in the same change rather than left holding
 * fields nothing writes.
 *
 * ## Why one array stayed
 *
 * `user_podcast_subscriptions.podcast_id` is a real foreign key to `podcasts`,
 * and `podcasts` rows are still written by `controllers/podcasts.controller.ts`
 * on Mongoose — Task 12's vertical. A drizzle insert would fail `23503`
 * against a table with no rows in it. A hybrid split survives a cross-vertical
 * READ and cannot survive a cross-vertical FOREIGN KEY, so this array moves
 * when its podcast writer does.
 *
 * ## Why the other four fields are DELETED rather than left in place
 *
 * Mongoose strict mode drops a `$set` on an undeclared path silently: no throw,
 * no warning, and the write reports success. If this schema still declared
 * `likedTracks`, a surviving `$addToSet: { likedTracks: … }` anywhere would go
 * on working, write to a collection nothing reads, and diverge from Postgres
 * with every gate green. With the field gone from `IUserLibrary` the same line
 * is a compile error instead — the split is held by the type checker rather
 * than by whoever remembers it.
 *
 * The two surfaces that still read this document are
 * `controllers/podcasts.controller.ts` (subscribe / unsubscribe / list) and
 * `services/notifications/triggers/episodePublished.ts` (the reverse fan-out to
 * every subscriber of a show).
 */
export interface IUserLibrary extends Document {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  subscribedPodcasts: string[]; // podcast IDs
  createdAt: string;
  updatedAt: string;
}

const UserLibrarySchema = new Schema<IUserLibrary>({
  oxyUserId: { type: String, required: true, unique: true, index: true },
  subscribedPodcasts: [{ type: String, index: true }],
}, {
  timestamps: true,
});

export const UserLibraryModel = mongoose.model<IUserLibrary>('UserLibrary', UserLibrarySchema);
