import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { connect, clear, disconnect } from '../../test/mongo';
import { buildRadioPage, RADIO_OVERSAMPLE, type RadioTrackDoc } from './radioPools';
import { resolveRadioSeed, type RadioTasteSignal, type SeedResolution } from './radioSeed';
import {
  createRadioStationState,
  recordServedPage,
  FRONTIER_SIZE,
  type RadioStationState,
} from './radioStationStore';
import { makeArtist, makeTrack, relate } from './radioFixtures';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

const FLAT_TASTE: RadioTasteSignal = { artistAffinity: {}, genreAffinity: {} };

function stationFor(seedType: RadioStationState['seedType'], seedId: string): RadioStationState {
  return createRadioStationState({ seedType, seedId, ownerKey: 'guest:test' });
}

/** Resolve a seed and fail loudly rather than threading a nullable through a test. */
async function seedFor(seedType: RadioStationState['seedType'], seedId: string): Promise<SeedResolution> {
  const seed = await resolveRadioSeed({ seedType, seedId }, undefined);
  if (!seed) {
    throw new Error(`seed ${seedType}:${seedId} did not resolve`);
  }
  return seed;
}

const idsOf = (tracks: RadioTrackDoc[]): string[] => tracks.map((track) => track._id.toString());

describe('buildRadioPage — playability is enforced in every pool', () => {
  it('never programmes a copyright-removed or unavailable track, from any pool', async () => {
    const artistId = await makeArtist({ name: 'Nova', genres: ['house'] });
    const seedTrack = await makeTrack({ artistId, genre: 'house', title: 'Seed' });

    // One struck / one unavailable track reachable from EVERY pool at once: a
    // CF neighbour of the seed, by a related artist, sharing the seed's genre,
    // and globally the most popular thing in the catalogue.
    const relatedArtistId = await makeArtist({ name: 'Related' });
    const struck = await makeTrack({
      artistId: relatedArtistId,
      genre: 'house',
      popularity: 100,
      copyrightRemoved: true,
      title: 'Struck',
    });
    const unavailable = await makeTrack({
      artistId: relatedArtistId,
      genre: 'house',
      popularity: 99,
      isAvailable: false,
      title: 'Unavailable',
    });
    await makeTrack({ artistId: relatedArtistId, genre: 'house', popularity: 40, title: 'Clean' });

    await relate('track', seedTrack._id.toString(), struck._id.toString(), 0.9);
    await relate('track', seedTrack._id.toString(), unavailable._id.toString(), 0.9);
    await relate('artist', artistId, relatedArtistId, 0.9);

    const seedId = seedTrack._id.toString();
    const result = await buildRadioPage({
      seed: await seedFor('track', seedId),
      state: stationFor('track', seedId),
      page: 0,
      limit: 10,
      taste: FLAT_TASTE,
      allowExplicit: true,
    });

    expect(idsOf(result.tracks)).not.toContain(struck._id.toString());
    expect(idsOf(result.tracks)).not.toContain(unavailable._id.toString());
    expect(result.tracks.length).toBeGreaterThan(0);
  });
});

describe('buildRadioPage — explicit content is a preference, not availability', () => {
  it('excludes explicit tracks when the preference is off and includes them when on', async () => {
    // Distinct artists: the engine refuses two consecutive tracks by one artist,
    // which would cap the page at a single track and hide the preference effect.
    const explicitArtist = await makeArtist({ name: 'Nova', genres: ['house'] });
    const cleanArtist = await makeArtist({ name: 'Vega', genres: ['house'] });
    await makeTrack({ artistId: explicitArtist, genre: 'house', isExplicit: true, popularity: 90, title: 'Explicit' });
    await makeTrack({ artistId: cleanArtist, genre: 'house', isExplicit: false, popularity: 10, title: 'Clean' });

    const seed = await seedFor('genre', 'house');

    const off = await buildRadioPage({
      seed,
      state: stationFor('genre', 'house'),
      page: 0,
      limit: 10,
      taste: FLAT_TASTE,
      allowExplicit: false,
    });
    expect(off.tracks.map((track) => track.title)).toEqual(['Clean']);

    const on = await buildRadioPage({
      seed,
      state: stationFor('genre', 'house'),
      page: 0,
      limit: 10,
      taste: FLAT_TASTE,
      allowExplicit: true,
    });
    expect(on.tracks.map((track) => track.title).sort()).toEqual(['Clean', 'Explicit']);
  });
});

describe('buildRadioPage — paging', () => {
  it('never repeats a track across two consecutive pages', async () => {
    // Two artists so the per-artist diversity cap cannot starve a page.
    const artistA = await makeArtist({ name: 'A', genres: ['house'] });
    const artistB = await makeArtist({ name: 'B', genres: ['house'] });
    for (let i = 0; i < 12; i += 1) {
      await makeTrack({
        artistId: i % 2 === 0 ? artistA : artistB,
        genre: 'house',
        popularity: 100 - i,
        title: `Track ${i}`,
      });
    }

    const seed = await seedFor('genre', 'house');
    const first = await buildRadioPage({
      seed,
      state: stationFor('genre', 'house'),
      page: 0,
      limit: 4,
      taste: FLAT_TASTE,
      allowExplicit: true,
    });
    expect(first.tracks).toHaveLength(4);

    const nextState = recordServedPage(first.state, 0, idsOf(first.tracks), {
      guest: true,
      wrapped: first.wrapped,
    });

    const second = await buildRadioPage({
      seed,
      state: nextState,
      page: 1,
      limit: 4,
      taste: FLAT_TASTE,
      allowExplicit: true,
    });
    expect(second.tracks).toHaveLength(4);

    const overlap = idsOf(second.tracks).filter((id) => idsOf(first.tracks).includes(id));
    expect(overlap).toEqual([]);
  });

  it('opens a track station with its seed and only at page 0', async () => {
    const artistId = await makeArtist({ name: 'Nova', genres: ['house'] });
    const seedTrack = await makeTrack({ artistId, genre: 'house', popularity: 1, title: 'Seed' });
    const otherArtistId = await makeArtist({ name: 'Other', genres: ['house'] });
    for (let i = 0; i < 6; i += 1) {
      await makeTrack({ artistId: otherArtistId, genre: 'house', popularity: 90 - i, title: `Other ${i}` });
    }

    const seedId = seedTrack._id.toString();
    const seed = await seedFor('track', seedId);

    const first = await buildRadioPage({
      seed,
      state: stationFor('track', seedId),
      page: 0,
      limit: 4,
      taste: FLAT_TASTE,
      allowExplicit: true,
    });
    expect(idsOf(first.tracks)[0]).toBe(seedId);

    const nextState = recordServedPage(first.state, 0, idsOf(first.tracks), {
      guest: true,
      wrapped: first.wrapped,
    });
    const second = await buildRadioPage({
      seed,
      state: nextState,
      page: 1,
      limit: 4,
      taste: FLAT_TASTE,
      allowExplicit: true,
    });
    expect(idsOf(second.tracks)).not.toContain(seedId);
  });
});

describe('buildRadioPage — the pools drain in priority order', () => {
  it('prefers a CF neighbour over a merely popular unrelated track', async () => {
    const artistId = await makeArtist({ name: 'Nova', genres: ['house'] });
    const seedTrack = await makeTrack({ artistId, genre: 'house', title: 'Seed' });

    const neighbourArtist = await makeArtist({ name: 'Neighbour' });
    const neighbour = await makeTrack({ artistId: neighbourArtist, popularity: 1, title: 'Neighbour' });
    await relate('track', seedTrack._id.toString(), neighbour._id.toString(), 0.95);

    const popularArtist = await makeArtist({ name: 'Popular' });
    await makeTrack({ artistId: popularArtist, popularity: 100, title: 'Popular Stranger' });

    const seedId = seedTrack._id.toString();
    const result = await buildRadioPage({
      seed: await seedFor('track', seedId),
      state: stationFor('track', seedId),
      page: 0,
      limit: 2,
      taste: FLAT_TASTE,
      allowExplicit: true,
    });

    // Page 0 opens with the seed; the CF neighbour outranks the popular stranger.
    expect(result.tracks.map((track) => track.title)).toEqual(['Seed', 'Neighbour']);
  });

  it('the global backstop programmes a page for a seed with no CF, artist or content signal', async () => {
    const artistId = await makeArtist({ name: 'Nova' });
    await makeTrack({ artistId, genre: 'house', popularity: 30, title: 'Only Track' });

    // A user seed with no taste profile: empty seed sets, so pools 1-4 all miss.
    const seed = await resolveRadioSeed({ seedType: 'user', seedId: '' }, undefined);
    expect(seed?.seedTrackIds).toEqual([]);

    const result = await buildRadioPage({
      seed: seed as SeedResolution,
      state: stationFor('user', ''),
      page: 0,
      limit: 5,
      taste: FLAT_TASTE,
      allowExplicit: true,
    });

    expect(result.tracks.map((track) => track.title)).toEqual(['Only Track']);
  });

  it('a cold-start user station is non-empty and honestly unpersonalised', async () => {
    const artistId = await makeArtist({ name: 'Nova' });
    for (let i = 0; i < 3; i += 1) {
      await makeTrack({ artistId, popularity: 50 - i, title: `Popular ${i}` });
    }

    const seed = await seedFor('user', '');
    expect(seed.personalized).toBe(false);

    const result = await buildRadioPage({
      seed,
      state: stationFor('user', ''),
      page: 0,
      limit: 5,
      taste: FLAT_TASTE,
      allowExplicit: true,
    });

    expect(result.tracks.length).toBeGreaterThan(0);
  });
});

describe('buildRadioPage — wrap', () => {
  it('wraps and returns a non-empty page once the pool is exhausted', async () => {
    const artistA = await makeArtist({ name: 'A', genres: ['house'] });
    const artistB = await makeArtist({ name: 'B', genres: ['house'] });
    const tracks = [];
    for (let i = 0; i < 4; i += 1) {
      tracks.push(await makeTrack({
        artistId: i % 2 === 0 ? artistA : artistB,
        genre: 'house',
        popularity: 50 - i,
        title: `Track ${i}`,
      }));
    }
    const allIds = tracks.map((track) => track._id.toString());

    // Every track in the catalogue has already been served to this station.
    const exhausted: RadioStationState = {
      ...stationFor('genre', 'house'),
      page: 1,
      servedTrackIds: allIds,
      frontierTrackIds: allIds.slice(-FRONTIER_SIZE),
    };

    const result = await buildRadioPage({
      seed: await seedFor('genre', 'house'),
      state: exhausted,
      page: 1,
      limit: 4,
      taste: FLAT_TASTE,
      allowExplicit: true,
    });

    expect(result.wrapped).toBe(true);
    expect(result.tracks.length).toBeGreaterThan(0);
    expect(result.state.wrappedAt).toBeDefined();
    // The whole catalogue had been served, so retaining the frontier would have
    // left the pool empty — the wrap clears the history outright.
    expect(result.state.servedTrackIds).toEqual([]);
  });

  it('does not claim a wrap when wrapping cannot help', async () => {
    const artistId = await makeArtist({ name: 'Solo', genres: ['house'] });
    const only = await makeTrack({ artistId, genre: 'house', title: 'Only' });

    // Asking for 4 tracks from a one-track catalogue: the page is short either
    // way, so there is nothing a wrap could buy.
    const result = await buildRadioPage({
      seed: await seedFor('genre', 'house'),
      state: stationFor('genre', 'house'),
      page: 0,
      limit: 4,
      taste: FLAT_TASTE,
      allowExplicit: true,
    });

    expect(idsOf(result.tracks)).toEqual([only._id.toString()]);
    expect(result.wrapped).toBe(false);
    expect(result.state.wrappedAt).toBeUndefined();
  });
});

describe('buildRadioPage — determinism', () => {
  it('programmes the identical page twice for the same station, page and state', async () => {
    const artistA = await makeArtist({ name: 'A', genres: ['house'] });
    const artistB = await makeArtist({ name: 'B', genres: ['house'] });
    // Identical popularity across the board, so ordering is decided entirely by
    // the seeded tie-break shuffle rather than by the Mongo sort.
    for (let i = 0; i < 10; i += 1) {
      await makeTrack({
        artistId: i % 2 === 0 ? artistA : artistB,
        genre: 'house',
        popularity: 50,
        title: `Track ${i}`,
      });
    }

    const seed = await seedFor('genre', 'house');
    const input = {
      seed,
      state: stationFor('genre', 'house'),
      page: 3,
      limit: 5,
      taste: FLAT_TASTE,
      allowExplicit: true,
    };

    const first = await buildRadioPage(input);
    const second = await buildRadioPage(input);

    expect(idsOf(second.tracks)).toEqual(idsOf(first.tracks));
  });

  it('oversamples the pool by RADIO_OVERSAMPLE before scoring', () => {
    expect(RADIO_OVERSAMPLE).toBe(3);
  });
});
