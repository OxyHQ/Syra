/**
 * One-shot: reseed `type:'person'` catalog entities CLEAN from podcast/episode
 * credits.
 *
 *  - DROP every name-only / RSS person (`linked_oxy_user_id` null). Creator-added,
 *    Oxy-linked persons are KEPT (they carry the canonical Oxy link).
 *  - RE-DERIVE persons by replaying every `podcast_persons` + `episode_persons`
 *    credit through the resolver (`resolvePersons` → `findOrCreatePerson`), which
 *    upserts by STRONG key (linkedOxyUserId → href; name-only never merges across
 *    a strong-key entity or into a `type:'artist'` row).
 *
 * Steady state self-heals (refresh/import already call the resolver); this just
 * accelerates the first fill. `bun run src/scripts/reseedPersons.ts` against the
 * target `DATABASE_URL`.
 *
 * Keyset pagination by `id` rather than `OFFSET`: the per-credit resolver work is
 * slow, and an offset scan re-reads everything it has already skipped on each
 * page. `generatedId()` mints uuid v7, which is k-sortable, so `id > $last` is
 * both a stable cursor and an index-ordered one.
 *
 * ## Why this script moved in Task 12 rather than in Task 10
 *
 * `db/catalog/hybridServices.ts` registered it against Task 10, alongside five
 * other operational scripts that read catalog collections whose tables had
 * moved. It is ported here because it is the only one of the six whose OTHER
 * half was this vertical: it replayed `Podcast.persons[]`/`Episode.persons[]`,
 * and those became `podcast_persons`/`episode_persons`. Deleting the Mongoose
 * models left it unable to compile at all, so "leave it for its owner" was not
 * an available option.
 *
 * That ownership was also STALE — Task 10 had closed, so the entry named a task
 * that could not act on it. Its registry entry is cleared with this port; the
 * other five are untouched and still name the closed task, which is recorded in
 * this task's report rather than fixed here, because reassigning work is not a
 * decision a port gets to make on its own.
 */
import dotenv from 'dotenv';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { EpisodePerson } from '@syra/shared-types';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { catalogEntities } from '../db/schema/catalog';
import { episodePersons, podcastPersons } from '../db/schema/podcasts';
import { logger } from '../utils/logger';
import { resolvePersons, type GetOxyUsers } from '../services/podcasts/resolvePersons';

const BATCH_SIZE = 200;

// Re-derivation only needs the resolver's upsert side effect, not Oxy enrichment.
const noOxyUsers: GetOxyUsers = async () => [];

export interface ReseedPersonsStats {
  deleted: number;
  podcastCreditsReplayed: number;
  episodeCreditsReplayed: number;
}

/**
 * A credit row as the resolver needs it — the same six columns on both tables.
 *
 * `null` to `undefined` on every optional field, because `EpisodePerson`
 * declares them `.optional()` and the resolver tests them with `if (credit.href)`
 * either way; the conversion is here so nothing downstream has to know which
 * side of the port it came from.
 */
function toCredit(row: {
  name: string;
  role: string | null;
  group: string | null;
  img: string | null;
  href: string | null;
  linkedOxyUserId: string | null;
}): EpisodePerson {
  return {
    name: row.name,
    role: row.role ?? undefined,
    group: row.group ?? undefined,
    img: row.img ?? undefined,
    href: row.href ?? undefined,
    linkedOxyUserId: row.linkedOxyUserId ?? undefined,
  };
}

/** Replay every credit on `podcast_persons`, keyset-paginated by `id`. */
async function replayPodcastCredits(): Promise<number> {
  let lastId: string | undefined;
  let replayed = 0;

  for (;;) {
    const batch = await getDb()
      .select()
      .from(podcastPersons)
      .where(lastId === undefined ? undefined : gt(podcastPersons.id, lastId))
      .orderBy(asc(podcastPersons.id))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    await resolvePersons(batch.map(toCredit), noOxyUsers);
    replayed += batch.length;
    lastId = batch[batch.length - 1]?.id;
  }

  return replayed;
}

/** Replay every credit on `episode_persons`, keyset-paginated by `id`. */
async function replayEpisodeCredits(): Promise<number> {
  let lastId: string | undefined;
  let replayed = 0;

  for (;;) {
    const batch = await getDb()
      .select()
      .from(episodePersons)
      .where(lastId === undefined ? undefined : gt(episodePersons.id, lastId))
      .orderBy(asc(episodePersons.id))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    await resolvePersons(batch.map(toCredit), noOxyUsers);
    replayed += batch.length;
    lastId = batch[batch.length - 1]?.id;
  }

  return replayed;
}

export async function reseedPersons(): Promise<ReseedPersonsStats> {
  /**
   * Drop name-only / RSS persons; keep creator-added Oxy-linked ones.
   *
   * `type = 'person'` is STATED. Mongoose's discriminator injected it into
   * `PersonModel.deleteMany`; one table with a `type` column does not, and this
   * predicate without it — `linked_oxy_user_id is null` — matches almost every
   * ARTIST in the catalogue.
   */
  const deleted = await getDb()
    .delete(catalogEntities)
    .where(and(eq(catalogEntities.type, 'person'), isNull(catalogEntities.linkedOxyUserId)))
    .returning({ id: catalogEntities.id });

  const podcastCreditsReplayed = await replayPodcastCredits();
  const episodeCreditsReplayed = await replayEpisodeCredits();

  return { deleted: deleted.length, podcastCreditsReplayed, episodeCreditsReplayed };
}

async function main(): Promise<void> {
  dotenv.config();
  await connectPostgres();
  logger.info('[reseed-persons] starting clean person reseed');
  const stats = await reseedPersons();
  logger.info('[reseed-persons] complete', { ...stats });
}

if (require.main === module) {
  main()
    .then(() => closePostgres())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[reseed-persons] fatal error', { err });
      closePostgres().finally(() => process.exit(1));
    });
}
