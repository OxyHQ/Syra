/**
 * Entity linking for Hosts & Guests (Podcasting 2.0 `<podcast:person>` + creator
 * additions). Resolves each inline credit to a GLOBAL `person` row in
 * `catalog_entities` and enriches Oxy-linked credits with the live Oxy identity
 * (avatar + displayName).
 *
 * Dedup is STRONG-key only: `linkedOxyUserId` or `href`, each carrying its own
 * unique constraint. Name-only credits are low-confidence — deduped by `nameKey`
 * ONLY among other name-only persons, never merged into or over a strong-key
 * person. Artist auto-link happens only on a strong signal (the same Oxy user
 * owns or claimed the artist), never a loose name.
 *
 * `nameKey` comes from the shared `normalizeNameKey` in `@syra/shared-types` —
 * the SAME function artists, credits and locker album grouping use. It has to be
 * the same one: `catalog_entities.name_key` is one column serving both types, so
 * two normalisations would put two key spaces in it and quietly break any
 * cross-type query written against it later. Under Mongoose a `pre('save')` hook
 * computed it; there is no such hook here, so every write below calls the
 * function explicitly.
 *
 * The Oxy identity fetch is an injected dependency (`makeOxyUsersFetcher(oxy)`
 * at the call site) so this module stays decoupled from the server and
 * unit-testable.
 *
 * ## `type = 'person'` is stated on every read, never inferred
 *
 * Mongoose's discriminator injected it into `PersonModel.find`/`findOne`/
 * `findOneAndUpdate`. One table with a `type` column does not, and an unscoped
 * read here would resolve a credit to an ARTIST row that happens to hold the
 * same strong key — which is how the wrong author landed on a moderation record
 * last task.
 *
 * The two unique constraints (`catalog_entities_linked_oxy_user_id_key`,
 * `catalog_entities_href_key`) are collection-wide rather than per-type, exactly
 * as the Mongo sparse-unique indexes they were ported from were. So a strong key
 * already held by an ARTIST row is not resolvable to a person, and
 * {@link findOrCreatePerson} answers `null` for it — the same outcome Mongo
 * reached by throwing `E11000` into the caller's per-credit `catch`.
 */

import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { EpisodePerson, ResolvedPerson, SearchPerson } from '@syra/shared-types';
import { normalizeNameKey } from '@syra/shared-types';
import { getAccountDisplayName } from '@oxyhq/core';
import type { OxyServices, User } from '@oxyhq/core';
import { getDb } from '../../db/postgres';
import { catalogEntities } from '../../db/schema/catalog';
import { logger } from '../../utils/logger';
import { describeErrorSafely } from '../../utils/error';

/** Minimal Oxy identity used to enrich a linked person. */
export interface OxyUserLite {
  id: string;
  avatar?: string;
  displayName: string;
  username?: string;
}

/** Batch-fetch of Oxy identities for linked persons (validates ids exist). */
export type GetOxyUsers = (ids: string[]) => Promise<OxyUserLite[]>;

/** Build the production Oxy fetcher from the shared client (call site supplies it). */
export function makeOxyUsersFetcher(oxy: Pick<OxyServices, 'getUsersByIds'>): GetOxyUsers {
  return async (ids: string[]) => {
    if (ids.length === 0) return [];
    const users: User[] = await oxy.getUsersByIds(ids);
    return users.map((user) => ({
      id: user.id,
      avatar: user.avatar ?? undefined,
      displayName: getAccountDisplayName(user),
      username: user.username,
    }));
  };
}

/**
 * The `catalog_entities` columns a resolved credit reads.
 *
 * A named projection rather than `select()`: this module never needs the ~60
 * artist-only columns on the shared table, and naming the six it does use means
 * a column renamed under it is a compile error rather than an `undefined`.
 */
const PERSON_COLUMNS = {
  id: catalogEntities.id,
  name: catalogEntities.name,
  img: catalogEntities.img,
  href: catalogEntities.href,
  linkedOxyUserId: catalogEntities.linkedOxyUserId,
  linkedArtistId: catalogEntities.linkedArtistId,
} as const;

/** A `person` row as this module reads it. */
type PersonRow = {
  id: string;
  name: string;
  img: string | null;
  href: string | null;
  linkedOxyUserId: string | null;
  linkedArtistId: string | null;
};

/** One `type = 'person'` row matching a condition, or undefined. */
async function findPerson(condition: ReturnType<typeof and>): Promise<PersonRow | undefined> {
  const [row] = await getDb()
    .select(PERSON_COLUMNS)
    .from(catalogEntities)
    .where(and(eq(catalogEntities.type, 'person'), condition))
    .limit(1);
  return row;
}

/**
 * Find or create the global person row for a credit, using strong keys only.
 *
 * Returns null when the credit cannot be resolved — a transient failure, or a
 * strong key already held by a non-person row (see this file's doc comment).
 * The caller isolates per credit.
 *
 * Each tier is read-then-insert-with-`onConflictDoNothing`-then-re-read rather
 * than a bare upsert. That is not defensive padding: `onConflictDoUpdate` would
 * target a constraint that is not type-scoped and could therefore UPDATE an
 * artist row, and a bare insert would race two concurrent imports crediting the
 * same host. The re-read after a no-op conflict is what turns that race into the
 * right answer instead of an exception.
 */
async function findOrCreatePerson(credit: EpisodePerson): Promise<PersonRow | null> {
  const nameKey = normalizeNameKey(credit.name);

  // Strong key 1 — Oxy user (canonical).
  if (credit.linkedOxyUserId) {
    const existing = await findPerson(eq(catalogEntities.linkedOxyUserId, credit.linkedOxyUserId));
    if (existing) return existing;

    await getDb()
      .insert(catalogEntities)
      .values({
        type: 'person',
        name: credit.name,
        nameKey,
        linkedOxyUserId: credit.linkedOxyUserId,
      })
      .onConflictDoNothing();

    return (
      (await findPerson(eq(catalogEntities.linkedOxyUserId, credit.linkedOxyUserId))) ?? null
    );
  }

  // Strong key 2 — podcast:person href (stable URL identity).
  if (credit.href) {
    const existing = await findPerson(eq(catalogEntities.href, credit.href));
    if (existing) {
      // The Mongo form carried `$set: { img }` alongside `$setOnInsert`, so a
      // credit's avatar refreshed on every import. Kept.
      if (credit.img && credit.img !== existing.img) {
        await getDb()
          .update(catalogEntities)
          .set({ img: credit.img })
          .where(eq(catalogEntities.id, existing.id));
        return { ...existing, img: credit.img };
      }
      return existing;
    }

    await getDb()
      .insert(catalogEntities)
      .values({
        type: 'person',
        name: credit.name,
        nameKey,
        href: credit.href,
        img: credit.img ?? null,
      })
      .onConflictDoNothing();

    return (await findPerson(eq(catalogEntities.href, credit.href))) ?? null;
  }

  /**
   * Low-confidence — name-only. Match ONLY other name-only persons, never a
   * strong-key person of the same name.
   *
   * `is null` on both strong keys is the port of Mongo's `{ $exists: false }`,
   * and the two are the same test here: a Postgres column is null or a value,
   * with no third "absent" state for a declared column to be in.
   */
  const existing = await findPerson(
    and(
      eq(catalogEntities.nameKey, nameKey),
      isNull(catalogEntities.linkedOxyUserId),
      isNull(catalogEntities.href)
    )
  );
  if (existing) {
    if (credit.img && !existing.img) {
      await getDb()
        .update(catalogEntities)
        .set({ img: credit.img })
        .where(eq(catalogEntities.id, existing.id));
      return { ...existing, img: credit.img };
    }
    return existing;
  }

  /**
   * No conflict clause, unlike the two strong-key tiers.
   *
   * `catalog_entities_artist_name_key_key` is partial on `type = 'artist'`, so a
   * name-only PERSON has no unique constraint to conflict with — two imports
   * racing on the same unknown name legitimately create two rows, exactly as
   * Mongo's `PersonModel.create` did. Deduping them would need a constraint the
   * schema deliberately does not have, because two different people really can
   * share a name.
   */
  const [created] = await getDb()
    .insert(catalogEntities)
    .values({ type: 'person', name: credit.name, nameKey, img: credit.img ?? null })
    .returning(PERSON_COLUMNS);

  return created ?? null;
}

/**
 * Link to a CLAIMED or owned artist whose name matches the person's exactly
 * (case-insensitively).
 *
 * A claimed/owned artist is an owner-verified identity, so an exact-name match
 * is an acceptable signal. Never links to an unclaimed artist, nor by a loose or
 * partial name.
 */
async function ensureArtistLink(person: PersonRow): Promise<void> {
  if (person.linkedArtistId) return;

  const [artist] = await getDb()
    .select({ id: catalogEntities.id })
    .from(catalogEntities)
    .where(
      and(
        eq(catalogEntities.type, 'artist'),
        sql`lower(${catalogEntities.name}) = lower(${person.name})`,
        or(
          isNotNull(catalogEntities.ownerOxyUserId),
          isNotNull(catalogEntities.claimedByOxyUserId)
        )
      )
    )
    .limit(1);

  if (!artist) return;

  await getDb()
    .update(catalogEntities)
    .set({ linkedArtistId: artist.id })
    .where(eq(catalogEntities.id, person.id));
  person.linkedArtistId = artist.id;
}

/**
 * Resolve and persist links for a show's or episode's inline person credits,
 * returning the enriched DTOs the frontend renders.
 */
export async function resolvePersons(
  credits: readonly EpisodePerson[] | undefined,
  getOxyUsers: GetOxyUsers
): Promise<ResolvedPerson[]> {
  if (!credits || credits.length === 0) return [];

  const resolved: Array<{ credit: EpisodePerson; row: PersonRow }> = [];
  for (const credit of credits) {
    try {
      const row = await findOrCreatePerson(credit);
      if (!row) continue;
      await ensureArtistLink(row);
      resolved.push({ credit, row });
    } catch (err) {
      logger.debug('[podcasts] person resolution failed', { name: credit.name, err: describeErrorSafely(err) });
    }
  }

  // Enrich Oxy-linked persons with their live avatar + displayName (one batch).
  const oxyIds = Array.from(
    new Set(resolved.map(({ row }) => row.linkedOxyUserId).filter((id): id is string => !!id))
  );
  const oxyById = new Map<string, OxyUserLite>();
  if (oxyIds.length > 0) {
    try {
      for (const user of await getOxyUsers(oxyIds)) oxyById.set(user.id, user);
    } catch (err) {
      logger.debug('[podcasts] oxy person enrichment failed', { err: describeErrorSafely(err) });
    }
  }

  return resolved.map(({ credit, row }) => {
    const oxy = row.linkedOxyUserId ? oxyById.get(row.linkedOxyUserId) : undefined;
    return {
      personId: row.id,
      name: oxy?.displayName ?? row.name,
      role: credit.role,
      group: credit.group,
      href: credit.href ?? row.href ?? undefined,
      // External avatar only for RSS persons; Oxy-linked render via oxyAvatar.
      img: row.linkedOxyUserId ? undefined : (credit.img ?? row.img ?? undefined),
      linkedOxyUserId: row.linkedOxyUserId ?? undefined,
      linkedArtistId: row.linkedArtistId ?? undefined,
      oxyAvatar: oxy?.avatar,
      displayName: oxy?.displayName,
      username: oxy?.username,
    };
  });
}

export interface CreatorPersonsResult {
  /** Inline person credits to store on the show/episode (Oxy-linked). */
  persons: EpisodePerson[];
  /** Requested ids that are NOT real Oxy users → caller must reject. */
  invalidIds: string[];
}

/**
 * Build creator-added host/guest credits from Oxy user ids ONLY. Validates every
 * id against Oxy and reports any that don't resolve to a real user. A user
 * listed as both host and guest is credited as host.
 */
export async function buildCreatorPersons(
  input: { hosts?: string[]; guests?: string[] },
  getOxyUsers: GetOxyUsers
): Promise<CreatorPersonsResult> {
  const roleById = new Map<string, 'host' | 'guest'>();
  for (const id of input.guests ?? []) if (id) roleById.set(id, 'guest');
  for (const id of input.hosts ?? []) if (id) roleById.set(id, 'host'); // host wins

  const ids = Array.from(roleById.keys());
  if (ids.length === 0) return { persons: [], invalidIds: [] };

  const users = await getOxyUsers(ids);
  const userById = new Map(users.map((user) => [user.id, user]));

  const invalidIds = ids.filter((id) => !userById.has(id));
  if (invalidIds.length > 0) return { persons: [], invalidIds };

  const persons: EpisodePerson[] = ids.map((id) => {
    const user = userById.get(id);
    return {
      // Denormalised name as a fallback; the live displayName is resolved on read.
      name: user?.displayName ?? id,
      role: roleById.get(id),
      linkedOxyUserId: id,
    };
  });

  return { persons, invalidIds: [] };
}

/**
 * The shape {@link enrichPersons} needs, and that
 * `db/podcasts/persons.ts`'s `CreditIdentity` is satisfied by.
 *
 * The `mongoose.Types.ObjectId` arm on `_id`/`linkedArtistId` is GONE, and with
 * it the `_id` spelling: both existed only so a Mongoose document and a drizzle
 * row could reach these functions during the split, and the split is over —
 * `search.controller`'s people query and the podcast reads are both on drizzle
 * now, so there is exactly one caller shape. Renaming `_id` to `id` rather than
 * just narrowing its type is deliberate: leaving a Mongo-named field on a type
 * nothing Mongo-shaped can reach any more is the sort of residue that gets
 * copied forward.
 */
export interface PersonLike {
  id: string;
  name: string;
  img?: string;
  href?: string;
  linkedOxyUserId?: string;
  linkedArtistId?: string;
}

/**
 * Enrich global person rows into `SearchPerson` DTOs — adds the live Oxy
 * identity (avatar id + displayName + username) for Oxy-linked persons; RSS
 * persons keep their external `img`. Used by People search + person detail.
 */
export async function enrichPersons(
  persons: PersonLike[],
  getOxyUsers: GetOxyUsers
): Promise<SearchPerson[]> {
  const oxyIds = Array.from(
    new Set(persons.map((person) => person.linkedOxyUserId).filter((id): id is string => !!id))
  );
  const oxyById = new Map<string, OxyUserLite>();
  if (oxyIds.length > 0) {
    try {
      for (const user of await getOxyUsers(oxyIds)) oxyById.set(user.id, user);
    } catch (err) {
      logger.debug('[podcasts] people enrichment failed', { err: describeErrorSafely(err) });
    }
  }

  return persons.map((person) => {
    const oxy = person.linkedOxyUserId ? oxyById.get(person.linkedOxyUserId) : undefined;
    return {
      personId: person.id,
      name: oxy?.displayName ?? person.name,
      displayName: oxy?.displayName,
      username: oxy?.username,
      oxyAvatar: oxy?.avatar,
      img: person.linkedOxyUserId ? undefined : person.img,
      linkedOxyUserId: person.linkedOxyUserId,
      linkedArtistId: person.linkedArtistId,
    };
  });
}
