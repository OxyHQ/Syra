/**
 * `reseedPersons` — the clean re-derivation of `type:'person'` rows from
 * podcast and episode credits.
 *
 * Split out of `catalogEntityMigration.test.ts` in Task 12: every table this
 * script touches is Postgres now (`catalog_entities`, `podcast_persons`,
 * `episode_persons`), while its former file-mate `migrateArtistsToCatalogEntities`
 * is a Mongo-only collection rename.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { asc, count, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities } from '../db/schema/catalog';
import { episodePersons, episodes, podcastPersons, podcasts } from '../db/schema/podcasts';
import { reseedPersons } from './reseedPersons';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

/** Person names, sorted — `type` is stated, so an artist can never appear here. */
async function personNames(): Promise<string[]> {
  const rows = await getDb()
    .select({ name: catalogEntities.name })
    .from(catalogEntities)
    .where(eq(catalogEntities.type, 'person'))
    .orderBy(asc(catalogEntities.name));
  return rows.map((row) => row.name);
}

async function artistCount(): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(catalogEntities)
    .where(eq(catalogEntities.type, 'artist'));
  return row?.total ?? 0;
}

describe('reseedPersons', () => {
  it('drops name-only persons, keeps Oxy-linked, re-derives from credits', async () => {
    // Pre-existing persons: one name-only (should drop), one Oxy-linked (should keep).
    await getDb()
      .insert(catalogEntities)
      .values([
        { type: 'person', name: 'Stale RSS Person' },
        { type: 'person', name: 'Creator Oxy Person', linkedOxyUserId: 'oxy-keep' },
      ]);

    // Credits to re-derive from — child rows on a real show and a real episode,
    // because both credit tables carry a foreign key to their parent.
    const showId = uuidv7();
    await getDb()
      .insert(podcasts)
      .values({ id: showId, title: 'Show', source: 'rss', feedUrl: 'https://f/s.xml', status: 'active' });
    await getDb()
      .insert(podcastPersons)
      .values({ podcastId: showId, position: 0, name: 'Channel Host', role: 'host' });

    const episodeId = uuidv7();
    await getDb().insert(episodes).values({
      id: episodeId,
      podcastId: showId,
      podcastTitle: 'Show',
      title: 'Ep',
      guid: 'g1',
      pubDate: new Date(),
      source: 'rss',
      enclosureUrl: 'https://x/1.mp3',
      status: 'ready',
    });
    await getDb()
      .insert(episodePersons)
      .values({ episodeId, position: 0, name: 'Episode Guest', role: 'guest' });

    const stats = await reseedPersons();

    expect(stats.deleted).toBe(1); // only the name-only person dropped
    expect(stats.podcastCreditsReplayed).toBe(1);
    expect(stats.episodeCreditsReplayed).toBe(1);

    // Oxy-linked kept, channel + episode credits derived; stale one not duplicated.
    expect(await personNames()).toEqual(['Channel Host', 'Creator Oxy Person', 'Episode Guest']);
    // Every derived row is a person — the reseed never writes an artist.
    expect(await artistCount()).toBe(0);
  });

  it('never deletes an ARTIST that carries no Oxy link', async () => {
    /**
     * The fixture that separates the scoped delete from an unscoped one.
     *
     * `linked_oxy_user_id is null` is true of almost every artist in the
     * catalogue, and Mongoose's discriminator used to add `type: 'person'` for
     * free. Without an artist here the delete could lose the whole artist table
     * and every assertion in the case above would still pass.
     */
    await getDb()
      .insert(catalogEntities)
      .values([
        { type: 'artist', name: 'Unlinked Band', source: 'cc' },
        { type: 'person', name: 'Unlinked Person' },
      ]);

    const stats = await reseedPersons();

    expect(stats.deleted).toBe(1);
    expect(await artistCount()).toBe(1);
    expect(await personNames()).toEqual([]);
  });

  it('is idempotent — a second run re-derives the same rows', async () => {
    const showId = uuidv7();
    await getDb()
      .insert(podcasts)
      .values({ id: showId, title: 'Show', source: 'rss', feedUrl: 'https://f/s.xml' });
    await getDb()
      .insert(podcastPersons)
      .values({ podcastId: showId, position: 0, name: 'Channel Host', role: 'host' });

    await reseedPersons();
    const first = await personNames();
    await reseedPersons();

    /**
     * The detector that works at runtime is an idempotency test: a write that
     * never lands is redone on the next pass, whereas asserting the return value
     * reports success either way. A name-only person is deleted and re-derived
     * on every run by design, so what has to hold is the SET, not the row id.
     */
    expect(await personNames()).toEqual(first);
    expect(first).toEqual(['Channel Host']);
  });
});
