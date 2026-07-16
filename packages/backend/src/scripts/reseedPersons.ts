/**
 * One-shot: reseed `type:'person'` catalog entities CLEAN from podcast/episode
 * credits (no migration of the old standalone `persons` collection).
 *
 *  - DROP every name-only / RSS person (`linkedOxyUserId` unset). Creator-added,
 *    Oxy-linked persons are KEPT (they carry the canonical Oxy link).
 *  - RE-DERIVE persons by replaying every `Podcast.persons[]` + `Episode.persons[]`
 *    credit through the resolver (`resolvePersons` → `findOrCreatePerson`), which
 *    upserts by STRONG key (linkedOxyUserId → href; name-only never merges across
 *    a strong-key entity or into a type:'artist' row).
 *
 * Steady state self-heals (refresh/import already call the resolver); this just
 * accelerates the first fill. Run AFTER `migrateArtistsToCatalogEntities`:
 * `bun run src/scripts/reseedPersons.ts` with the production MONGODB_URI.
 *
 * Keyset pagination by `_id` avoids a long-lived cursor timing out (CursorNotFound)
 * during the slow per-credit upsert work.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import type { EpisodePerson } from '@syra/shared-types';
import { connectToDatabase } from '../utils/database';
import { logger } from '../utils/logger';
import { PersonModel } from '../models/CatalogEntity';
import { PodcastModel } from '../models/Podcast';
import { EpisodeModel } from '../models/Episode';
import { resolvePersons, type GetOxyUsers } from '../services/podcasts/resolvePersons';

const BATCH_SIZE = 200;

// Re-derivation only needs the resolver's upsert side effect, not Oxy enrichment.
const noOxyUsers: GetOxyUsers = async () => [];

export interface ReseedPersonsStats {
  deleted: number;
  podcastsScanned: number;
  episodesScanned: number;
  creditsReplayed: number;
}

/** Replay every `persons[]` credit on a model's docs, keyset-paginated by `_id`. */
async function replayCredits<TDoc>(
  model: mongoose.Model<TDoc>,
): Promise<{ scanned: number; credits: number }> {
  let lastId: mongoose.Types.ObjectId | undefined;
  let scanned = 0;
  let credits = 0;

  for (;;) {
    const query: mongoose.QueryFilter<TDoc> = {
      'persons.0': { $exists: true },
      ...(lastId ? { _id: { $gt: lastId } } : {}),
    };

    const batch = await model
      .find(query, { persons: 1 })
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean<Array<{ _id: mongoose.Types.ObjectId; persons?: EpisodePerson[] }>>();

    if (batch.length === 0) break;

    for (const doc of batch) {
      if (doc.persons?.length) {
        await resolvePersons(doc.persons, noOxyUsers);
        credits += doc.persons.length;
      }
      scanned += 1;
    }
    lastId = batch[batch.length - 1]?._id;
  }

  return { scanned, credits };
}

export async function reseedPersons(): Promise<ReseedPersonsStats> {
  // Drop name-only / RSS persons; keep creator-added Oxy-linked ones.
  const del = await PersonModel.deleteMany({ linkedOxyUserId: null });

  const podcasts = await replayCredits(PodcastModel);
  const episodes = await replayCredits(EpisodeModel);

  return {
    deleted: del.deletedCount ?? 0,
    podcastsScanned: podcasts.scanned,
    episodesScanned: episodes.scanned,
    creditsReplayed: podcasts.credits + episodes.credits,
  };
}

async function main(): Promise<void> {
  await connectToDatabase();
  logger.info('[reseed-persons] starting clean person reseed');
  const stats = await reseedPersons();
  logger.info('[reseed-persons] complete', { ...stats });
}

if (require.main === module) {
  main()
    .then(() => mongoose.connection.close())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[reseed-persons] fatal error', { err });
      mongoose.connection.close().finally(() => process.exit(1));
    });
}
