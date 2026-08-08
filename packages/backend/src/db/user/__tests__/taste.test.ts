/**
 * `db/user/taste.ts` — the delta arithmetic, the caps, and the decay pass.
 *
 * The three behaviours worth pinning are the ones that were IN MEMORY before and
 * are now statements: a delta that must not create a bucket, a cap enforced by a
 * bounded delete instead of `list.length = max`, and a decay pass that is five
 * set-wise statements instead of a cursor.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { catalogEntities } from '../../schema/catalog';
import { userTasteProfiles } from '../../schema/user';
import {
  MAX_TASTE_ARTISTS,
  MAX_TASTE_GENRES,
  applyTasteSignal,
  decayDueTasteProfiles,
  findTasteWeights,
} from '../taste';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const USER = 'oxy-listener-1';

/** A real `catalog_entities` artist — `user_taste_artists.artist_id` is a foreign key. */
async function makeArtist(): Promise<string> {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: `Artist ${suffix}`,
      nameKey: `artist-${suffix}`,
      source: 'upload',
    })
    .returning({ id: catalogEntities.id });
  return artist.id;
}

function weightOf(weights: { key: string; weight: number }[], key: string): number | undefined {
  return weights.find((entry) => entry.key === key)?.weight;
}

describe('a delta lands on the right bucket', () => {
  it('creates the profile and both children on the first signal', async () => {
    const artistId = await makeArtist();

    await applyTasteSignal(USER, {
      genres: [{ key: 'house', delta: 2.5 }],
      artists: [{ key: artistId, delta: 2.5 }],
      totalSignalDelta: 2.5,
    });

    const taste = await findTasteWeights(USER);
    expect(weightOf(taste?.genres ?? [], 'house')).toBe(2.5);
    expect(weightOf(taste?.artists ?? [], artistId)).toBe(2.5);
  });

  it('adds to an existing bucket rather than replacing it', async () => {
    const artistId = await makeArtist();
    const signal = {
      genres: [{ key: 'house', delta: 2 }],
      artists: [{ key: artistId, delta: 2 }],
      totalSignalDelta: 2,
    };

    await applyTasteSignal(USER, signal);
    await applyTasteSignal(USER, signal);

    const taste = await findTasteWeights(USER);
    expect(weightOf(taste?.genres ?? [], 'house')).toBe(4);
    expect(weightOf(taste?.artists ?? [], artistId)).toBe(4);
  });

  /**
   * `applyWeight`'s rule, and the one place it differed from `bump`: a
   * non-positive delta may COOL an existing bucket but must never create one.
   * A zero-weight row is invisible to every reader (they all filter `weight >
   * 0`) yet still consumes one of the capped slots.
   */
  it('cools an existing bucket but never creates one from a negative delta', async () => {
    const known = await makeArtist();
    const unknown = await makeArtist();

    await applyTasteSignal(USER, {
      genres: [{ key: 'house', delta: 1 }],
      artists: [{ key: known, delta: 1 }],
      totalSignalDelta: 1,
    });

    await applyTasteSignal(USER, {
      genres: [
        { key: 'house', delta: -0.3 },
        { key: 'techno', delta: -0.3 },
      ],
      artists: [
        { key: known, delta: -0.3 },
        { key: unknown, delta: -0.3 },
      ],
      // A skip never reduces the maturity signal.
      totalSignalDelta: 0,
    });

    const taste = await findTasteWeights(USER);
    expect(weightOf(taste?.genres ?? [], 'house')).toBeCloseTo(0.7, 10);
    expect(weightOf(taste?.artists ?? [], known)).toBeCloseTo(0.7, 10);
    // The buckets that did not exist still do not.
    expect(weightOf(taste?.genres ?? [], 'techno')).toBeUndefined();
    expect(weightOf(taste?.artists ?? [], unknown)).toBeUndefined();
  });

  it('clamps a bucket at zero rather than going negative', async () => {
    const artistId = await makeArtist();

    await applyTasteSignal(USER, {
      genres: [{ key: 'house', delta: 0.1 }],
      artists: [{ key: artistId, delta: 0.1 }],
      totalSignalDelta: 0.1,
    });
    await applyTasteSignal(USER, {
      genres: [{ key: 'house', delta: -5 }],
      artists: [{ key: artistId, delta: -5 }],
      totalSignalDelta: 0,
    });

    const taste = await findTasteWeights(USER);
    expect(weightOf(taste?.genres ?? [], 'house')).toBe(0);
    expect(weightOf(taste?.artists ?? [], artistId)).toBe(0);
  });
});

describe('duplicate keys in one signal', () => {
  /**
   * NOT tidiness. Postgres rejects an `INSERT … ON CONFLICT DO UPDATE` whose
   * `VALUES` list names the same conflict key twice, with `21000: ON CONFLICT DO
   * UPDATE command cannot affect row a second time`.
   *
   * `applyFollowSignal` produces exactly that shape: it lowercases an artist's
   * genre list, so an artist tagged `['Rock', 'rock']` yields two `rock` deltas.
   * Without the merge this throws; with it the two SUM, which is also what the
   * Mongo version's loop did.
   */
  it('merges repeated keys instead of raising 21000', async () => {
    const artistId = await makeArtist();

    await applyTasteSignal(USER, {
      genres: [
        { key: 'rock', delta: 2 },
        { key: 'rock', delta: 2 },
      ],
      artists: [{ key: artistId, delta: 4 }],
      totalSignalDelta: 4,
    });

    const taste = await findTasteWeights(USER);
    expect(weightOf(taste?.genres ?? [], 'rock')).toBe(4);
  });

  it('merges to a net negative without creating the bucket', async () => {
    const artistId = await makeArtist();

    await applyTasteSignal(USER, {
      genres: [
        { key: 'rock', delta: 1 },
        { key: 'rock', delta: -3 },
      ],
      artists: [{ key: artistId, delta: 1 }],
      totalSignalDelta: 1,
    });

    const taste = await findTasteWeights(USER);
    expect(weightOf(taste?.genres ?? [], 'rock')).toBeUndefined();
  });
});

describe('the caps are enforced by a bounded delete', () => {
  it('keeps the strongest MAX_TASTE_GENRES and drops the tail', async () => {
    const artistId = await makeArtist();

    // One more than the cap, with the weight ASCENDING in insertion order, so
    // the survivor set cannot be produced by "keep the first N".
    await applyTasteSignal(USER, {
      genres: Array.from({ length: MAX_TASTE_GENRES + 5 }, (_, i) => ({
        key: `genre-${i}`,
        delta: i + 1,
      })),
      artists: [{ key: artistId, delta: 1 }],
      totalSignalDelta: 1,
    });

    const taste = await findTasteWeights(USER);
    expect(taste?.genres).toHaveLength(MAX_TASTE_GENRES);
    // The five weakest are the ones gone.
    expect(weightOf(taste?.genres ?? [], 'genre-0')).toBeUndefined();
    expect(weightOf(taste?.genres ?? [], 'genre-4')).toBeUndefined();
    expect(weightOf(taste?.genres ?? [], 'genre-5')).toBe(6);
    expect(weightOf(taste?.genres ?? [], `genre-${MAX_TASTE_GENRES + 4}`)).toBe(
      MAX_TASTE_GENRES + 5
    );
  });

  it('caps the artist side at MAX_TASTE_ARTISTS', async () => {
    const artistIds = await Promise.all(
      Array.from({ length: 5 }, () => makeArtist())
    );

    await applyTasteSignal(USER, {
      genres: [],
      artists: artistIds.map((id, i) => ({ key: id, delta: i + 1 })),
      totalSignalDelta: 1,
    });

    const taste = await findTasteWeights(USER);
    // Well under the cap, so nothing is trimmed — the negative control for the
    // assertion above, which would also pass if the trim deleted everything.
    expect(taste?.artists).toHaveLength(5);
    expect(MAX_TASTE_ARTISTS).toBeGreaterThan(5);
  });
});

describe('total_signal', () => {
  it('accumulates the clamped contribution and never falls', async () => {
    const artistId = await makeArtist();

    await applyTasteSignal(USER, {
      genres: [],
      artists: [{ key: artistId, delta: 1 }],
      totalSignalDelta: 2.5,
    });
    await applyTasteSignal(USER, {
      genres: [],
      artists: [{ key: artistId, delta: -1 }],
      totalSignalDelta: 0,
    });

    const [profile] = await getDb()
      .select({ totalSignal: userTasteProfiles.totalSignal })
      .from(userTasteProfiles)
      .where(eq(userTasteProfiles.oxyUserId, USER));

    expect(profile.totalSignal).toBe(2.5);
  });
});

describe('the decay pass', () => {
  /** Backdate a profile so the pass considers it due. */
  async function backdate(oxyUserId: string, days: number): Promise<void> {
    await getDb()
      .update(userTasteProfiles)
      .set({ lastDecayAt: sql`now() - make_interval(days => ${days})` })
      .where(eq(userTasteProfiles.oxyUserId, oxyUserId));
  }

  it('halves a weight over exactly one half-life', async () => {
    const artistId = await makeArtist();
    await applyTasteSignal(USER, {
      genres: [{ key: 'house', delta: 10 }],
      artists: [{ key: artistId, delta: 10 }],
      totalSignalDelta: 10,
    });
    await backdate(USER, 45);

    const result = await decayDueTasteProfiles();

    expect(result.profilesProcessed).toBe(1);
    const taste = await findTasteWeights(USER);
    expect(weightOf(taste?.genres ?? [], 'house')).toBeCloseTo(5, 2);
    expect(weightOf(taste?.artists ?? [], artistId)).toBeCloseTo(5, 2);
  });

  it('prunes what decays below the threshold', async () => {
    const artistId = await makeArtist();
    await applyTasteSignal(USER, {
      genres: [
        { key: 'strong', delta: 10 },
        { key: 'faint', delta: 0.06 },
      ],
      artists: [{ key: artistId, delta: 10 }],
      totalSignalDelta: 10,
    });
    await backdate(USER, 45);

    await decayDueTasteProfiles();

    const taste = await findTasteWeights(USER);
    // 0.06 halves to 0.03, below the 0.05 prune threshold.
    expect(weightOf(taste?.genres ?? [], 'faint')).toBeUndefined();
    expect(weightOf(taste?.genres ?? [], 'strong')).toBeCloseTo(5, 2);
  });

  /**
   * The elapsed-time floor. `0.5^(e/H) >= 0.999` was the Mongo skip; expressed
   * as `e > H · ln(0.999)/ln(0.5)` it is ~93 minutes, so a profile decayed a
   * minute ago must be left entirely alone — including its `last_decay_at`,
   * which a pass that "processed" it would move.
   */
  it('skips a profile too recently decayed for decay to matter', async () => {
    const artistId = await makeArtist();
    await applyTasteSignal(USER, {
      genres: [{ key: 'house', delta: 10 }],
      artists: [{ key: artistId, delta: 10 }],
      totalSignalDelta: 10,
    });

    const result = await decayDueTasteProfiles();

    expect(result.profilesProcessed).toBe(0);
    const taste = await findTasteWeights(USER);
    expect(weightOf(taste?.genres ?? [], 'house')).toBe(10);
  });

  /**
   * Time-proportional, which is what makes the pass independent of how often
   * the scheduler runs — the property the whole `last_decay_at` design exists
   * for. Two passes over one half-life must land where one pass over one
   * half-life lands, not a quarter of the way further down.
   */
  it('is idempotent — a second pass immediately after barely moves anything', async () => {
    const artistId = await makeArtist();
    await applyTasteSignal(USER, {
      genres: [{ key: 'house', delta: 10 }],
      artists: [{ key: artistId, delta: 10 }],
      totalSignalDelta: 10,
    });
    await backdate(USER, 45);

    await decayDueTasteProfiles();
    const afterFirst = weightOf((await findTasteWeights(USER))?.genres ?? [], 'house');

    const second = await decayDueTasteProfiles();
    const afterSecond = weightOf((await findTasteWeights(USER))?.genres ?? [], 'house');

    expect(second.profilesProcessed).toBe(0);
    expect(afterSecond).toBe(afterFirst);
  });

  it('recomputes total_signal as the sum of the surviving artist weights', async () => {
    const first = await makeArtist();
    const second = await makeArtist();
    await applyTasteSignal(USER, {
      genres: [{ key: 'house', delta: 100 }],
      artists: [
        { key: first, delta: 10 },
        { key: second, delta: 6 },
      ],
      totalSignalDelta: 100,
    });
    await backdate(USER, 45);

    await decayDueTasteProfiles();

    const [profile] = await getDb()
      .select({ totalSignal: userTasteProfiles.totalSignal })
      .from(userTasteProfiles)
      .where(eq(userTasteProfiles.oxyUserId, USER));

    // 10 + 6 halved = 8, and NOT the 100 the accumulator held — the decay pass
    // is the one writer whose `total_signal` is a real sum. Ported as-is from
    // the Mongo pass (`for (const a of profile.artists) total += a.weight`).
    expect(profile.totalSignal).toBeCloseTo(8, 2);
  });

  it('leaves a profile that is not due untouched while decaying one that is', async () => {
    const artistId = await makeArtist();
    for (const user of ['due-user', 'fresh-user']) {
      await applyTasteSignal(user, {
        genres: [{ key: 'house', delta: 10 }],
        artists: [{ key: artistId, delta: 10 }],
        totalSignalDelta: 10,
      });
    }
    await backdate('due-user', 45);

    const result = await decayDueTasteProfiles();

    expect(result.profilesProcessed).toBe(1);
    expect(weightOf((await findTasteWeights('due-user'))?.genres ?? [], 'house')).toBeCloseTo(5, 2);
    // The set-wise statements are scoped by the `due` predicate, so a
    // not-due profile's children must be exactly as they were.
    expect(weightOf((await findTasteWeights('fresh-user'))?.genres ?? [], 'house')).toBe(10);
  });
});

describe('reads', () => {
  it('answers undefined for a listener with no profile', async () => {
    expect(await findTasteWeights('nobody-at-all')).toBeUndefined();
  });

  it('returns both lists strongest first', async () => {
    const artistId = await makeArtist();
    await applyTasteSignal(USER, {
      genres: [
        { key: 'weak', delta: 1 },
        { key: 'strong', delta: 9 },
        { key: 'middling', delta: 5 },
      ],
      artists: [{ key: artistId, delta: 1 }],
      totalSignalDelta: 1,
    });

    const taste = await findTasteWeights(USER);
    expect(taste?.genres.map((entry) => entry.key)).toEqual(['strong', 'middling', 'weak']);
  });
});
