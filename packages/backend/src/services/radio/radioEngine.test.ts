import { describe, it, expect } from 'bun:test';
import {
  scoreCandidate,
  applyRadioDiversity,
  mulberry32,
  hashStationPage,
  RadioCandidate,
  RankedRadioCandidate,
  RadioScoringContext,
  MAX_TRACKS_PER_ARTIST_PER_PAGE,
  CF_SCORE_WEIGHT,
  TASTE_AFFINITY_WEIGHT,
  CONTENT_AFFINITY_WEIGHT,
  POPULARITY_PRIOR_WEIGHT,
  SEED_ARTIST_REPEAT_PENALTY_WEIGHT,
} from './radioEngine';

const BASE_CTX: RadioScoringContext = {
  artistAffinity: {},
  genreAffinity: {},
  maxCfScore: 1,
  maxPopularity: 100,
  recentArtistIds: [],
  allowExplicit: true,
};

const candidate = (over: Partial<RadioCandidate> & { trackId: string }): RadioCandidate => ({
  artistId: 'artist-default',
  ...over,
});

const ranked = (
  entries: (Partial<RadioCandidate> & { trackId: string; score: number })[]
): RankedRadioCandidate[] =>
  entries.map(({ score, ...rest }) => ({ ...candidate(rest), score }));

describe('scoreCandidate — blend ordering', () => {
  it('scores a zero-signal candidate at zero', () => {
    expect(scoreCandidate(candidate({ trackId: 't1' }), BASE_CTX)).toBe(0);
  });

  it('weights each term as documented', () => {
    const cf = scoreCandidate(candidate({ trackId: 't', cfScore: 1 }), BASE_CTX);
    expect(cf).toBeCloseTo(CF_SCORE_WEIGHT, 10);

    const taste = scoreCandidate(candidate({ trackId: 't', artistId: 'a1', genre: 'jazz' }), {
      ...BASE_CTX,
      artistAffinity: { a1: 1 },
      genreAffinity: { jazz: 1 },
    });
    expect(taste).toBeCloseTo(TASTE_AFFINITY_WEIGHT, 10);

    const content = scoreCandidate(
      candidate({ trackId: 't', genre: 'jazz', mood: 'calm', tags: ['x'] }),
      { ...BASE_CTX, seedGenre: 'jazz', seedMood: 'calm', seedTags: ['x'] }
    );
    expect(content).toBeCloseTo(CONTENT_AFFINITY_WEIGHT, 10);

    const popularity = scoreCandidate(candidate({ trackId: 't', popularity: 100 }), BASE_CTX);
    expect(popularity).toBeCloseTo(POPULARITY_PRIOR_WEIGHT, 10);
  });

  it('ranks collaborative filtering above taste above content above popularity', () => {
    expect(CF_SCORE_WEIGHT).toBeGreaterThan(TASTE_AFFINITY_WEIGHT);
    expect(TASTE_AFFINITY_WEIGHT).toBeGreaterThan(CONTENT_AFFINITY_WEIGHT);
    expect(CONTENT_AFFINITY_WEIGHT).toBeGreaterThan(POPULARITY_PRIOR_WEIGHT);

    const cfOnly = scoreCandidate(candidate({ trackId: 'a', cfScore: 1 }), BASE_CTX);
    const popOnly = scoreCandidate(candidate({ trackId: 'b', popularity: 100 }), BASE_CTX);
    expect(cfOnly).toBeGreaterThan(popOnly);
  });

  it('penalises the seed artist so a station is not just a discography', () => {
    const ctx: RadioScoringContext = { ...BASE_CTX, seedArtistId: 'seed-artist' };
    const bySeed = scoreCandidate(candidate({ trackId: 'a', artistId: 'seed-artist', cfScore: 1 }), ctx);
    const byOther = scoreCandidate(candidate({ trackId: 'b', artistId: 'other', cfScore: 1 }), ctx);

    expect(byOther).toBeGreaterThan(bySeed);
    expect(byOther - bySeed).toBeCloseTo(SEED_ARTIST_REPEAT_PENALTY_WEIGHT, 10);
  });

  it('penalises artists already in the frontier', () => {
    const ctx: RadioScoringContext = { ...BASE_CTX, recentArtistIds: ['just-heard'] };
    const repeat = scoreCandidate(candidate({ trackId: 'a', artistId: 'just-heard' }), ctx);
    const fresh = scoreCandidate(candidate({ trackId: 'b', artistId: 'unheard' }), ctx);
    expect(fresh).toBeGreaterThan(repeat);
  });

  it('normalises cfScore and popularity against the pool maxima', () => {
    const half = scoreCandidate(candidate({ trackId: 'a', cfScore: 5 }), { ...BASE_CTX, maxCfScore: 10 });
    expect(half).toBeCloseTo(CF_SCORE_WEIGHT * 0.5, 10);
  });

  it('treats a zero or missing maximum as no signal rather than dividing by zero', () => {
    const score = scoreCandidate(candidate({ trackId: 'a', cfScore: 5, popularity: 9 }), {
      ...BASE_CTX,
      maxCfScore: 0,
      maxPopularity: 0,
    });
    expect(score).toBe(0);
    expect(Number.isFinite(score)).toBe(true);
  });

  it('clamps an out-of-range signal instead of letting it dominate', () => {
    const score = scoreCandidate(candidate({ trackId: 'a', cfScore: 1000 }), BASE_CTX);
    expect(score).toBeCloseTo(CF_SCORE_WEIGHT, 10);
  });

  it('orders a strong candidate above a weak one end to end', () => {
    const ctx: RadioScoringContext = {
      ...BASE_CTX,
      seedGenre: 'jazz',
      artistAffinity: { loved: 1 },
      genreAffinity: { jazz: 1 },
    };
    const strong = scoreCandidate(
      candidate({ trackId: 'a', artistId: 'loved', genre: 'jazz', cfScore: 1, popularity: 90 }),
      ctx
    );
    const weak = scoreCandidate(candidate({ trackId: 'b', artistId: 'unknown', genre: 'polka' }), ctx);
    expect(strong).toBeGreaterThan(weak);
  });
});

describe('mulberry32 / hashStationPage — determinism', () => {
  it('produces the same sequence for the same seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = Array.from({ length: 20 }, a);
    const seqB = Array.from({ length: 20 }, b);
    expect(seqA).toEqual(seqB);
  });

  it('produces a different sequence for a different seed', () => {
    const a = Array.from({ length: 20 }, mulberry32(1));
    const b = Array.from({ length: 20 }, mulberry32(2));
    expect(a).not.toEqual(b);
  });

  it('stays within [0, 1)', () => {
    const random = mulberry32(99);
    for (let i = 0; i < 500; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('hashes a station page deterministically', () => {
    expect(hashStationPage('station-a', 3)).toBe(hashStationPage('station-a', 3));
  });

  it('hashes different pages and different stations differently', () => {
    expect(hashStationPage('station-a', 0)).not.toBe(hashStationPage('station-a', 1));
    expect(hashStationPage('station-a', 0)).not.toBe(hashStationPage('station-b', 0));
  });

  it('returns an unsigned 32-bit integer', () => {
    const hash = hashStationPage('radio:station:user:abc:track:t1', 7);
    expect(Number.isInteger(hash)).toBe(true);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('applyRadioDiversity — hard constraints', () => {
  const BASE_OPTS = { stationKey: 'station-x', page: 1, allowExplicit: true };

  // Twelve tracks across three artists, all tied — the worst case for clumping.
  const clumpy = ranked(
    Array.from({ length: 12 }, (_, i) => ({
      trackId: `t${i}`,
      artistId: `artist-${i % 3}`,
      score: 0.5,
    }))
  );

  it('never emits two consecutive tracks by the same artist', () => {
    const page = applyRadioDiversity(clumpy, 6, BASE_OPTS);
    expect(page.length).toBeGreaterThan(1);
    for (let i = 1; i < page.length; i += 1) {
      expect(page[i].artistId).not.toBe(page[i - 1].artistId);
    }
  });

  it(`caps an artist at ${MAX_TRACKS_PER_ARTIST_PER_PAGE} tracks per page`, () => {
    const page = applyRadioDiversity(clumpy, 12, BASE_OPTS);
    const counts = new Map<string, number>();
    for (const track of page) {
      counts.set(track.artistId, (counts.get(track.artistId) ?? 0) + 1);
    }
    for (const count of counts.values()) {
      expect(count).toBeLessThanOrEqual(MAX_TRACKS_PER_ARTIST_PER_PAGE);
    }
  });

  it('holds both constraints even when one artist floods the pool', () => {
    const flooded = ranked([
      ...Array.from({ length: 20 }, (_, i) => ({
        trackId: `flood-${i}`,
        artistId: 'artist-loud',
        score: 0.9,
      })),
      { trackId: 'other-1', artistId: 'artist-quiet', score: 0.1 },
      { trackId: 'other-2', artistId: 'artist-calm', score: 0.1 },
    ]);

    const page = applyRadioDiversity(flooded, 10, BASE_OPTS);
    expect(page.filter((t) => t.artistId === 'artist-loud')).toHaveLength(
      MAX_TRACKS_PER_ARTIST_PER_PAGE
    );
    for (let i = 1; i < page.length; i += 1) {
      expect(page[i].artistId).not.toBe(page[i - 1].artistId);
    }
  });

  it('returns a short page rather than breaking a constraint', () => {
    const singleArtist = ranked([
      { trackId: 'a', artistId: 'solo', score: 0.9 },
      { trackId: 'b', artistId: 'solo', score: 0.8 },
      { trackId: 'c', artistId: 'solo', score: 0.7 },
    ]);

    const page = applyRadioDiversity(singleArtist, 3, BASE_OPTS);
    expect(page).toHaveLength(1);
  });

  it('respects the limit and drops duplicate track ids', () => {
    const withDupes = ranked([
      { trackId: 'dupe', artistId: 'a1', score: 0.9 },
      { trackId: 'dupe', artistId: 'a2', score: 0.8 },
      { trackId: 'other', artistId: 'a3', score: 0.7 },
    ]);

    const page = applyRadioDiversity(withDupes, 10, BASE_OPTS);
    expect(page.map((t) => t.trackId)).toEqual(['dupe', 'other']);
  });

  it('returns nothing for a non-positive limit', () => {
    expect(applyRadioDiversity(clumpy, 0, BASE_OPTS)).toEqual([]);
  });
});

describe('applyRadioDiversity — seed placement', () => {
  const pool = ranked([
    { trackId: 'seed', artistId: 'artist-seed', score: 1 },
    { trackId: 'a', artistId: 'artist-a', score: 0.9 },
    { trackId: 'b', artistId: 'artist-b', score: 0.8 },
    { trackId: 'c', artistId: 'artist-c', score: 0.7 },
  ]);

  it('places the seed first on page 0', () => {
    const page = applyRadioDiversity(pool, 4, {
      stationKey: 's',
      page: 0,
      seedTrackId: 'seed',
      allowExplicit: true,
    });
    expect(page[0].trackId).toBe('seed');
    expect(page.filter((t) => t.trackId === 'seed')).toHaveLength(1);
  });

  it('never emits the seed on a later page', () => {
    for (const page of [1, 2, 7]) {
      const result = applyRadioDiversity(pool, 4, {
        stationKey: 's',
        page,
        seedTrackId: 'seed',
        allowExplicit: true,
      });
      expect(result.map((t) => t.trackId)).not.toContain('seed');
    }
  });

  it('does not let the track after the seed share the seed artist', () => {
    const sameArtistAsSeed = ranked([
      { trackId: 'seed', artistId: 'artist-seed', score: 1 },
      { trackId: 'also-seed-artist', artistId: 'artist-seed', score: 0.95 },
      { trackId: 'other', artistId: 'artist-other', score: 0.5 },
    ]);

    const page = applyRadioDiversity(sameArtistAsSeed, 3, {
      stationKey: 's',
      page: 0,
      seedTrackId: 'seed',
      allowExplicit: true,
    });

    expect(page[0].trackId).toBe('seed');
    expect(page[1].artistId).not.toBe('artist-seed');
  });

  it('programmes normally when the station has no seed track', () => {
    const page = applyRadioDiversity(pool, 4, { stationKey: 's', page: 0, allowExplicit: true });
    expect(page).toHaveLength(4);
  });
});

describe('applyRadioDiversity — explicit content is a listener preference', () => {
  const mixed = ranked([
    { trackId: 'clean-1', artistId: 'a1', score: 0.9 },
    { trackId: 'explicit-1', artistId: 'a2', score: 0.8, isExplicit: true },
    { trackId: 'clean-2', artistId: 'a3', score: 0.7, isExplicit: false },
    { trackId: 'explicit-2', artistId: 'a4', score: 0.6, isExplicit: true },
  ]);

  it('excludes explicit candidates when the listener turned them off', () => {
    const page = applyRadioDiversity(mixed, 10, {
      stationKey: 's',
      page: 0,
      allowExplicit: false,
    });
    expect(page.map((t) => t.trackId)).toEqual(['clean-1', 'clean-2']);
  });

  it('includes explicit candidates when the listener allows them', () => {
    const page = applyRadioDiversity(mixed, 10, {
      stationKey: 's',
      page: 0,
      allowExplicit: true,
    });
    expect(page.map((t) => t.trackId)).toEqual([
      'clean-1',
      'explicit-1',
      'clean-2',
      'explicit-2',
    ]);
  });

  it('treats an unknown explicit flag as not explicit', () => {
    const unknown = ranked([{ trackId: 'unflagged', artistId: 'a1', score: 0.5 }]);
    const page = applyRadioDiversity(unknown, 5, {
      stationKey: 's',
      page: 0,
      allowExplicit: false,
    });
    expect(page.map((t) => t.trackId)).toEqual(['unflagged']);
  });

  it('drops an explicit seed rather than smuggling it in at index 0', () => {
    const explicitSeed = ranked([
      { trackId: 'seed', artistId: 'a1', score: 1, isExplicit: true },
      { trackId: 'clean', artistId: 'a2', score: 0.5 },
    ]);

    const page = applyRadioDiversity(explicitSeed, 5, {
      stationKey: 's',
      page: 0,
      seedTrackId: 'seed',
      allowExplicit: false,
    });
    expect(page.map((t) => t.trackId)).toEqual(['clean']);
  });
});

describe('applyRadioDiversity — seeded shuffle determinism', () => {
  // All tied, all distinct artists: ordering is decided purely by the PRNG.
  const tied = ranked(
    Array.from({ length: 24 }, (_, i) => ({
      trackId: `t${i}`,
      artistId: `artist-${i}`,
      score: 0.5,
    }))
  );

  const idsFor = (stationKey: string, page: number): string[] =>
    applyRadioDiversity(tied, 10, { stationKey, page, allowExplicit: true }).map((t) => t.trackId);

  it('yields identical output for identical (stationKey, page)', () => {
    expect(idsFor('station-a', 3)).toEqual(idsFor('station-a', 3));
  });

  it('stays identical across many repeats, so a client retry never burns catalog', () => {
    const first = idsFor('station-a', 0);
    for (let i = 0; i < 25; i += 1) {
      expect(idsFor('station-a', 0)).toEqual(first);
    }
  });

  it('yields different output for a different page', () => {
    expect(idsFor('station-a', 0)).not.toEqual(idsFor('station-a', 1));
  });

  it('yields different output for a different station', () => {
    expect(idsFor('station-a', 0)).not.toEqual(idsFor('station-b', 0));
  });

  it('actually shuffles rather than returning the input order', () => {
    const inputOrder = tied.slice(0, 10).map((t) => t.trackId);
    expect(idsFor('station-a', 0)).not.toEqual(inputOrder);
  });

  it('does not shuffle across score bands — a higher band always comes first', () => {
    const banded = ranked([
      ...Array.from({ length: 4 }, (_, i) => ({
        trackId: `high-${i}`,
        artistId: `high-artist-${i}`,
        score: 0.9,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        trackId: `low-${i}`,
        artistId: `low-artist-${i}`,
        score: 0.1,
      })),
    ]);

    const page = applyRadioDiversity(banded, 8, { stationKey: 's', page: 0, allowExplicit: true });
    expect(page.slice(0, 4).every((t) => t.trackId.startsWith('high-'))).toBe(true);
    expect(page.slice(4).every((t) => t.trackId.startsWith('low-'))).toBe(true);
  });

  it('does not mutate the input array', () => {
    const input = [...tied];
    applyRadioDiversity(input, 10, { stationKey: 's', page: 0, allowExplicit: true });
    expect(input.map((t) => t.trackId)).toEqual(tied.map((t) => t.trackId));
  });
});
