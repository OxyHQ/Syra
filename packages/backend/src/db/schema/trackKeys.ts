/**
 * `track_keys` — the AES-128 key one encrypted HLS package decrypts with,
 * filed under the row that package belongs to.
 *
 * ## Why this table has a module of its own
 *
 * It is the only table in this schema that references THREE verticals:
 * `tracks` (catalog), `user_uploads` (creators) and `episodes` (podcasts).
 * Declaring it inside any one of them would make that vertical import the
 * other two, and `catalog.ts` <-> `podcasts.ts` is a cycle with an EAGER read
 * in it — `episodes.audioSourceFormat` is `text({ enum: AUDIO_FORMATS })`,
 * evaluated while the columns object is built, so whichever module loads first
 * throws `Cannot access 'AUDIO_FORMATS' before initialization`. That is the
 * same hazard `creators.ts`'s `UPLOAD_AUDIO_FORMATS` comment records, and the
 * resolution there — declare the enum locally so no eager read crosses the
 * cycle — is not available here: it would mean changing what `episodes`
 * declares purely to let this table live next door.
 *
 * A leaf module imports all three and is imported by none of them, so there is
 * no cycle to reason about at all. The barrel re-exports it like any other
 * table module.
 *
 * ## One column per id space, not one polymorphic column plus a `kind`
 *
 * Mongo stored a bare `trackId` that meant a track, a locker upload or an
 * episode depending on which pipeline wrote it, and the port carried that
 * across with a `kind` discriminator. That was expressible, but it was still a
 * column no foreign key can hang off, because Postgres has no conditional
 * reference — and the absence had a live consequence rather than a theoretical
 * one. With no cascade, every caller deleting a parent had to remember to
 * delete the key, and `services/uploads/expirySweeper.ts` — the path that runs
 * unattended every hour — never did, so most expired uploads left an AES key
 * behind forever, keyed by an id that resolved to nothing. The `tracks` and
 * `episodes` arms had the same shape and the same gap, latent only because
 * nothing deletes those rows yet.
 *
 * Three real `ON DELETE cascade` references make the orphan structurally
 * impossible instead of merely remembered. The CHECK is what keeps the three
 * columns a discriminated union rather than three independent optional fields:
 * exactly one is non-null, which is the invariant `kind` asserted and could not
 * enforce. No row legitimately carries none — `storePackagedHls`
 * (`services/ingest/hlsStorage.ts`) is the only writer, and its
 * `StoreHlsTarget` requires the owning record before it packages anything.
 *
 * The three per-arm uniques replace a single unique over the shared column.
 * That is the second thing the split fixes: one constraint over three id spaces
 * made them share one namespace, on the strength of a comment saying they never
 * collide.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { tracks } from './catalog';
import { userUploads } from './creators';
import { episodes } from './podcasts';

export const trackKeys = pgTable(
  'track_keys',
  {
    id: generatedId(),
    /** Set iff this key belongs to a catalogue track (`ingestTrack.ts`). */
    trackId: text().references(() => tracks.id, { onDelete: 'cascade' }),
    /** Set iff this key belongs to a private-locker upload (`ingestUserUpload.ts`). */
    userUploadId: text().references(() => userUploads.id, { onDelete: 'cascade' }),
    /** Set iff this key belongs to a podcast episode (`ingestEpisode.ts`). */
    episodeId: text().references(() => episodes.id, { onDelete: 'cascade' }),
    keyHex: text().notNull(),
    keyUri: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'track_keys_one_parent_check',
      sql`num_nonnulls(${t.trackId}, ${t.userUploadId}, ${t.episodeId}) = 1`
    ),
    unique('track_keys_track_id_key').on(t.trackId),
    unique('track_keys_user_upload_id_key').on(t.userUploadId),
    unique('track_keys_episode_id_key').on(t.episodeId),
  ]
);
