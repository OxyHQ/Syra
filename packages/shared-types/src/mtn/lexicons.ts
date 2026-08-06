/**
 * Syra's chain lexicons — `app.syra.*` record payloads.
 *
 * A person has ONE chain, held by Oxy, and every app appends its own records to
 * it. The Oxy Protocol owns the WIRE grammar (a signed envelope whose `record`
 * is opaque); a lexicon is the typed projection of that payload, addressed by an
 * AtProto-style `(collection, rkey)` key. Syra defines its own here without
 * touching the envelope — the same recipe Mention's `app.mention.feed.*` follows.
 *
 * ## Scope, and why it starts this small
 *
 * One content kind: a PUBLIC playlist. Not listens.
 *
 * That is a disclosure decision, not a scheduling one. `ListeningEvent` carries
 * no visibility field and Syra has no listening-privacy setting at all, so
 * putting listens on a shared chain would CREATE a disclosure rather than mirror
 * one a person already made — and a chain is append-only, so it would be a
 * disclosure nobody could take back. A playlist already carries an explicit
 * `visibility` the user chose, which is exactly what makes it publishable.
 *
 * When Syra grows a real "share my listening" setting, a listen lexicon can
 * follow the same rule: publish only what the person already chose to publish.
 */

import * as z from 'zod';
import { PlaylistVisibility, type PlaylistVisibility as PlaylistVisibilityType } from '../playlist';

/* -------------------------------------------------------------------------- */
/*  Collection NSIDs                                                          */
/* -------------------------------------------------------------------------- */

/** A playlist the person published. */
export const SYRA_PLAYLIST_COLLECTION = 'app.syra.feed.playlist' as const;

/**
 * A deletion marker superseding a previously published record.
 *
 * Not optional, and not a later nicety. A playlist can go from `public` back to
 * `private` or `unlisted`, and a chain is append-only — so without a way to
 * supersede, the first publish would be permanent and flipping a playlist
 * private would change nothing anyone else can see. The tombstone is what makes
 * the visibility control keep working after the first publish.
 */
export const SYRA_TOMBSTONE_COLLECTION = 'app.syra.feed.tombstone' as const;

/** Every Syra chain collection. */
export const SYRA_FEED_COLLECTIONS = [SYRA_PLAYLIST_COLLECTION, SYRA_TOMBSTONE_COLLECTION] as const;

export type SyraFeedCollection = (typeof SYRA_FEED_COLLECTIONS)[number];

/* -------------------------------------------------------------------------- */
/*  The publish gate                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Whether a playlist's visibility permits publishing it to the shared chain.
 *
 * `public` ONLY. `unlisted` is deliberately excluded and is the whole reason
 * this is a named function rather than an inline comparison: an unlisted
 * playlist is reachable by whoever holds its link and absent from every listing,
 * so putting it on a chain other apps read and project would un-list it — the
 * one thing its owner asked for. A `!== 'private'` test reads as equivalent and
 * is not.
 *
 * `private` is refused for the obvious reason, which is also the least likely to
 * be got wrong.
 */
export function isChainPublishablePlaylist(visibility: PlaylistVisibilityType): boolean {
  return visibility === PlaylistVisibility.PUBLIC;
}

/* -------------------------------------------------------------------------- */
/*  app.syra.feed.playlist                                                    */
/* -------------------------------------------------------------------------- */

/** A track as named on a published playlist record. */
export interface SyraPlaylistTrackRef {
  /** Syra's own track id — resolvable through Syra, opaque to every other app. */
  trackId: string;
  title: string;
  /** Primary artist's display name, denormalized so a reader renders without a second lookup. */
  artist?: string;
  /** ISRC when known — the one identifier that means the same thing outside Syra. */
  isrc?: string;
}

export const syraPlaylistTrackRefSchema: z.ZodType<SyraPlaylistTrackRef> = z.object({
  trackId: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().optional(),
  isrc: z.string().optional(),
});

/**
 * The payload of an `app.syra.feed.playlist` record.
 *
 * `rkey` is the playlist's own Syra id, so re-publishing supersedes rather than
 * duplicates — which is how an edit works, and how a rename reaches readers.
 *
 * Tracks are capped and denormalized on purpose. A chain record is replicated to
 * every node following the subject and committed to by the transparency log, so
 * it carries what a reader needs to RENDER the playlist, not the playlist's
 * whole state. Anything beyond the cap is fetched from Syra by `playlistId`.
 */
export interface SyraPlaylistRecord {
  playlistId: string;
  name: string;
  description?: string;
  /** Cover art content address, when the playlist has one. */
  coverSha256?: string;
  /** Total tracks, which may exceed `tracks.length`. */
  trackCount: number;
  tracks: SyraPlaylistTrackRef[];
  /** ISO 8601. Self-asserted, so a reader clamps it rather than trusting it. */
  createdAt: string;
}

/** Most tracks carried inline on one record. Beyond this, readers fetch from Syra. */
export const SYRA_PLAYLIST_INLINE_TRACK_CAP = 50;

export const syraPlaylistRecordSchema: z.ZodType<SyraPlaylistRecord> = z.object({
  playlistId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  coverSha256: z.string().optional(),
  trackCount: z.number().int().nonnegative(),
  tracks: z.array(syraPlaylistTrackRefSchema).max(SYRA_PLAYLIST_INLINE_TRACK_CAP),
  createdAt: z.string().min(1),
});

/* -------------------------------------------------------------------------- */
/*  app.syra.feed.tombstone                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The payload of an `app.syra.feed.tombstone` record: the record it supersedes.
 *
 * `subject` is the superseded record's `(collection, rkey)` pair rendered as
 * `<collection>/<rkey>`, so a tombstone names what it removes without depending
 * on a content address the publisher may not have kept.
 */
export interface SyraTombstoneRecord {
  subject: string;
  createdAt: string;
}

export const syraTombstoneRecordSchema: z.ZodType<SyraTombstoneRecord> = z.object({
  subject: z.string().min(1),
  createdAt: z.string().min(1),
});

/** The `subject` a tombstone carries for a given record key. */
export function syraRecordSubject(collection: SyraFeedCollection, rkey: string): string {
  return `${collection}/${rkey}`;
}
