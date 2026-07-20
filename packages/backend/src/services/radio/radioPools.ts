import mongoose from 'mongoose';
import { CatalogRelationModel } from '../../models/CatalogRelation';
import { TrackModel, type ITrack } from '../../models/Track';
import { playableTrackFilter } from '../../utils/catalogVisibility';
import { withImageFirstSort } from '../../utils/imageFirstSort';
import { andMongoFilters, topRelatedArtistIds } from '../recommendations/taste';
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
 * The Mongo-backed half of the station generator: where candidates come from.
 *
 * `radioEngine` stays pure — it decides how candidates are ordered. This module
 * decides which candidates exist, by querying five pools in priority order and
 * stopping as soon as it has enough to score. The pools degrade from most
 * specific to least: collaborative neighbours, then related artists, then
 * content similarity, then genre popularity, then unconstrained popularity.
 * The last one has no content constraint on purpose — it is the endlessness
 * guarantee, and it can always produce something while the catalogue holds a
 * single playable track.
 */

/** Candidates gathered per page, as a multiple of the page size, before scoring. */
export const RADIO_OVERSAMPLE = 3;

/** Relation edges read per page, as a multiple of the oversampled target. */
const CF_EDGE_FANOUT = 5;

/** Sort applied to every pool that orders by reach rather than by relation score. */
const POPULARITY_SORT = withImageFirstSort('track', { popularity: -1, playCount: -1 });

/**
 * A playable track as the pools return it — the full lean document, so the
 * caller can serialise a page without a second round trip to Mongo.
 */
export type RadioTrackDoc = mongoose.Require_id<ITrack>;

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
  tracks: RadioTrackDoc[];
  /** True when the pool was exhausted and the served history had to be reset. */
  wrapped: boolean;
  /**
   * The state the page was programmed against — the input state, or a trimmed
   * copy when the station wrapped. The caller must fold the served page into
   * THIS state, not into the one it passed in, or the wrap is lost.
   */
  state: RadioStationState;
}

function isObjectId(value: string): boolean {
  return mongoose.Types.ObjectId.isValid(value);
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
 * The ONE way a pool reaches Mongo.
 *
 * Every pool goes through here, so playability, the listener's explicit
 * preference and the served-history exclusion are applied structurally — a pool
 * added later cannot forget them, because it never builds a query itself. The
 * pool's own filter is composed under `$and` (never spread), so a pool that
 * passes an `$or` keeps it.
 */
async function findPoolTracks(
  ctx: PoolQueryContext,
  filter: mongoose.QueryFilter<ITrack>,
  sort: Record<string, 1 | -1>,
  limit: number
): Promise<RadioTrackDoc[]> {
  if (limit <= 0) {
    return [];
  }

  const excluded = Array.from(ctx.exclude).filter(isObjectId);
  const constraints: mongoose.QueryFilter<ITrack>[] = [playableTrackFilter<ITrack>({})];

  if (excluded.length > 0) {
    constraints.push({ _id: { $nin: excluded } });
  }
  if (!ctx.allowExplicit) {
    constraints.push({ isExplicit: { $ne: true } });
  }
  constraints.push(filter);

  return TrackModel.find(andMongoFilters(...constraints)).sort(sort).limit(limit).lean();
}

interface GatheredCandidates {
  docs: Map<string, RadioTrackDoc>;
  /** Summed relation score per track, for the candidates that came from the CF pool. */
  cfScores: Map<string, number>;
}

async function gatherCandidates(
  seed: SeedResolution,
  state: RadioStationState,
  target: number,
  allowExplicit: boolean
): Promise<GatheredCandidates> {
  const docs = new Map<string, RadioTrackDoc>();
  const cfScores = new Map<string, number>();
  const ctx: PoolQueryContext = { exclude: new Set(state.servedTrackIds), allowExplicit };

  const collect = (found: RadioTrackDoc[]): void => {
    for (const doc of found) {
      const id = doc._id.toString();
      if (docs.has(id)) continue;
      docs.set(id, doc);
      // Later pools must not re-offer what an earlier one already found.
      ctx.exclude.add(id);
    }
  };

  const remaining = (): number => target - docs.size;

  // ── Pool 1: collaborative neighbours ──────────────────────────────────────
  // Sources are the seed's tracks PLUS the station's frontier. The frontier is
  // what makes a station drift: once page 1 has played, the tracks just heard
  // become CF sources too, so the station wanders outward instead of orbiting
  // its seed forever.
  const cfSources = distinct([...seed.seedTrackIds, ...state.frontierTrackIds]).filter(isObjectId);
  if (cfSources.length > 0) {
    const edges = await CatalogRelationModel.find({ kind: 'track', sourceId: { $in: cfSources } })
      .sort({ score: -1 })
      .limit(target * CF_EDGE_FANOUT)
      .lean();

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
      .map(([id]) => id)
      .filter(isObjectId);

    if (neighbourIds.length > 0) {
      const found = await findPoolTracks(
        ctx,
        { _id: { $in: neighbourIds } },
        POPULARITY_SORT,
        remaining()
      );
      for (const doc of found) {
        cfScores.set(doc._id.toString(), scoreById.get(doc._id.toString()) ?? 0);
      }
      collect(found);
    }
  }

  // ── Pool 2: related-artist deep cuts ──────────────────────────────────────
  if (remaining() > 0 && seed.seedArtistIds.length > 0) {
    const relatedArtistIds = await topRelatedArtistIds(
      seed.seedArtistIds.filter(isObjectId),
      new Set<string>(),
      remaining()
    );
    if (relatedArtistIds.length > 0) {
      collect(
        await findPoolTracks(ctx, { artistId: { $in: relatedArtistIds } }, POPULARITY_SORT, remaining())
      );
    }
  }

  // ── Pool 3: content similarity ────────────────────────────────────────────
  if (remaining() > 0) {
    const contentOr: mongoose.QueryFilter<ITrack>[] = [];
    if (seed.genres.length > 0) contentOr.push({ genre: { $in: seed.genres } });
    if (seed.moods.length > 0) contentOr.push({ mood: { $in: seed.moods } });
    if (seed.tags.length > 0) contentOr.push({ tags: { $in: seed.tags } });

    if (contentOr.length > 0) {
      collect(await findPoolTracks(ctx, { $or: contentOr }, POPULARITY_SORT, remaining()));
    }
  }

  // ── Pool 4: genre popularity ──────────────────────────────────────────────
  if (remaining() > 0 && seed.genres.length > 0) {
    collect(await findPoolTracks(ctx, { genre: { $in: seed.genres } }, POPULARITY_SORT, remaining()));
  }

  // ── Pool 5: global popularity backstop ────────────────────────────────────
  if (remaining() > 0) {
    collect(await findPoolTracks(ctx, {}, POPULARITY_SORT, remaining()));
  }

  return { docs, cfScores };
}

/** Artists of the tracks just heard — they take the repeat penalty alongside the seed artist. */
async function frontierArtistIds(frontierTrackIds: string[]): Promise<string[]> {
  const ids = frontierTrackIds.filter(isObjectId);
  if (ids.length === 0) {
    return [];
  }

  const docs = await TrackModel.find({ _id: { $in: ids } }).select({ artistId: 1 }).lean();
  return distinct(docs.map((doc) => doc.artistId));
}

function toCandidate(doc: RadioTrackDoc, cfScore: number | undefined): RadioCandidate {
  return {
    trackId: doc._id.toString(),
    artistId: doc.artistId,
    genre: doc.genre,
    mood: doc.mood,
    tags: doc.tags,
    popularity: doc.popularity,
    isExplicit: doc.isExplicit,
    cfScore,
  };
}

/** Gather, score and programme one page against a given station state. */
async function programmePage(
  input: BuildRadioPageInput,
  state: RadioStationState
): Promise<RadioTrackDoc[]> {
  const { seed, page, limit, taste, allowExplicit } = input;

  const [{ docs, cfScores }, recentArtistIds] = await Promise.all([
    gatherCandidates(seed, state, limit * RADIO_OVERSAMPLE, allowExplicit),
    frontierArtistIds(state.frontierTrackIds),
  ]);

  // The seed track opens its own station, so it must be in the pool at page 0
  // even though the pools never return a CF source as a CF target.
  const seedTrackId = state.seedType === 'track' ? state.seedId : undefined;
  if (page === 0 && seedTrackId !== undefined && !docs.has(seedTrackId) && isObjectId(seedTrackId)) {
    const seedDoc = await TrackModel.findOne(playableTrackFilter({ _id: seedTrackId })).lean();
    if (seedDoc) {
      docs.set(seedDoc._id.toString(), seedDoc);
    }
  }

  const candidates = Array.from(docs.values()).map((doc) =>
    toCandidate(doc, cfScores.get(doc._id.toString()))
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
    .map((candidate) => docs.get(candidate.trackId))
    .filter((doc): doc is RadioTrackDoc => doc !== undefined);
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
  const tracks = await programmePage(input, input.state);
  if (tracks.length >= input.limit) {
    return { tracks, wrapped: false, state: input.state };
  }

  const wrappedState: RadioStationState = {
    ...input.state,
    // Normally the frontier survives the wrap, so the tracks just heard cannot
    // come back immediately. But an EMPTY page means the catalogue is already a
    // subset of the served history — and the frontier is a subset of that, so
    // retaining it would leave the pool just as empty and the wrap would be a
    // no-op. Endlessness outranks not-repeating-yet: clear the history outright.
    servedTrackIds: tracks.length === 0 ? [] : input.state.servedTrackIds.slice(-FRONTIER_SIZE),
    wrappedAt: input.state.wrappedAt ?? Date.now(),
  };

  const wrappedTracks = await programmePage(input, wrappedState);

  // Wrapping bought nothing — the catalogue itself is that small. Keep the
  // original state rather than flagging a wrap that changed no outcome.
  if (wrappedTracks.length <= tracks.length) {
    return { tracks, wrapped: false, state: input.state };
  }

  return { tracks: wrappedTracks, wrapped: true, state: wrappedState };
}
