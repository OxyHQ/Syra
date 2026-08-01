import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { PlaylistVisibility } from '@syra/shared-types';
import { connect, clear, disconnect } from '../../test/mongo';
import { ArtistModel } from '../../models/CatalogEntity';
import { TrackModel } from '../../models/Track';
import { AlbumModel } from '../../models/Album';
import { PlaylistModel } from '../../models/Playlist';
import { PlaylistTrackModel } from '../../models/PlaylistTrack';
import { ContributionAttestationModel } from '../../models/ContributionAttestation';
import {
  loadDiscography,
  loadCreditedOn,
  loadPlaylistsFeaturing,
  loadProfileState,
  loadArtistProfileSections,
  type ArtistProfileSource,
} from './artistProfile';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

// ── Fixtures ──────────────────────────────────────────────────────────────────

async function makeArtist(overrides: Record<string, unknown> = {}) {
  return ArtistModel.create({
    name: `Artist ${Math.random().toString(36).slice(2)}`,
    source: 'upload',
    ...overrides,
  });
}

async function makeTrack(
  artistId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const track = await TrackModel.create({
    title: `Track ${Math.random().toString(36).slice(2)}`,
    artistId,
    artistName: 'Someone',
    duration: 200,
    source: 'upload',
    status: 'ready',
    ...overrides,
  });
  return track._id.toString();
}

async function makeAlbum(
  artistId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const album = await AlbumModel.create({
    title: `Album ${Math.random().toString(36).slice(2)}`,
    artistId,
    artistName: 'Someone',
    releaseDate: '2024-01-01',
    coverArt: new mongoose.Types.ObjectId().toString(),
    ...overrides,
  });
  return album._id.toString();
}

async function makePlaylist(
  trackIds: string[],
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const playlist = await PlaylistModel.create({
    name: `Playlist ${Math.random().toString(36).slice(2)}`,
    ownerOxyUserId: 'curator-1',
    ownerUsername: 'curator',
    visibility: PlaylistVisibility.PUBLIC,
    ...overrides,
  });
  await Promise.all(trackIds.map((trackId, order) =>
    PlaylistTrackModel.create({
      playlistId: playlist._id,
      trackId,
      addedAt: new Date().toISOString(),
      order,
    }),
  ));
  return playlist._id.toString();
}

function ids(list: unknown[]): string[] {
  return list.map((item) => (item as { id: string }).id);
}

// ── Discography ───────────────────────────────────────────────────────────────

describe('loadDiscography — split by release type', () => {
  it('separates albums, singles/EPs and compilations', async () => {
    const artist = await makeArtist();
    const artistId = artist._id.toString();

    const lp = await makeAlbum(artistId, { type: 'album' });
    const single = await makeAlbum(artistId, { type: 'single' });
    const ep = await makeAlbum(artistId, { type: 'ep' });
    const compilation = await makeAlbum(artistId, { type: 'compilation' });
    for (const albumId of [lp, single, ep, compilation]) {
      await makeTrack(artistId, { albumId });
    }

    const discography = await loadDiscography(artistId);

    expect(ids(discography.albums)).toEqual([lp]);
    expect(ids(discography.singlesAndEps).sort()).toEqual([single, ep].sort());
    expect(ids(discography.compilations)).toEqual([compilation]);
  });

  it('treats an album with no explicit type as an album', async () => {
    const artist = await makeArtist();
    const artistId = artist._id.toString();
    const untyped = await makeAlbum(artistId);
    await makeTrack(artistId, { albumId: untyped });

    const discography = await loadDiscography(artistId);
    expect(ids(discography.albums)).toEqual([untyped]);
  });

  /**
   * The rule the whole section exists under: a shelf that opens to nothing is
   * worse than an absent shelf.
   */
  it('omits an album whose only track was taken down', async () => {
    const artist = await makeArtist();
    const artistId = artist._id.toString();
    const empty = await makeAlbum(artistId, { type: 'album' });
    await makeTrack(artistId, { albumId: empty, copyrightRemoved: true, isAvailable: false });

    const discography = await loadDiscography(artistId);
    expect(discography.albums).toEqual([]);
  });

  it('omits an album the creator unpublished, even with playable tracks', async () => {
    const artist = await makeArtist();
    const artistId = artist._id.toString();
    const hidden = await makeAlbum(artistId, { type: 'album', isAvailable: false });
    await makeTrack(artistId, { albumId: hidden });

    const discography = await loadDiscography(artistId);
    expect(discography.albums).toEqual([]);
  });
});

// ── Credited on ───────────────────────────────────────────────────────────────

describe('loadCreditedOn — secondary participation', () => {
  it('finds a track where the artist is a credit, not the primary, and names the roles', async () => {
    const guest = await makeArtist({ name: 'Guest Star', nameKey: 'guest star' });
    const host = await makeArtist({ name: 'Host Band', nameKey: 'host band' });
    const trackId = await makeTrack(host._id.toString(), {
      title: 'Collab',
      credits: [
        { name: 'Guest Star', role: 'artist', nameKey: 'guest star' },
        { name: 'Guest Star', role: 'producer', nameKey: 'guest star' },
        { name: 'Somebody Else', role: 'composer', nameKey: 'somebody else' },
      ],
    });

    const credited = await loadCreditedOn(guest);

    expect(credited).toHaveLength(1);
    expect((credited[0]?.track as { id: string }).id).toBe(trackId);
    expect(credited[0]?.roles.sort()).toEqual(['artist', 'producer']);
  });

  it('excludes the artist\'s OWN releases — those are the discography', async () => {
    const artist = await makeArtist({ name: 'Solo', nameKey: 'solo' });
    await makeTrack(artist._id.toString(), {
      credits: [{ name: 'Solo', role: 'artist', nameKey: 'solo' }],
    });

    expect(await loadCreditedOn(artist)).toEqual([]);
  });

  it('excludes a taken-down track', async () => {
    const guest = await makeArtist({ name: 'Guest', nameKey: 'guest' });
    const host = await makeArtist({ name: 'Host', nameKey: 'host' });
    await makeTrack(host._id.toString(), {
      copyrightRemoved: true,
      isAvailable: false,
      credits: [{ name: 'Guest', role: 'producer', nameKey: 'guest' }],
    });

    expect(await loadCreditedOn(guest)).toEqual([]);
  });

  /**
   * A credit already RESOLVED to a different entity must not be attributed to
   * this one just because the names normalise alike, or the profile claims work
   * its subject never touched.
   *
   * The `catalogEntityId` is written only on a high-confidence match, so where it
   * disagrees with the name it is the name that is wrong. (Two ARTISTS cannot
   * share a `nameKey` — it is uniquely indexed — but a credit can be resolved to
   * any catalog entity, and persons share that collection and dedup by strong
   * keys instead.)
   */
  it('excludes a credit resolved to a different entity', async () => {
    const guest = await makeArtist({ name: 'Nirvana' });
    const somebodyElse = await makeArtist({ name: 'A Different Band' });
    const host = await makeArtist({ name: 'Host' });

    await makeTrack(host._id.toString(), {
      credits: [{
        name: 'Nirvana',
        role: 'artist',
        // Matches our artist by name, resolved to somebody else.
        nameKey: 'nirvana',
        catalogEntityId: somebodyElse._id.toString(),
      }],
    });

    // Vacuity floor: the query DOES reach that track — only the in-memory
    // refinement rejects it. Without this the test would pass on a broken query.
    expect(await TrackModel.countDocuments({ 'credits.nameKey': 'nirvana' })).toBe(1);
    expect(await loadCreditedOn(guest)).toEqual([]);
  });

  it('INCLUDES a credit explicitly linked to this artist', async () => {
    const guest = await makeArtist({ name: 'Linked', nameKey: 'linked' });
    const host = await makeArtist({ name: 'Host', nameKey: 'host' });
    const trackId = await makeTrack(host._id.toString(), {
      credits: [{
        name: 'Linked',
        role: 'remixer',
        nameKey: 'linked',
        catalogEntityId: guest._id.toString(),
      }],
    });

    const credited = await loadCreditedOn(guest);
    expect(ids(credited.map((entry) => entry.track))).toEqual([trackId]);
    expect(credited[0]?.roles).toEqual(['remixer']);
  });

  it('returns nothing for an artist with no name key rather than matching everything', async () => {
    const artist = await makeArtist({ name: 'No Key' });
    await ArtistModel.updateOne({ _id: artist._id }, { $unset: { nameKey: 1 } });
    const host = await makeArtist({ name: 'Host', nameKey: 'host' });
    await makeTrack(host._id.toString(), {
      credits: [{ name: 'No Key', role: 'artist', nameKey: 'no key' }],
    });

    const reloaded = await ArtistModel.findById(artist._id).lean();
    if (!reloaded) throw new Error('expected the artist to still exist');
    expect(reloaded.nameKey).toBeUndefined();
    expect(await loadCreditedOn(reloaded)).toEqual([]);
  });
});

// ── Playlists ─────────────────────────────────────────────────────────────────

describe('loadPlaylistsFeaturing — readability is canViewPlaylist\'s decision', () => {
  it('includes a public playlist that contains one of the artist\'s tracks', async () => {
    const artist = await makeArtist();
    const trackId = await makeTrack(artist._id.toString());
    const playlistId = await makePlaylist([trackId]);

    const playlists = await loadPlaylistsFeaturing(artist._id.toString());
    expect(ids(playlists)).toEqual([playlistId]);
  });

  it('hides a PRIVATE playlist from a guest but shows it to its owner', async () => {
    const artist = await makeArtist();
    const trackId = await makeTrack(artist._id.toString());
    const playlistId = await makePlaylist([trackId], {
      visibility: PlaylistVisibility.PRIVATE,
      ownerOxyUserId: 'curator-1',
    });

    expect(await loadPlaylistsFeaturing(artist._id.toString())).toEqual([]);
    expect(ids(await loadPlaylistsFeaturing(artist._id.toString(), 'curator-1'))).toEqual([playlistId]);
  });

  it('shows a private playlist to a collaborator', async () => {
    const artist = await makeArtist();
    const trackId = await makeTrack(artist._id.toString());
    const playlistId = await makePlaylist([trackId], {
      visibility: PlaylistVisibility.PRIVATE,
      ownerOxyUserId: 'curator-1',
      collaborators: [{
        oxyUserId: 'friend-2',
        username: 'friend',
        role: 'editor',
        addedAt: new Date().toISOString(),
      }],
    });

    expect(ids(await loadPlaylistsFeaturing(artist._id.toString(), 'friend-2'))).toEqual([playlistId]);
  });

  it('excludes a playlist whose tracks are all taken down', async () => {
    const artist = await makeArtist();
    const trackId = await makeTrack(artist._id.toString());
    await makePlaylist([trackId]);
    await TrackModel.updateOne({ _id: trackId }, { copyrightRemoved: true, isAvailable: false });

    expect(await loadPlaylistsFeaturing(artist._id.toString())).toEqual([]);
  });

  it('is empty for an artist with no playable tracks at all', async () => {
    const artist = await makeArtist();
    expect(await loadPlaylistsFeaturing(artist._id.toString())).toEqual([]);
  });
});

// ── Profile state ─────────────────────────────────────────────────────────────

describe('loadProfileState', () => {
  it('reports a contributed, unclaimed profile as claimable', async () => {
    const artist = await makeArtist({ origin: 'contributed', claimable: true });

    const state = await loadProfileState(artist, []);

    expect(state.origin).toBe('contributed');
    expect(state.claimable).toBe(true);
    expect(state.claimed).toBe(false);
    expect(state.acceptsContributions).toBe(false);
  });

  it('reports a claimed profile as claimed and NOT claimable', async () => {
    const artist = await makeArtist({
      origin: 'contributed',
      claimable: false,
      claimedByOxyUserId: 'the-artist',
      ownerOxyUserId: 'the-artist',
      acceptsContributions: true,
    });

    const state = await loadProfileState(artist, []);

    expect(state.claimable).toBe(false);
    expect(state.claimed).toBe(true);
    expect(state.acceptsContributions).toBe(true);
  });

  it('lists every field that came from an external source, deduplicated', async () => {
    const artist = await makeArtist({
      sources: [
        { provider: 'cc', externalId: 'mb-1', importedAt: '2026-01-01', fields: ['bio', 'country'] },
        { provider: 'cc', externalId: 'wd-1', importedAt: '2026-01-02', fields: ['country', 'image'] },
      ],
    });

    const state = await loadProfileState(artist, []);
    expect(state.externallySourcedFields.sort()).toEqual(['bio', 'country', 'image']);
  });

  it('separates tracks a third party contributed from the artist\'s own', async () => {
    const artist = await makeArtist();
    const own = await makeTrack(artist._id.toString());
    const contributed = await makeTrack(artist._id.toString());
    await ContributionAttestationModel.create({
      trackId: contributed,
      uploaderOxyUserId: 'a-stranger',
      statement: 'I may distribute this recording',
      acceptedAt: new Date(),
    });

    const state = await loadProfileState(artist, [own, contributed]);
    expect(state.contributedTrackIds).toEqual([contributed]);
  });
});

// ── Assembly ──────────────────────────────────────────────────────────────────

describe('loadArtistProfileSections', () => {
  it('assembles every section for one artist', async () => {
    const artist = await makeArtist({ name: 'Full Profile', nameKey: 'full profile', claimable: true, origin: 'contributed' });
    const artistId = artist._id.toString();

    const albumId = await makeAlbum(artistId, { type: 'ep' });
    const ownTrack = await makeTrack(artistId, { albumId });

    const host = await makeArtist({ name: 'Host', nameKey: 'host' });
    await makeTrack(host._id.toString(), {
      credits: [{ name: 'Full Profile', role: 'producer', nameKey: 'full profile' }],
    });

    const playlistId = await makePlaylist([ownTrack]);

    const sections = await loadArtistProfileSections(artist, { trackIds: [ownTrack] });

    expect(ids(sections.discography.singlesAndEps)).toEqual([albumId]);
    expect(sections.creditedOn).toHaveLength(1);
    expect(sections.creditedOn[0]?.roles).toEqual(['producer']);
    expect(ids(sections.playlists)).toEqual([playlistId]);
    expect(sections.profileState.claimable).toBe(true);
  });

  it('returns empty sections rather than absent ones for a bare artist', async () => {
    const artist = await makeArtist({ name: 'Bare', nameKey: 'bare' });

    const sections = await loadArtistProfileSections(artist, { trackIds: [] });

    expect(sections.discography).toEqual({ albums: [], singlesAndEps: [], compilations: [] });
    expect(sections.creditedOn).toEqual([]);
    expect(sections.playlists).toEqual([]);
    expect(sections.profileState.claimed).toBe(false);
  });
});
