import {
  and,
  arrayOverlaps,
  eq,
  inArray,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import { findRelatedEdges } from '../../db/user/relations';
import { getDb } from '../../db/postgres';
import { tracks } from '../../db/schema/catalog';
import { PROTECTED_COLUMNS_BY_TABLE } from '../../db/schema/protectedColumns';
import { playableTrackFilter } from '../../db/catalog/visibility';
import { descNullsLast, imageFirst } from '../../db/catalog/containers';
import type { PublicTrackRow } from '../../db/catalog/serialize';
import { topRelatedArtistIds } from '../recommendations/taste';
import {
  applyRadioDiversity,
  scoreCandidate,
  type RadioCandidate,
  type RadioScoringContext,
  type RankedRadioCandidate,
} from './radioEngine';
import type { RadioTasteSignal, SeedResolution } from './radioSeed';
import { FRONTIER_SIZE, type RadioStationState } from './radioStationStore';

/**
 * The database-backed half of the station generator: where candidates come from.
 *
 * `radioEngine` stays pure — it decides how candidates are ordered. This module
 * decides which candidates exist, by querying five pools in priority order and
 * stopping as soon as it has enough to score. The pools degrade from most
 * specific to least: collaborative neighbours, then related artists, then
 * content similarity, then genre popularity, then unconstrained popularity.
 * The last one has no content constraint on purpose — it is the endlessness
 * guarantee, and it can always produce something while the catalogue holds a
 * single playable track.
 *
 * The co-listen graph (`catalog_relations`, via `db/user/relations.ts`) is read
 * for a ranked list of track ids that is then looked up against `tracks` — never
 * joined to it in one statement, because the pool sums a target's score across
 * every source that reaches it and that arithmetic decides the ranking.
 */

/** Candidates gathered per page, as a multiple of the page size, before scoring. */
export const RADIO_OVERSAMPLE = 3;

/** Relation edges read per page, as a multiple of the oversampled target. */
const CF_EDGE_FANOUT = 5;

/**
 * Ordering applied to every pool that ranks by reach rather than by relation
 * score — the replacement for `withImageFirstSort('track', …)`.
 */
const POPULARITY_ORDER = [
  imageFirst(tracks.coverArtId),
  descNullsLast(tracks.popularity),
  descNullsLast(tracks.playCount),
];

export interface BuildRadioPageInput {
  seed: SeedResolution;
  state: RadioStationState;
  page: number;
  limit: number;
  taste: RadioTasteSignal;
  /**
   * Listener preference, NOT availability. Availability is viewer-independent
   * and decided by `playableTrackFilter`; this only drops explicit candidates
   * for a listener who has turned them off.
   */
  allowExplicit: boolean;
}

export interface RadioPageResult {
  /**
   * Public track rows, so the caller can serialise a page without a second
   * round trip. `publicColumns()` is what makes that safe: the two protected
   * `tracks` columns are not on the row at all, rather than being selected and
   * then deleted late.
   */
  tracks: PublicTrackRow[];
  /** True when the pool was exhausted and the served history had to be reset. */
  wrapped: boolean;
  /**
   * The state the page was programmed against — the input state, or a trimmed
   * copy when the station wrapped. The caller must fold the served page into
   * THIS state, not into the one it passed in, or the wrap is lost.
   */
  state: RadioStationState;
}

function distinct(values: string[]): string[] {
  return Array.from(new Set(values));
}

interface PoolQueryContext {
  /** Track ids the page may not contain: already served, or already gathered. */
  exclude: Set<string>;
  allowExplicit: boolean;
}

/**
 * The ONE way a pool reaches the database.
 *
 * Every pool goes through here, so playability, the listener's explicit
 * preference and the served-history exclusion are applied structurally — a pool
 * added later cannot forget them, because it never builds a query itself. The
 * pool's own condition is composed with `and()`, so a pool that passes an
 * `or(...)` keeps it; the Mongo version needed `andMongoFilters` for that,
 * because spreading two filter objects dropped the earlier `$or`.
 */
async function findPoolTracks(
  ctx: PoolQueryContext,
  condition: SQL | undefined,
  limit: number
): Promise<PublicTrackRow[]> {
  if (limit <= 0) {
    return [];
  }

  const excluded = [...ctx.exclude];

  return getDb()
    .select(publicColumns(tracks, PROTECTED_COLUMNS_BY_TABLE))
    .from(tracks)
    .where(
      and(
        playableTrackFilter(),
        excluded.length > 0 ? notInArray(tracks.id, excluded) : undefined,
        // `is not true` rather than `!= true`: `is_explicit` is NOT NULL here so
        // the two agree, but the spelling is the one that stays correct if the
        // column ever becomes nullable, and it matches Mongo's `{ $ne: true }`.
        ctx.allowExplicit ? undefined : sql`${tracks.isExplicit} is not true`,
        condition
      )
    )
    .orderBy(...POPULARITY_ORDER)
    .limit(limit);
}

interface GatheredCandidates {
  rows: Map<string, PublicTrackRow>;
  /** Summed relation score per track, for the candidates that came from the CF pool. */
  cfScores: Map<string, number>;
}

async function gatherCandidates(
  seed: SeedResolution,
  state: RadioStationState,
  target: number,
  allowExplicit: boolean
): Promise<GatheredCandidates> {
  const rows = new Map<string, PublicTrackRow>();
  const cfScores = new Map<string, number>();
  const ctx: PoolQueryContext = { exclude: new Set(state.servedTrackIds), allowExplicit };

  const collect = (found: PublicTrackRow[]): void => {
    for (const row of found) {
      if (rows.has(row.id)) continue;
      rows.set(row.id, row);
      // Later pools must not re-offer what an earlier one already found.
      ctx.exclude.add(row.id);
    }
  };

  const remaining = (): number => target - rows.size;

  // ── Pool 1: collaborative neighbours ──────────────────────────────────────
  // Sources are the seed's tracks PLUS the station's frontier. The frontier is
  // what makes a station drift: once page 1 has played, the tracks just heard
  // become CF sources too, so the station wanders outward instead of orbiting
  // its seed forever.
  const cfSources = distinct([...seed.seedTrackIds, ...state.frontierTrackIds]);
  if (cfSources.length > 0) {
    const edges = await findRelatedEdges('track', cfSources, target * CF_EDGE_FANOUT);

    // Sum across sources so a track related to several of them outranks one
    // related to a single source.
    const scoreById = new Map<string, number>();
    for (const edge of edges) {
      if (ctx.exclude.has(edge.targetId)) continue;
      scoreById.set(edge.targetId, (scoreById.get(edge.targetId) ?? 0) + edge.score);
    }

    const neighbourIds = Array.from(scoreById.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, remaining())
      .map(([id]) => id);

    if (neighbourIds.length > 0) {
      const found = await findPoolTracks(ctx, inArray(tracks.id, neighbourIds), remaining());
      for (const row of found) {
        cfScores.set(row.id, scoreById.get(row.id) ?? 0);
      }
      collect(found);
    }
  }

  // ── Pool 2: related-artist deep cuts ──────────────────────────────────────
  if (remaining() > 0 && seed.seedArtistIds.length > 0) {
    const relatedArtistIds = await topRelatedArtistIds(
      seed.seedArtistIds,
      new Set<string>(),
      remaining()
    );
    if (relatedArtistIds.length > 0) {
      collect(await findPoolTracks(ctx, inArray(tracks.artistId, relatedArtistIds), remaining()));
    }
  }

  // ── Pool 3: content similarity ────────────────────────────────────────────
  if (remaining() > 0) {
    const contentTerms: SQL[] = [];
    if (seed.genres.length > 0) contentTerms.push(inArray(tracks.genre, seed.genres));
    if (seed.moods.length > 0) contentTerms.push(inArray(tracks.mood, seed.moods));
    // `&&` — array overlap. The Mongo `{ tags: { $in: [...] } }` matched a
    // document whose tags array shared ANY element with the list, which is
    // overlap, not containment.
    if (seed.tags.length > 0) contentTerms.push(arrayOverlaps(tracks.tags, seed.tags));

    if (contentTerms.length > 0) {
      const condition =
        contentTerms.length === 1 ? contentTerms[0] : (or(...contentTerms) as SQL);
      collect(await findPoolTracks(ctx, condition, remaining()));
    }
  }

  // ── Pool 4: genre popularity ──────────────────────────────────────────────
  if (remaining() > 0 && seed.genres.length > 0) {
    collect(await findPoolTracks(ctx, inArray(tracks.genre, seed.genres), remaining()));
  }

  // ── Pool 5: global popularity backstop ────────────────────────────────────
  if (remaining() > 0) {
    collect(await findPoolTracks(ctx, undefined, remaining()));
  }

  return { rows, cfScores };
}

/** Artists of the tracks just heard — they take the repeat penalty alongside the seed artist. */
async function frontierArtistIds(frontierTrackIds: string[]): Promise<string[]> {
  if (frontierTrackIds.length === 0) {
    return [];
  }

  const rows = await getDb()
    .select({ artistId: tracks.artistId })
    .from(tracks)
    .where(inArray(tracks.id, frontierTrackIds));

  return distinct(rows.map((row) => row.artistId));
}

function toCandidate(row: PublicTrackRow, cfScore: number | undefined): RadioCandidate {
  return {
    trackId: row.id,
    artistId: row.artistId,
    genre: row.genre ?? undefined,
    mood: row.mood ?? undefined,
    tags: row.tags,
    popularity: row.popularity,
    isExplicit: row.isExplicit,
    cfScore,
  };
}

/** Gather, score and programme one page against a given station state. */
async function programmePage(
  input: BuildRadioPageInput,
  state: RadioStationState
): Promise<PublicTrackRow[]> {
  const { seed, page, limit, taste, allowExplicit } = input;

  const [{ rows, cfScores }, recentArtistIds] = await Promise.all([
    gatherCandidates(seed, state, limit * RADIO_OVERSAMPLE, allowExplicit),
    frontierArtistIds(state.frontierTrackIds),
  ]);

  // The seed track opens its own station, so it must be in the pool at page 0
  // even though the pools never return a CF source as a CF target.
  const seedTrackId = state.seedType === 'track' ? state.seedId : undefined;
  if (page === 0 && seedTrackId !== undefined && !rows.has(seedTrackId)) {
    const [seedRow] = await getDb()
      .select(publicColumns(tracks, PROTECTED_COLUMNS_BY_TABLE))
      .from(tracks)
      .where(and(eq(tracks.id, seedTrackId), playableTrackFilter()))
      .limit(1);
    if (seedRow) {
      rows.set(seedRow.id, seedRow);
    }
  }

  const candidates = Array.from(rows.values()).map((row) =>
    toCandidate(row, cfScores.get(row.id))
  );

  const ranked: RankedRadioCandidate[] = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreCandidate(candidate, {
        // The repeat penalty only means something when the station has ONE
        // anchoring artist. On an album/playlist/personalised station every
        // seed artist would take it, which would penalise the whole pool
        // uniformly and change no ordering.
        seedArtistId: seed.seedArtistIds.length === 1 ? seed.seedArtistIds[0] : undefined,
        seedGenre: seed.genres[0],
        seedMood: seed.moods[0],
        seedTags: seed.tags,
        artistAffinity: taste.artistAffinity,
        genreAffinity: taste.genreAffinity,
        maxCfScore: Math.max(0, ...cfScores.values()),
        maxPopularity: Math.max(0, ...candidates.map((entry) => entry.popularity ?? 0)),
        recentArtistIds,
        allowExplicit,
      } satisfies RadioScoringContext),
    }))
    .sort((a, b) => b.score - a.score);

  const selected = applyRadioDiversity(ranked, limit, {
    stationKey: `${state.ownerKey}:${state.seedType}:${state.seedId}`,
    page,
    allowExplicit,
    seedTrackId,
  });

  return selected
    .map((candidate) => rows.get(candidate.trackId))
    .filter((row): row is PublicTrackRow => row !== undefined);
}

/**
 * Programme one page of a station.
 *
 * Runs the pools, scores what they returned, and applies the diversity
 * constraints. If that yields a short page — every pool exhausted and too few
 * survivors after dedup against the served history — the station WRAPS: all but
 * the most recent {@link FRONTIER_SIZE} served ids are forgotten and the page is
 * programmed once more. A station must never hand back an empty page while a
 * playable track exists, and wrapping is how a small catalogue keeps that
 * promise. The retry runs at most once, so an empty catalogue terminates.
 */
export async function buildRadioPage(input: BuildRadioPageInput): Promise<RadioPageResult> {
  const page = await programmePage(input, input.state);
  if (page.length >= input.limit) {
    return { tracks: page, wrapped: false, state: input.state };
  }

  const wrappedState: RadioStationState = {
    ...input.state,
    // Normally the frontier survives the wrap, so the tracks just heard cannot
    // come back immediately. But an EMPTY page means the catalogue is already a
    // subset of the served history — and the frontier is a subset of that, so
    // retaining it would leave the pool just as empty and the wrap would be a
    // no-op. Endlessness outranks not-repeating-yet: clear the history outright.
    servedTrackIds: page.length === 0 ? [] : input.state.servedTrackIds.slice(-FRONTIER_SIZE),
    wrappedAt: input.state.wrappedAt ?? Date.now(),
  };

  const wrappedPage = await programmePage(input, wrappedState);

  // Wrapping bought nothing — the catalogue itself is that small. Keep the
  // original state rather than flagging a wrap that changed no outcome.
  if (wrappedPage.length <= page.length) {
    return { tracks: page, wrapped: false, state: input.state };
  }

  return { tracks: wrappedPage, wrapped: true, state: wrappedState };
}
