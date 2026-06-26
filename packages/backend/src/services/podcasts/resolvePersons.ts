/**
 * Entity linking for Podcasting 2.0 `<podcast:person>` credits (Phase 7).
 *
 * Episodes keep their inline `persons[]`; this resolves each credited name to a
 * lightweight `Person` row and links it to a Syra `Artist` when the name matches
 * a claimed/owned artist. Best-effort and idempotent — failures degrade to the
 * raw inline person.
 */

import type { EpisodePerson } from '@syra/shared-types';
import { PersonModel } from '../../models/Person';
import { ArtistModel } from '../../models/Artist';
import { logger } from '../../utils/logger';

export interface ResolvedPerson extends EpisodePerson {
  personId: string;
  linkedOxyUserId?: string;
  linkedArtistId?: string;
}

/**
 * Resolve and persist links for an episode's persons. Upserts a `Person` per
 * distinct name and, when that person is not yet linked, attaches a matching
 * owned/claimed `Artist` (by case-insensitive name).
 */
export async function resolveEpisodePersons(persons: EpisodePerson[] | undefined): Promise<ResolvedPerson[]> {
  if (!persons || persons.length === 0) return [];

  const resolved: ResolvedPerson[] = [];

  for (const person of persons) {
    try {
      const personDoc = await PersonModel.findOneAndUpdate(
        { name: person.name },
        { $setOnInsert: { name: person.name }, $set: { img: person.img, href: person.href } },
        { upsert: true, new: true },
      );
      if (!personDoc) continue;

      // Link to a claimed/owned artist when not already linked.
      if (!personDoc.linkedArtistId && !personDoc.linkedOxyUserId) {
        const artist = await ArtistModel.findOne({
          name: new RegExp(`^${person.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
          $or: [{ ownerOxyUserId: { $exists: true, $ne: null } }, { claimedByOxyUserId: { $exists: true, $ne: null } }],
        }).select('_id ownerOxyUserId claimedByOxyUserId').lean();

        if (artist) {
          personDoc.linkedArtistId = artist._id;
          personDoc.linkedOxyUserId = artist.ownerOxyUserId ?? artist.claimedByOxyUserId ?? undefined;
          await personDoc.save();
        }
      }

      resolved.push({
        ...person,
        personId: personDoc._id.toString(),
        linkedOxyUserId: personDoc.linkedOxyUserId,
        linkedArtistId: personDoc.linkedArtistId ? personDoc.linkedArtistId.toString() : undefined,
      });
    } catch (err) {
      logger.debug('[podcasts] person resolution failed', { name: person.name, err });
      resolved.push({ ...person, personId: '' });
    }
  }

  return resolved;
}
