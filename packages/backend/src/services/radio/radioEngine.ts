/**
 * Pure radio programming logic: scoring, diversity and the seeded PRNG.
 *
 * This module deliberately contains no Mongo queries and no model imports —
 * every function here is a total function of its arguments, which is what makes
 * the station's output reproducible and unit testable.
 */

/** Weights of the scoring blend. They sum to 1 before the repeat penalty is subtracted. */
export const CF_SCORE_WEIGHT = 0.4;
export const TASTE_AFFINITY_WEIGHT = 0.25;
export const CONTENT_AFFINITY_WEIGHT = 0.2;
export const POPULARITY_PRIOR_WEIGHT = 0.15;
export const SEED_ARTIST_REPEAT_PENALTY_WEIGHT = 0.3;

/** How the listener's taste signal splits between artist-level and genre-level affinity. */
export const TASTE_ARTIST_WEIGHT = 0.6;
export const TASTE_GENRE_WEIGHT = 0.4;

/** How content similarity to the seed splits across the comparable facets. */
export const CONTENT_GENRE_WEIGHT = 0.5;
export const CONTENT_MOOD_WEIGHT = 0.25;
export const CONTENT_TAG_WEIGHT = 0.25;

/** No page may contain more than this many tracks by any single artist. */
export const MAX_TRACKS_PER_ARTIST_PER_PAGE = 2;

/**
 * Scores closer than this are treated as tied and shuffled together. Sized to
 * absorb float noise between candidates with identical feature vectors without
 * merging genuinely different scores.
 */
export const RADIO_SCORE_BAND_EPSILON = 1e-9;

/** A track the generator may programme, with the features scoring reads. */
export interface RadioCandidate {
  trackId: string;
  artistId: string;
  genre?: string;
  mood?: string;
  tags?: string[];
  popularity?: number;
  isExplicit?: boolean;
  /** Raw collaborative-filtering affinity, normalised against `maxCfScore`. */
  cfScore?: number;
}

/** A candidate that has been through {@link scoreCandidate}. */
export interface RankedRadioCandidate extends RadioCandidate {
  score: number;
}

export interface RadioScoringContext {
  /** The seed's artist, when the station has one. Its own tracks take the repeat penalty. */
  seedArtistId?: string;
  seedGenre?: string;
  seedMood?: string;
  seedTags?: string[];
  /** Listener taste, 0..1 per artist and per genre, from the taste profile. */
  artistAffinity: Record<string, number>;
  genreAffinity: Record<string, number>;
  /** Largest raw `cfScore` in the pool, used to normalise it to 0..1. */
  maxCfScore: number;
  /** Largest raw `popularity` in the pool, used to normalise the prior to 0..1. */
  maxPopularity: number;
  /** Artists heard in the station's frontier — they take the repeat penalty too. */
  recentArtistIds: string[];
  /**
   * Listener preference, not an availability question. When false, explicit
   * candidates are dropped at programming time by {@link applyRadioDiversity}.
   * Availability stays viewer-independent and is decided by the track filter.
   */
  allowExplicit: boolean;
}

export interface RadioDiversityOptions extends Pick<RadioScoringContext, 'allowExplicit'> {
  /** Seeds the PRNG together with `page`, so a retry reproduces the page exactly. */
  stationKey: string;
  page: number;
  /** The track the station was built from, if any. Only ever emitted at page 0, index 0. */
  seedTrackId?: string;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function normalise(value: number | undefined, max: number): number {
  if (value === undefined || !Number.isFinite(max) || max <= 0) {
    return 0;
  }
  return clamp01(value / max);
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const left = new Set(a);
  const right = new Set(b);
  let intersection = 0;
  for (const entry of left) {
    if (right.has(entry)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** How much this candidate matches what the listener already likes. */
function tasteAffinity(candidate: RadioCandidate, ctx: RadioScoringContext): number {
  const artist = clamp01(ctx.artistAffinity[candidate.artistId] ?? 0);
  const genre = candidate.genre ? clamp01(ctx.genreAffinity[candidate.genre] ?? 0) : 0;
  return artist * TASTE_ARTIST_WEIGHT + genre * TASTE_GENRE_WEIGHT;
}

/** How much this candidate sounds like the seed. */
function contentAffinity(candidate: RadioCandidate, ctx: RadioScoringContext): number {
  const genre = ctx.seedGenre && candidate.genre === ctx.seedGenre ? 1 : 0;
  const mood = ctx.seedMood && candidate.mood === ctx.seedMood ? 1 : 0;
  const tags = jaccard(candidate.tags ?? [], ctx.seedTags ?? []);
  return genre * CONTENT_GENRE_WEIGHT + mood * CONTENT_MOOD_WEIGHT + tags * CONTENT_TAG_WEIGHT;
}

/**
 * 1 when the candidate is by the seed artist or by an artist already in the
 * station's frontier. An artist station that plays nothing but the seed artist
 * is a discography, not radio — this is what pushes it outward.
 */
function seedArtistRepeatPenalty(candidate: RadioCandidate, ctx: RadioScoringContext): number {
  if (ctx.seedArtistId && candidate.artistId === ctx.seedArtistId) {
    return 1;
  }
  return ctx.recentArtistIds.includes(candidate.artistId) ? 1 : 0;
}

/** Blend a candidate's features into a single ordering score. */
export function scoreCandidate(candidate: RadioCandidate, ctx: RadioScoringContext): number {
  return (
    normalise(candidate.cfScore, ctx.maxCfScore) * CF_SCORE_WEIGHT +
    tasteAffinity(candidate, ctx) * TASTE_AFFINITY_WEIGHT +
    contentAffinity(candidate, ctx) * CONTENT_AFFINITY_WEIGHT +
    normalise(candidate.popularity, ctx.maxPopularity) * POPULARITY_PRIOR_WEIGHT -
    seedArtistRepeatPenalty(candidate, ctx) * SEED_ARTIST_REPEAT_PENALTY_WEIGHT
  );
}

/**
 * Mulberry32 — a small, fast, fully deterministic PRNG.
 *
 * Determinism is a correctness requirement here, not a nicety: the station
 * memoises the pages it has served, so if `Math.random()` crept in, the same
 * `(stationKey, page)` would produce different tracks on a retry and that memo
 * would be a lie — a client retry would silently burn a page of catalog.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over `stationKey#page` — the PRNG seed for one page of one station. */
export function hashStationPage(stationKey: string, page: number): number {
  const input = `${stationKey}#${page}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Fisher-Yates over each run of tied scores, leaving the band order itself intact. */
function shuffleEqualScoreBands(
  ranked: readonly RankedRadioCandidate[],
  random: () => number
): RankedRadioCandidate[] {
  const out: RankedRadioCandidate[] = [];
  let bandStart = 0;

  while (bandStart < ranked.length) {
    let bandEnd = bandStart + 1;
    while (
      bandEnd < ranked.length &&
      Math.abs(ranked[bandEnd].score - ranked[bandStart].score) <= RADIO_SCORE_BAND_EPSILON
    ) {
      bandEnd += 1;
    }

    const band = ranked.slice(bandStart, bandEnd);
    for (let i = band.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const swap = band[i];
      band[i] = band[j];
      band[j] = swap;
    }
    out.push(...band);
    bandStart = bandEnd;
  }

  return out;
}

/**
 * Turn a scored pool into the tracks of one page, enforcing the hard
 * constraints that make a station listenable:
 *
 *  - never two consecutive tracks by the same artist;
 *  - at most {@link MAX_TRACKS_PER_ARTIST_PER_PAGE} tracks per artist per page;
 *  - the seed track appears only at page 0, index 0;
 *  - explicit tracks are dropped when the listener has turned them off.
 *
 * `ranked` is expected sorted by score descending. Ties are broken by a PRNG
 * seeded from `(stationKey, page)`, so the same page always yields the same
 * tracks.
 */
export function applyRadioDiversity(
  ranked: readonly RankedRadioCandidate[],
  limit: number,
  opts: RadioDiversityOptions
): RankedRadioCandidate[] {
  if (limit <= 0) {
    return [];
  }

  const seen = new Set<string>();
  const eligible: RankedRadioCandidate[] = [];
  let seedCandidate: RankedRadioCandidate | null = null;

  for (const candidate of ranked) {
    if (seen.has(candidate.trackId)) {
      continue;
    }
    seen.add(candidate.trackId);

    if (!opts.allowExplicit && candidate.isExplicit === true) {
      continue;
    }

    // The seed is placed by hand below; it must never fall out of the pool.
    if (opts.seedTrackId !== undefined && candidate.trackId === opts.seedTrackId) {
      seedCandidate = candidate;
      continue;
    }

    eligible.push(candidate);
  }

  const random = mulberry32(hashStationPage(opts.stationKey, opts.page));
  const pool = shuffleEqualScoreBands(eligible, random);

  const selected: RankedRadioCandidate[] = [];
  const perArtist = new Map<string, number>();

  if (opts.page === 0 && seedCandidate) {
    selected.push(seedCandidate);
    perArtist.set(seedCandidate.artistId, 1);
  }

  const remaining = [...pool];
  while (selected.length < limit && remaining.length > 0) {
    const lastArtistId = selected[selected.length - 1]?.artistId;

    const nextIndex = remaining.findIndex(
      (candidate) =>
        candidate.artistId !== lastArtistId &&
        (perArtist.get(candidate.artistId) ?? 0) < MAX_TRACKS_PER_ARTIST_PER_PAGE
    );

    // Nothing left can be placed without breaking a hard constraint. A short
    // page is the correct answer — the constraints are not negotiable.
    if (nextIndex === -1) {
      break;
    }

    const [chosen] = remaining.splice(nextIndex, 1);
    selected.push(chosen);
    perArtist.set(chosen.artistId, (perArtist.get(chosen.artistId) ?? 0) + 1);
  }

  return selected;
}
