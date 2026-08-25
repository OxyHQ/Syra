/**
 * Deleting a Syra-hosted show or one of its episodes — the row half.
 *
 * Nothing in this vertical deleted a podcast or an episode before, which is why
 * `schema/trackKeys.ts`'s doc comment can say the `episodes` arm of its cascade
 * was "latent only because nothing deletes those rows yet". This module is what
 * makes it live. The BYTES half is `services/podcasts/deletePodcast.ts`, and the
 * order between the two is that service's decision, not this module's.
 *
 * ## Why a row DELETE and not `status = 'removed'`
 *
 * `PODCAST_STATUSES` carries `removed`, and reusing it here was the obvious
 * cheaper move. It is wrong twice over:
 *
 *  - `removed` means a PLATFORM TAKEDOWN. `podcasts.controller.ts`'s
 *    `loadOwnedShowOrRespond` answers a `removed` show with
 *    `409 "This show was removed by the platform and cannot be republished"`,
 *    so a creator deleting their own show would be told the platform did it,
 *    and would be permanently barred from republishing — which makes it not
 *    even a reversible soft delete.
 *  - It would not hide the show from the one person who asked it to go.
 *    `findPodcastsByOwner` is deliberately unfiltered by status ("this is their
 *    dashboard … the owner filter IS the access control"), so a soft-deleted
 *    show sits in "My podcasts" for ever. A delete button whose show is still
 *    listed afterwards is the exact bug this route exists to fix.
 *
 * ## What one `DELETE FROM podcasts` takes with it
 *
 * Every one of these is a real `ON DELETE CASCADE` in the generated migration
 * (`drizzle/0004_workable_hellion.sql`, `0023`, `0028`), not merely a
 * `.references()` in the schema — verified against the migrated database rather
 * than read off the TypeScript:
 *
 *   podcasts -> episodes -> episode_hls_renditions, episode_persons,
 *                           episode_transcripts, episode_progress,
 *                           episode_ingest_tickets, track_keys
 *            -> podcast_categories, podcast_funding, podcast_persons,
 *               podcast_sources, user_podcast_subscriptions
 *
 * Two of those reach OTHER PEOPLE's rows and are worth naming rather than
 * discovering: `episode_progress` is every listener's resume position, and
 * `user_podcast_subscriptions` is every subscriber's subscription. Both are
 * meaningless without the show, so the cascade is correct — but a creator
 * deleting a published show does destroy strangers' state, and that is a
 * property of the feature, not an accident of the schema.
 *
 * `episode_ingest_tickets` cascading is load-bearing in the other direction: an
 * Alia worker holding a live ticket for an episode of a deleted show finds the
 * capability gone rather than pointing at a row that no longer exists.
 *
 * ## What is NOT reached, deliberately
 *
 *  - `image_assets`. The cover columns reference it `ON DELETE set null`, so the
 *    dependency runs the other way and deleting a show orphans its artwork rows
 *    and their S3 objects. They are left, on purpose: `resolveCover` accepts any
 *    existing asset id with no exclusivity check, so one asset may be referenced
 *    by several shows and episodes, and nothing in the schema records how many.
 *    Deleting an asset that another row still points at would blank a show
 *    nobody asked to touch — the "delete quietly takes more than it said"
 *    failure. Reclaiming them needs a sweeper that can prove non-reference
 *    across every referencing column, which is a separate change with its own
 *    census.
 *  - `room_media_queue_items.episode_id` / `.syra_podcast_id`. Deliberately
 *    unconstrained (`schema/deferredForeignKeys.ts` says why: they resolve over
 *    HTTP, never in SQL), so a live room queueing a deleted episode keeps a
 *    dangling id. `resolvePodcastEpisode` answers `not_found` for it and the
 *    room drops the entry, which is the behaviour that column was designed for.
 */

import { count, eq, inArray } from 'drizzle-orm';
import { getDb } from '../postgres';
import { episodeHlsRenditions, episodes, podcasts } from '../schema/podcasts';
import { descNullsLast } from '../catalog/containers';

/**
 * Where one episode's bytes are — the projection a purge reads, and nothing
 * more.
 *
 * A projection rather than the whole row because this crosses into the storage
 * service, and the set of columns that name an object is exactly the set that
 * has to be kept in step with ingest. `EpisodeRow` would carry forty columns and
 * hide which four matter.
 */
export interface EpisodeStorageRef {
  readonly id: string;
  readonly podcastId: string;
  /** Decides the SOURCE audio object's extension; null for an episode never ingested. */
  readonly audioSourceFormat: string | null;
  readonly hlsMasterKey: string | null;
  /** The RSS enclosure copied into Syra storage — null on a Syra-hosted episode. */
  readonly cacheObjectKey: string | null;
  readonly cacheHlsMasterKey: string | null;
  /** Each rendition's manifest. The SEGMENTS beside them are recorded nowhere. */
  readonly hlsManifestKeys: readonly string[];
}

/** The storage columns, in the one spelling both readers below share. */
const STORAGE_COLUMNS = {
  id: episodes.id,
  podcastId: episodes.podcastId,
  audioSourceFormat: episodes.audioSourceFormat,
  hlsMasterKey: episodes.hlsMasterKey,
  cacheObjectKey: episodes.cacheObjectKey,
  cacheHlsMasterKey: episodes.cacheHlsMasterKey,
} as const;

/** Attach each episode's rendition manifests to its storage projection. */
async function withManifestKeys(
  rows: readonly {
    id: string;
    podcastId: string;
    audioSourceFormat: string | null;
    hlsMasterKey: string | null;
    cacheObjectKey: string | null;
    cacheHlsMasterKey: string | null;
  }[]
): Promise<EpisodeStorageRef[]> {
  if (rows.length === 0) return [];

  const manifests = new Map<string, string[]>();
  const renditions = await getDb()
    .select({ episodeId: episodeHlsRenditions.episodeId, manifestKey: episodeHlsRenditions.manifestKey })
    .from(episodeHlsRenditions)
    .where(inArray(episodeHlsRenditions.episodeId, rows.map((row) => row.id)));

  for (const rendition of renditions) {
    const existing = manifests.get(rendition.episodeId);
    if (existing) existing.push(rendition.manifestKey);
    else manifests.set(rendition.episodeId, [rendition.manifestKey]);
  }

  return rows.map((row) => ({ ...row, hlsManifestKeys: manifests.get(row.id) ?? [] }));
}

/** Where ONE episode's bytes are, or undefined when no such episode exists. */
export async function findEpisodeStorageRef(
  episodeId: string
): Promise<EpisodeStorageRef | undefined> {
  const rows = await getDb().select(STORAGE_COLUMNS).from(episodes).where(eq(episodes.id, episodeId));
  const [ref] = await withManifestKeys(rows);
  return ref;
}

/**
 * Where EVERY episode of one show keeps its bytes.
 *
 * Unfiltered by `status`: a `failed` or `processing` episode may already have
 * uploaded source audio, and one skipped here is one object left in the bucket
 * after the row naming it is gone — with nothing able to find it again.
 */
export async function findEpisodeStorageRefsByShow(
  podcastId: string
): Promise<EpisodeStorageRef[]> {
  const rows = await getDb()
    .select(STORAGE_COLUMNS)
    .from(episodes)
    .where(eq(episodes.podcastId, podcastId));
  return withManifestKeys(rows);
}

/**
 * Delete the show row, and with it everything the cascade above reaches.
 *
 * Returns whether a row went, so a caller can tell a real delete from a repeat
 * of one that already happened rather than reporting success either way.
 */
export async function deletePodcastRow(podcastId: string): Promise<boolean> {
  const deleted = await getDb()
    .delete(podcasts)
    .where(eq(podcasts.id, podcastId))
    .returning({ id: podcasts.id });
  return deleted.length > 0;
}

/**
 * Delete one episode and move the parent show's derived counters, in ONE
 * transaction.
 *
 * The mirror of `insertEpisode`'s `recordOnShow`, and it is in a transaction for
 * the reason that option's own comment gives: `episode_count` and
 * `last_episode_at` are DERIVED facts about the episode set, so "this episode is
 * gone" and "the show has one fewer" are one fact. The Task 12 review found the
 * insert-side bump outside its transaction and drifting shows permanently; the
 * delete side would drift them the same way, downward.
 *
 * RECOMPUTED, not decremented. `last_episode_at` cannot be decremented at all —
 * deleting the newest episode has to find the next newest — and recomputing
 * `episode_count` from the rows makes this self-healing for any show whose
 * counter has already drifted, where `- 1` would preserve the drift for ever.
 * Both reads run inside the transaction, after the delete, so they see the row
 * set the caller is leaving behind and not the one it started with.
 */
export async function deleteEpisodeRow(episodeId: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const deleted = await tx
      .delete(episodes)
      .where(eq(episodes.id, episodeId))
      .returning({ podcastId: episodes.podcastId });

    const row = deleted[0];
    if (!row) return false;

    const [totals] = await tx
      .select({ total: count() })
      .from(episodes)
      .where(eq(episodes.podcastId, row.podcastId));

    const [newest] = await tx
      .select({ pubDate: episodes.pubDate })
      .from(episodes)
      .where(eq(episodes.podcastId, row.podcastId))
      .orderBy(descNullsLast(episodes.pubDate))
      .limit(1);

    await tx
      .update(podcasts)
      .set({ episodeCount: totals?.total ?? 0, lastEpisodeAt: newest?.pubDate ?? null })
      .where(eq(podcasts.id, row.podcastId));

    return true;
  });
}
