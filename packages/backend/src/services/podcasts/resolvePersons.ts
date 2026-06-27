/**
 * Entity linking for Hosts & Guests (Podcasting 2.0 `<podcast:person>` + creator
 * additions). Resolves each inline credit to a GLOBAL `Person` row and enriches
 * Oxy-linked credits with the live Oxy identity (avatar + displayName).
 *
 * Dedup is STRONG-key only (see `Person` model): `linkedOxyUserId` or `href`.
 * Name-only credits are low-confidence — deduped by exact name ONLY among other
 * name-only persons, never merged into/over a strong-key person. Artist auto-link
 * happens only on a strong signal (same Oxy user owns/claimed the Artist), never
 * a loose name.
 *
 * The Oxy identity fetch is an injected dependency (`makeOxyUsersFetcher(oxy)` at
 * the call site) so this module stays decoupled from the server + unit-testable.
 */

import type { EpisodePerson, ResolvedPerson } from '@syra/shared-types';
import { getAccountDisplayName } from '@oxyhq/core';
import type { OxyServices, User } from '@oxyhq/core';
import { PersonModel, IPerson } from '../../models/Person';
import { ArtistModel } from '../../models/Artist';
import { logger } from '../../utils/logger';

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

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Find or create the global `Person` for a credit using strong keys only.
 * Returns null only on a transient error (caller isolates per-credit).
 */
async function findOrCreatePerson(credit: EpisodePerson): Promise<IPerson | null> {
  // Strong key 1 — Oxy user (canonical).
  if (credit.linkedOxyUserId) {
    return PersonModel.findOneAndUpdate(
      { linkedOxyUserId: credit.linkedOxyUserId },
      {
        $setOnInsert: { name: credit.name, nameKey: nameKey(credit.name), linkedOxyUserId: credit.linkedOxyUserId },
      },
      { upsert: true, new: true },
    );
  }

  // Strong key 2 — podcast:person href (stable URL identity).
  if (credit.href) {
    return PersonModel.findOneAndUpdate(
      { href: credit.href },
      {
        $setOnInsert: { name: credit.name, nameKey: nameKey(credit.name), href: credit.href },
        ...(credit.img ? { $set: { img: credit.img } } : {}),
      },
      { upsert: true, new: true },
    );
  }

  // Low-confidence — name-only. Match ONLY other name-only persons; never a
  // strong-key person of the same name.
  const existing = await PersonModel.findOne({
    nameKey: nameKey(credit.name),
    linkedOxyUserId: { $exists: false },
    href: { $exists: false },
  });
  if (existing) {
    if (credit.img && !existing.img) {
      existing.img = credit.img;
      await existing.save();
    }
    return existing;
  }
  return PersonModel.create({ name: credit.name, nameKey: nameKey(credit.name), img: credit.img });
}

/**
 * Link to a CLAIMED/owned Artist whose name EXACTLY (case-insensitively) matches
 * the person's. A claimed/owned Artist is an owner-verified identity, so an
 * exact-name match is an acceptable signal. Never links to an unclaimed Artist
 * nor by a loose/partial name.
 */
async function ensureArtistLink(person: IPerson): Promise<void> {
  if (person.linkedArtistId) return;
  const exactName = new RegExp(`^${person.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const artist = await ArtistModel.findOne({
    name: exactName,
    $or: [{ ownerOxyUserId: { $exists: true, $ne: null } }, { claimedByOxyUserId: { $exists: true, $ne: null } }],
  }).select('_id').lean();
  if (artist) {
    person.linkedArtistId = artist._id;
    await person.save();
  }
}

/**
 * Resolve and persist links for a show's or episode's inline person credits,
 * returning the enriched DTOs the frontend renders.
 */
export async function resolvePersons(
  credits: EpisodePerson[] | undefined,
  getOxyUsers: GetOxyUsers,
): Promise<ResolvedPerson[]> {
  if (!credits || credits.length === 0) return [];

  const resolved: Array<{ credit: EpisodePerson; doc: IPerson }> = [];
  for (const credit of credits) {
    try {
      const doc = await findOrCreatePerson(credit);
      if (!doc) continue;
      await ensureArtistLink(doc);
      resolved.push({ credit, doc });
    } catch (err) {
      logger.debug('[podcasts] person resolution failed', { name: credit.name, err });
    }
  }

  // Enrich Oxy-linked persons with their live avatar + displayName (one batch).
  const oxyIds = Array.from(
    new Set(resolved.map(({ doc }) => doc.linkedOxyUserId).filter((id): id is string => !!id)),
  );
  const oxyById = new Map<string, OxyUserLite>();
  if (oxyIds.length > 0) {
    try {
      for (const user of await getOxyUsers(oxyIds)) oxyById.set(user.id, user);
    } catch (err) {
      logger.debug('[podcasts] oxy person enrichment failed', { err });
    }
  }

  return resolved.map(({ credit, doc }) => {
    const oxy = doc.linkedOxyUserId ? oxyById.get(doc.linkedOxyUserId) : undefined;
    return {
      personId: doc._id.toString(),
      name: oxy?.displayName ?? doc.name,
      role: credit.role,
      group: credit.group,
      href: credit.href ?? doc.href,
      // External avatar only for RSS persons; Oxy-linked render via oxyAvatar.
      img: doc.linkedOxyUserId ? undefined : (credit.img ?? doc.img),
      linkedOxyUserId: doc.linkedOxyUserId,
      linkedArtistId: doc.linkedArtistId ? doc.linkedArtistId.toString() : undefined,
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
 * id against Oxy and reports any that don't resolve to a real user. A user listed
 * as both host and guest is credited as host.
 */
export async function buildCreatorPersons(
  input: { hosts?: string[]; guests?: string[] },
  getOxyUsers: GetOxyUsers,
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
