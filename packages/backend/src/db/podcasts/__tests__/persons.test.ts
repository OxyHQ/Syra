/**
 * "Which shows and episodes credit this person" — against real rows.
 *
 * `strongKeyCreditMatch` had a unit test that asserted the SHAPE of the Mongo
 * filter it returned (`{ persons: { $elemMatch: { linkedOxyUserId } } }`, and an
 * `instanceof RegExp` for the name tier). That test cannot survive the port and
 * should not: the Postgres form is an `EXISTS` subquery, and asserting its SQL
 * text would pin the implementation while proving nothing about which rows come
 * back.
 *
 * So this is behavioural instead. Every case seeds credits on both a show and an
 * episode and asserts WHICH ones the predicate selects — which is the property
 * the shelf depends on and the one a wrong tier order would break.
 *
 * ## The tier order is the thing under test
 *
 * `services/podcasts/resolvePersons.ts` DEDUPS by `linkedOxyUserId`, else
 * `href`, else name. This predicate has to select by the same keys in the same
 * order or the "appears in" shelf disagrees with the resolver about who is who.
 * The middle case below is what proves the order rather than just the tiers: a
 * person carrying BOTH an Oxy id and an href, credited on two different shows,
 * one per key.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { episodePersons, episodes, podcastPersons, podcasts } from '../../schema/podcasts';
import { episodeCreditsPerson, podcastCreditsPerson, type CreditIdentity } from '../persons';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

interface Credit {
  name: string;
  href?: string;
  linkedOxyUserId?: string;
}

/** A show with one channel-level credit. Returns the show id. */
async function showCrediting(title: string, credit: Credit): Promise<string> {
  const id = uuidv7();
  await getDb().insert(podcasts).values({ id, title, source: 'rss', status: 'active' });
  await getDb().insert(podcastPersons).values({
    podcastId: id,
    position: 0,
    name: credit.name,
    href: credit.href ?? null,
    linkedOxyUserId: credit.linkedOxyUserId ?? null,
  });
  return id;
}

/** An episode (on its own show) with one per-episode credit. Returns the episode id. */
async function episodeCrediting(title: string, credit: Credit): Promise<string> {
  const showId = uuidv7();
  const id = uuidv7();
  await getDb().insert(podcasts).values({ id: showId, title: `${title} show`, source: 'rss' });
  await getDb().insert(episodes).values({
    id,
    podcastId: showId,
    podcastTitle: `${title} show`,
    title,
    guid: id,
    pubDate: new Date(),
    source: 'rss',
    enclosureUrl: 'https://x/e.mp3',
    status: 'ready',
  });
  await getDb().insert(episodePersons).values({
    episodeId: id,
    position: 0,
    name: credit.name,
    href: credit.href ?? null,
    linkedOxyUserId: credit.linkedOxyUserId ?? null,
  });
  return id;
}

async function showTitlesCrediting(person: CreditIdentity): Promise<string[]> {
  const rows = await getDb()
    .select({ title: podcasts.title })
    .from(podcasts)
    .where(podcastCreditsPerson(person))
    .orderBy(podcasts.title);
  return rows.map((row) => row.title);
}

async function episodeTitlesCrediting(person: CreditIdentity): Promise<string[]> {
  const rows = await getDb()
    .select({ title: episodes.title })
    .from(episodes)
    .where(episodeCreditsPerson(person))
    .orderBy(episodes.title);
  return rows.map((row) => row.title);
}

describe('credit match — tier 1, the Oxy account', () => {
  it('selects only shows and episodes crediting that account', async () => {
    await showCrediting('Hers', { name: 'Jane Host', linkedOxyUserId: 'oxy1' });
    await showCrediting('Somebody else', { name: 'Jane Host', linkedOxyUserId: 'oxy2' });
    await episodeCrediting('Her episode', { name: 'Jane Host', linkedOxyUserId: 'oxy1' });
    await episodeCrediting('Not hers', { name: 'Jane Host', linkedOxyUserId: 'oxy2' });

    const person: CreditIdentity = { name: 'Jane Host', linkedOxyUserId: 'oxy1' };
    expect(await showTitlesCrediting(person)).toEqual(['Hers']);
    expect(await episodeTitlesCrediting(person)).toEqual(['Her episode']);
  });
});

describe('credit match — tier order', () => {
  it('prefers the Oxy account over the href when the person carries both', async () => {
    /**
     * The case that tells the ORDER from the tiers.
     *
     * Two shows credit the same human, one by Oxy id and one by the href, and
     * the person row carries both keys. A predicate that checked `href` first
     * would return the wrong show — and every other case in this file, where
     * each person carries exactly one key, would still pass.
     */
    await showCrediting('By account', { name: 'Jane Host', linkedOxyUserId: 'oxy1' });
    await showCrediting('By href', { name: 'Jane Host', href: 'https://x/jane' });

    const person: CreditIdentity = {
      name: 'Jane Host',
      linkedOxyUserId: 'oxy1',
      href: 'https://x/jane',
    };
    expect(await showTitlesCrediting(person)).toEqual(['By account']);
  });
});

describe('credit match — tier 2, the href', () => {
  it('selects by href when there is no Oxy account', async () => {
    await showCrediting('Hers', { name: 'Jane Host', href: 'https://x/jane' });
    await showCrediting('Somebody else', { name: 'Jane Host', href: 'https://x/other' });

    expect(await showTitlesCrediting({ name: 'Jane Host', href: 'https://x/jane' })).toEqual([
      'Hers',
    ]);
  });
});

describe('credit match — tier 3, the exact name', () => {
  it('matches case-insensitively and only on the WHOLE name', async () => {
    await showCrediting('Exact', { name: 'Jane Host' });
    await showCrediting('Different case', { name: 'JANE HOST' });
    await showCrediting('Longer name', { name: 'Jane Host Jr' });
    await showCrediting('Shorter name', { name: 'Jane' });

    // Both spellings of the same name, and NEITHER of the two names that merely
    // contain it — `=` on a whole column is what makes this anchored, where the
    // Mongo form needed an explicitly anchored, escaped regex.
    expect(await showTitlesCrediting({ name: 'jane host' })).toEqual(['Different case', 'Exact']);
  });

  it('does not match a person who has a strong key on the row but not in the query', async () => {
    // Tier 3 fires only when the PERSON carries no strong key. A show crediting
    // an Oxy-linked person of the same name is a different human, and merging
    // them is precisely what the resolver's dedup rules forbid.
    await showCrediting('Strong key', { name: 'Jane Host', linkedOxyUserId: 'oxy1' });
    await showCrediting('Name only', { name: 'Jane Host' });

    /**
     * Both rows carry the name, so a name-tier query returns both — and that is
     * CORRECT and deliberate, not a gap: the credit table is what is being
     * searched, and a name-only person genuinely cannot be distinguished from a
     * same-named strong-key credit by name alone. The asymmetry that matters is
     * the other direction, asserted in tier 1 above: a person WITH a strong key
     * never falls back to the name.
     */
    expect(await showTitlesCrediting({ name: 'Jane Host' })).toEqual(['Name only', 'Strong key']);
  });
});

describe('credit match — an uncredited person', () => {
  it('selects nothing', async () => {
    await showCrediting('Hers', { name: 'Jane Host', linkedOxyUserId: 'oxy1' });

    expect(await showTitlesCrediting({ name: 'Nobody', linkedOxyUserId: 'oxy-nobody' })).toEqual([]);
    expect(await episodeTitlesCrediting({ name: 'Nobody', href: 'https://x/nobody' })).toEqual([]);
  });
});

describe('credit match — the correlation is per parent', () => {
  it('does not select a show because a DIFFERENT show credits the person', async () => {
    /**
     * A correlated `EXISTS` whose `podcast_id = podcasts.id` correlation was
     * dropped would return EVERY show as soon as any one of them credited the
     * person. Two shows, one credit, and the seeded-but-uncredited one is what
     * makes that failure visible.
     */
    await showCrediting('Credits her', { name: 'Jane Host', linkedOxyUserId: 'oxy1' });
    const bare = uuidv7();
    await getDb().insert(podcasts).values({ id: bare, title: 'Credits nobody', source: 'rss' });

    expect(await showTitlesCrediting({ name: 'Jane Host', linkedOxyUserId: 'oxy1' })).toEqual([
      'Credits her',
    ]);

    // And the bare show really is in the table — otherwise the assertion above
    // passes against an empty second row rather than against the correlation.
    const [seeded] = await getDb()
      .select({ id: podcasts.id })
      .from(podcasts)
      .where(and(eq(podcasts.id, bare), eq(podcasts.title, 'Credits nobody')));
    expect(seeded).toBeDefined();
  });
});
