/**
 * `user_taste_profiles` and its two weight children, on drizzle.
 *
 * The learned model of one listener's taste: a recency-decayed engagement score
 * per genre and per artist, folded in on every play, like and follow, and
 * decayed globally by a maintenance pass so stale tastes fade.
 *
 * ## One array became two tables, and one in-memory invariant became a constraint
 *
 * `models/UserTasteProfile.ts` held `genres[]` and `artists[]`, both of the same
 * `TasteWeightSchema`. `schema/user.ts` splits them because the two do not hold
 * the same thing — `artists[].key` is a real `catalog_entities` id (and now a
 * real foreign key), `genres[].key` is a lowercase genre string that is not a
 * row id. That split is why `applyTasteSignal` takes genre deltas and artist
 * deltas as separate lists rather than one keyed by kind.
 *
 * "One row per key" was held in memory by `applyWeight`'s `list.find(...)` and
 * is now `unique(taste_profile_id, <key>)`, which is what lets a delta be an
 * `on conflict do update` instead of a read-modify-write.
 *
 * ## Two rules the callers used to spell out, now spelled out once
 *
 * `recordPlay.applyWeight` and `tasteSignals.bump` were near-duplicates that
 * differed in one case: `applyWeight` refused to CREATE a bucket for a
 * non-positive delta, `bump` created one clamped to zero. Every caller of `bump`
 * passes a positive constant (2.5 for a like, 4 for a follow, 4/n per genre of a
 * followed artist), so the two never disagreed in practice; this module keeps
 * the stricter rule, because a zero-weight row is invisible to every reader
 * (they all filter `weight > 0`) yet still consumes one of the capped slots.
 *
 * Both also trimmed to a cap by dropping the lowest weights, and both defined
 * their own copy of `MAX_TASTE_GENRES`/`MAX_TASTE_ARTISTS`. There is one copy
 * now, beside the statement that enforces it.
 *
 * ## The decay pass is set-wise, not a cursor
 *
 * `tasteDecay` walked every profile with a Mongo cursor and issued one
 * `profile.save()` each. The same pass is five statements here, independent of
 * how many profiles exist. What made the cursor's per-profile isolation
 * worthwhile was that one document could fail validation without aborting the
 * rest; a set-wise `UPDATE` has no per-row failure mode to isolate, and its
 * all-or-nothing transaction is the stronger guarantee.
 *
 * The pass stays idempotent and time-proportional for the reason it always was:
 * the factor is computed from each profile's OWN `last_decay_at`, so running it
 * twice in quick succession barely changes anything the second time, and a
 * missed tick costs nothing. `now()` is Postgres's transaction timestamp, so
 * every statement in the pass shares one instant — the same property the Mongo
 * version got by capturing `Date.now()` once.
 */

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb, type DbOrTransaction } from '../postgres';
import { userTasteArtists, userTasteGenres, userTasteProfiles } from '../schema/user';

/** Cap on how many genre/artist weights are retained per profile. */
export const MAX_TASTE_GENRES = 40;
export const MAX_TASTE_ARTISTS = 200;

/** Weights lose half their value over this period of no reinforcement. */
const HALF_LIFE_DAYS = 45;

/** Drop weights below this after decay to keep profiles compact. */
const PRUNE_THRESHOLD = 0.05;

/**
 * A profile is skipped when too little time has passed for decay to matter.
 *
 * The Mongo pass computed the factor and skipped when it was `>= 0.999`. That
 * is the same test as an elapsed-time floor — `0.5^(e/H) < 0.999` ⟺
 * `e > H · ln(0.999)/ln(0.5)` — and expressing it as a floor keeps the
 * predicate on a bare column, where an index could serve it, instead of on a
 * computed expression where none ever could.
 */
const MIN_DECAY_ELAPSED_SECONDS =
  HALF_LIFE_DAYS * 24 * 60 * 60 * (Math.log(0.999) / Math.log(0.5));

/** One learned affinity. `key` is a genre string or a `catalog_entities` id. */
export interface TasteWeight {
  key: string;
  weight: number;
}

/** A listener's learned affinities. */
export interface TasteWeights {
  genres: TasteWeight[];
  artists: TasteWeight[];
}

/** A single keyed delta to apply. */
export interface TasteDelta {
  key: string;
  delta: number;
}

// ── Read ──────────────────────────────────────────────────────────────────

/**
 * One listener's genre and artist weights, or `undefined` when they have no
 * profile.
 *
 * `total_signal` and `last_decay_at` are deliberately absent: no reader reads
 * either (only the decay pass writes them), so selecting them would widen the
 * row for nothing. Every consumer re-sorts by weight itself, so no order is
 * promised here beyond a deterministic one.
 *
 * Ordered `weight desc` — safe against `desc()`'s `NULLS FIRST` inversion only
 * because `weight` is `notNull()` on both children, so the null branch cannot
 * arise. The key is the tiebreak, so the same profile always reads back in the
 * same order.
 */
export async function findTasteWeights(
  oxyUserId: string,
  db: DbOrTransaction = getDb(),
): Promise<TasteWeights | undefined> {
  const [profile] = await db
    .select({ id: userTasteProfiles.id })
    .from(userTasteProfiles)
    .where(eq(userTasteProfiles.oxyUserId, oxyUserId))
    .limit(1);

  if (!profile) return undefined;

  const [genres, artists] = await Promise.all([
    db
      .select({ key: userTasteGenres.genre, weight: userTasteGenres.weight })
      .from(userTasteGenres)
      .where(eq(userTasteGenres.tasteProfileId, profile.id))
      .orderBy(sql`${userTasteGenres.weight} desc, ${userTasteGenres.genre} asc`),
    db
      .select({ key: userTasteArtists.artistId, weight: userTasteArtists.weight })
      .from(userTasteArtists)
      .where(eq(userTasteArtists.tasteProfileId, profile.id))
      .orderBy(sql`${userTasteArtists.weight} desc, ${userTasteArtists.artistId} asc`),
  ]);

  return { genres, artists };
}

// ── Write ─────────────────────────────────────────────────────────────────

/**
 * Fold a set of deltas into a listener's profile, creating it when absent.
 *
 * One transaction, because a delta that landed on `user_taste_genres` while its
 * parent's `total_signal` did not is a profile that disagrees with itself.
 *
 * `totalSignalDelta` is the caller's own already-clamped contribution — a play's
 * `max(0, weight)`, a like's 2.5, a follow's 4 — matching the Mongo line
 * `totalSignal = max(0, totalSignal + max(0, weight))`, where a skip's negative
 * weight cools the individual buckets but never reduces the maturity signal.
 *
 * **A non-existent artist is now a `23503`**, where Mongo stored the string: the
 * artist side is a real foreign key. Every caller derives the id from a row it
 * has already read (`tracks.artist_id`, or a `catalog_entities` row it just
 * selected), so the only way to hit it is an artist deleted between that read
 * and this write. All three callers already treat this as best-effort and log
 * without rethrowing, which is the right outcome for a lost taste signal.
 */
export async function applyTasteSignal(
  oxyUserId: string,
  signal: {
    genres: TasteDelta[];
    artists: TasteDelta[];
    totalSignalDelta: number;
  },
): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [profile] = await tx
      .insert(userTasteProfiles)
      .values({ oxyUserId, totalSignal: Math.max(0, signal.totalSignalDelta) })
      .onConflictDoUpdate({
        target: userTasteProfiles.oxyUserId,
        set: {
          totalSignal: sql`greatest(0, ${userTasteProfiles.totalSignal} + ${Math.max(0, signal.totalSignalDelta)})`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: userTasteProfiles.id });

    await applyGenreDeltas(tx, profile.id, signal.genres);
    await applyArtistDeltas(tx, profile.id, signal.artists);
  });
}

/**
 * Merge deltas by key, then split into the ones that may CREATE a bucket and
 * the ones that may only cool an existing one.
 *
 * **The merge is not tidiness — it is required for correctness.** Postgres
 * rejects an `INSERT … ON CONFLICT DO UPDATE` whose `VALUES` list names the same
 * conflict key twice, with `21000: ON CONFLICT DO UPDATE command cannot affect
 * row a second time`. `applyFollowSignal` can produce exactly that: it lowercases
 * an artist's genre list, so an artist tagged `['Rock', 'rock']` yields two
 * `rock` deltas. The Mongo version looped and bumped the bucket twice, which is
 * a SUM — so summing here is also what preserves the old behaviour, rather than
 * merely avoiding the error.
 *
 * The non-positive branch is at most one key in practice — `recordPlay` applies
 * a skip's negative weight to the played track's single genre and single artist
 * — so it is a small loop rather than a `VALUES` join that would cost more to
 * read than it saves.
 */
function splitDeltas(deltas: TasteDelta[]): { positive: TasteDelta[]; cooling: TasteDelta[] } {
  const merged = new Map<string, number>();
  for (const { key, delta } of deltas) {
    merged.set(key, (merged.get(key) ?? 0) + delta);
  }

  const positive: TasteDelta[] = [];
  const cooling: TasteDelta[] = [];
  for (const [key, delta] of merged) {
    if (delta > 0) positive.push({ key, delta });
    else if (delta < 0) cooling.push({ key, delta });
    // A delta of exactly zero changes nothing and must not create a bucket.
  }
  return { positive, cooling };
}

async function applyGenreDeltas(
  tx: DbOrTransaction,
  tasteProfileId: string,
  deltas: TasteDelta[],
): Promise<void> {
  const { positive, cooling } = splitDeltas(deltas);

  if (positive.length > 0) {
    await tx
      .insert(userTasteGenres)
      .values(positive.map((d) => ({ tasteProfileId, genre: d.key, weight: d.delta })))
      .onConflictDoUpdate({
        target: [userTasteGenres.tasteProfileId, userTasteGenres.genre],
        // `excluded.weight` is the DELTA this statement tried to insert, so this
        // is `max(0, existing + delta)` — the in-memory `applyWeight` line.
        set: {
          weight: sql`greatest(0, ${userTasteGenres.weight} + excluded.weight)`,
        },
      });
  }

  for (const { key, delta } of cooling) {
    await tx
      .update(userTasteGenres)
      .set({ weight: sql`greatest(0, ${userTasteGenres.weight} + ${delta})` })
      .where(
        and(eq(userTasteGenres.tasteProfileId, tasteProfileId), eq(userTasteGenres.genre, key)),
      );
  }

  if (positive.length > 0) await trimGenres(tx, tasteProfileId);
}

async function applyArtistDeltas(
  tx: DbOrTransaction,
  tasteProfileId: string,
  deltas: TasteDelta[],
): Promise<void> {
  const { positive, cooling } = splitDeltas(deltas);

  if (positive.length > 0) {
    await tx
      .insert(userTasteArtists)
      .values(positive.map((d) => ({ tasteProfileId, artistId: d.key, weight: d.delta })))
      .onConflictDoUpdate({
        target: [userTasteArtists.tasteProfileId, userTasteArtists.artistId],
        set: {
          weight: sql`greatest(0, ${userTasteArtists.weight} + excluded.weight)`,
        },
      });
  }

  for (const { key, delta } of cooling) {
    await tx
      .update(userTasteArtists)
      .set({ weight: sql`greatest(0, ${userTasteArtists.weight} + ${delta})` })
      .where(
        and(eq(userTasteArtists.tasteProfileId, tasteProfileId), eq(userTasteArtists.artistId, key)),
      );
  }

  if (positive.length > 0) await trimArtists(tx, tasteProfileId);
}

/**
 * Drop everything past the cap, lowest weight first — `list.sort(); list.length
 * = max` against a table.
 *
 * The key is a tiebreak so the trim is reproducible; Mongo's was decided by the
 * array's insertion order surviving a stable sort, which was arbitrary in a
 * different way rather than defined.
 */
async function trimGenres(tx: DbOrTransaction, tasteProfileId: string): Promise<void> {
  const survivors = tx
    .select({ id: userTasteGenres.id })
    .from(userTasteGenres)
    .where(eq(userTasteGenres.tasteProfileId, tasteProfileId))
    .orderBy(sql`${userTasteGenres.weight} desc, ${userTasteGenres.genre} asc`)
    .limit(MAX_TASTE_GENRES);

  await tx
    .delete(userTasteGenres)
    .where(
      and(
        eq(userTasteGenres.tasteProfileId, tasteProfileId),
        sql`${userTasteGenres.id} not in ${survivors}`,
      ),
    );
}

async function trimArtists(tx: DbOrTransaction, tasteProfileId: string): Promise<void> {
  const survivors = tx
    .select({ id: userTasteArtists.id })
    .from(userTasteArtists)
    .where(eq(userTasteArtists.tasteProfileId, tasteProfileId))
    .orderBy(sql`${userTasteArtists.weight} desc, ${userTasteArtists.artistId} asc`)
    .limit(MAX_TASTE_ARTISTS);

  await tx
    .delete(userTasteArtists)
    .where(
      and(
        eq(userTasteArtists.tasteProfileId, tasteProfileId),
        sql`${userTasteArtists.id} not in ${survivors}`,
      ),
    );
}

// ── Decay ─────────────────────────────────────────────────────────────────

export interface TasteDecayResult {
  profilesProcessed: number;
}

/**
 * Apply recency decay to every profile that is due.
 *
 * Five statements for the whole pass — decay and prune each child, then settle
 * the parents — rather than one round trip per profile. See this file's doc
 * comment for why the cursor's per-profile isolation is not lost by doing so.
 *
 * `total_signal` is recomputed as the sum of the surviving ARTIST weights only,
 * which is what the Mongo pass did (`for (const a of profile.artists) total +=
 * a.weight`). That makes decay the one writer whose `total_signal` is a real
 * sum rather than an accumulator of deltas — a pre-existing quirk of the model,
 * ported as-is because nothing reads the field and changing it here would be an
 * unreviewed behaviour change smuggled into a port.
 */
export async function decayDueTasteProfiles(): Promise<TasteDecayResult> {
  return getDb().transaction(async (tx) => {
    // The elapsed-time floor, as a timestamp so the predicate stays on a bare
    // column. Statement-stable: `now()` is the transaction's start time, so all
    // five statements below agree on the instant.
    const due = lt(
      userTasteProfiles.lastDecayAt,
      sql`now() - make_interval(secs => ${MIN_DECAY_ELAPSED_SECONDS})`,
    );

    const dueProfiles = tx
      .select({ id: userTasteProfiles.id })
      .from(userTasteProfiles)
      .where(due);

    /** `0.5 ^ (elapsed / halfLife)`, per profile, from its own `last_decay_at`. */
    const factor = sql`power(
      0.5,
      extract(epoch from (now() - ${userTasteProfiles.lastDecayAt}))
        / ${HALF_LIFE_DAYS * 24 * 60 * 60}
    )`;

    await tx
      .update(userTasteGenres)
      .set({ weight: sql`${userTasteGenres.weight} * ${factor}` })
      .from(userTasteProfiles)
      .where(and(eq(userTasteGenres.tasteProfileId, userTasteProfiles.id), due));

    await tx
      .delete(userTasteGenres)
      .where(
        and(
          lt(userTasteGenres.weight, PRUNE_THRESHOLD),
          inArray(userTasteGenres.tasteProfileId, dueProfiles),
        ),
      );

    await tx
      .update(userTasteArtists)
      .set({ weight: sql`${userTasteArtists.weight} * ${factor}` })
      .from(userTasteProfiles)
      .where(and(eq(userTasteArtists.tasteProfileId, userTasteProfiles.id), due));

    await tx
      .delete(userTasteArtists)
      .where(
        and(
          lt(userTasteArtists.weight, PRUNE_THRESHOLD),
          inArray(userTasteArtists.tasteProfileId, dueProfiles),
        ),
      );

    // LAST, for two reasons: the sum must see the decayed and pruned artists,
    // and this is the statement that moves `last_decay_at` out from under the
    // `due` predicate every statement above depends on.
    const settled = await tx
      .update(userTasteProfiles)
      .set({
        totalSignal: sql`(
          select coalesce(sum(${userTasteArtists.weight}), 0)
          from ${userTasteArtists}
          where ${userTasteArtists.tasteProfileId} = ${userTasteProfiles.id}
        )`,
        lastDecayAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(due)
      .returning({ id: userTasteProfiles.id });

    return { profilesProcessed: settled.length };
  });
}
