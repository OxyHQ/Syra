import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { PlaylistVisibility } from '@syra/shared-types';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import {
  albums,
  catalogEntities,
  imageAssets,
  trackCredits,
  tracks,
} from '../../db/schema/catalog';
import { playlistCollaborators, playlistTracks, playlists } from '../../db/schema/library';
import { contributionAttestations } from '../../db/schema/creators';
import {
  loadDiscography,
  loadCreditedOn,
  loadPlaylistsFeaturing,
  loadProfileState,
  loadArtistProfileSections,
  type ArtistProfileSource,
} from './artistProfile';

/**
 * BOTH databases: every catalog and playlist read is Postgres, and
 * `ContributionAttestation` — which tells the profile which of its tracks a
 * third party published — is Task 13's vertical and still Mongoose.
 */
beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * The artist SOURCE the sections take, not a document.
 *
 * `ArtistProfileSource` names `id` and seven optional fields rather than
 * `Pick`ing a model type, so a fixture builds one directly and the row it
 * inserts is separate — which is also what makes the "no name key" test below
 * expressible without `$unset`.
 */
async function makeArtist(
  overrides: Partial<typeof catalogEntities.$inferInsert> = {}
): Promise<ArtistProfileSource & { id: string }> {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: `Artist ${suffix}`,
      nameKey: `artist-${suffix}`,
      source: 'upload',
      ...overrides,
    })
    .returning();

  if (!artist) throw new Error('makeArtist: insert returned no row');
  return {
    id: artist.id,
    nameKey: artist.nameKey ?? undefined,
    origin: artist.origin ?? undefined,
    claimable: artist.claimable ?? undefined,
    claimedByOxyUserId: artist.claimedByOxyUserId ?? undefined,
    ownerOxyUserId: artist.ownerOxyUserId ?? undefined,
    acceptsContributions: artist.acceptsContributions ?? undefined,
  };
}

/** Credits are a child table now, so a track fixture writes two tables. */
async function makeTrack(
  artistId: string,
  overrides: Partial<typeof tracks.$inferInsert> & {
    credits?: { name: string; role: string; nameKey: string }[];
  } = {},
): Promise<string> {
  const { credits, ...columns } = overrides;
  const [track] = await getDb()
    .insert(tracks)
    .values({
      title: `Track ${uuidv7()}`,
      artistId,
      artistName: 'Someone',
      duration: 200,
      source: 'upload',
      status: 'ready',
      ...columns,
    })
    .returning({ id: tracks.id });

  if (!track) throw new Error('makeTrack: insert returned no row');

  if (credits?.length) {
    await getDb().insert(trackCredits).values(
      credits.map((credit, position) => ({ trackId: track.id, position, ...credit }))
    );
  }
  return track.id;
}

/** `albums.cover_art_id` is a NOT NULL foreign key, so the asset is real. */
async function makeAlbum(
  artistId: string,
  overrides: Partial<typeof albums.$inferInsert> = {},
): Promise<string> {
  const suffix = uuidv7();
  const [asset] = await getDb()
    .insert(imageAssets)
    .values({
      s3Key: `fixtures/${suffix}.jpg`,
      filename: 'c.jpg',
      contentType: 'image/jpeg',
      byteSize: 1,
      ownerType: 'album',
    })
    .returning({ id: imageAssets.id });

  const [album] = await getDb()
    .insert(albums)
    .values({
      title: `Album ${suffix}`,
      artistId,
      artistName: 'Someone',
      releaseDate: '2024-01-01',
      coverArtId: asset?.id ?? '',
      ...overrides,
    })
    .returning({ id: albums.id });

  if (!album) throw new Error('makeAlbum: insert returned no row');
  return album.id;
}

async function makePlaylist(
  trackIds: string[],
  overrides: Partial<typeof playlists.$inferInsert> & {
    collaborators?: string[];
  } = {},
): Promise<string> {
  const { collaborators, ...columns } = overrides;
  const [playlist] = await getDb()
    .insert(playlists)
    .values({
      name: `Playlist ${uuidv7()}`,
      ownerOxyUserId: 'curator-1',
      ownerUsername: 'curator',
      visibility: PlaylistVisibility.PUBLIC,
      ...columns,
    })
    .returning({ id: playlists.id });

  if (!playlist) throw new Error('makePlaylist: insert returned no row');

  if (trackIds.length > 0) {
    await getDb().insert(playlistTracks).values(
      trackIds.map((trackId, position) => ({
        playlistId: playlist.id,
        trackId,
        addedAt: new Date(),
        position,
      }))
    );
  }

  if (collaborators?.length) {
    await getDb().insert(playlistCollaborators).values(
      collaborators.map((oxyUserId) => ({
        playlistId: playlist.id,
        oxyUserId,
        username: 'friend',
        role: 'editor' as const,
        addedAt: new Date(),
      }))
    );
  }
  return playlist.id;
}

function ids(list: unknown[]): string[] {
  return list.map((item) => (item as { id: string }).id);
}

// ── Discography ───────────────────────────────────────────────────────────────

describe('loadDiscography — split by release type', () => {
  it('separates albums, singles/EPs and compilations', async () => {
    const artist = await makeArtist();
    const artistId = artist.id;

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
    const artistId = artist.id;
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
    const artistId = artist.id;
    const empty = await makeAlbum(artistId, { type: 'album' });
    await makeTrack(artistId, { albumId: empty, copyrightRemoved: true, isAvailable: false });

    const discography = await loadDiscography(artistId);
    expect(discography.albums).toEqual([]);
  });

  it('omits an album the creator unpublished, even with playable tracks', async () => {
    const artist = await makeArtist();
    const artistId = artist.id;
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
    const trackId = await makeTrack(host.id, {
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
    await makeTrack(artist.id, {
      credits: [{ name: 'Solo', role: 'artist', nameKey: 'solo' }],
    });

    expect(await loadCreditedOn(artist)).toEqual([]);
  });

  it('excludes a taken-down track', async () => {
    const guest = await makeArtist({ name: 'Guest', nameKey: 'guest' });
    const host = await makeArtist({ name: 'Host', nameKey: 'host' });
    await makeTrack(host.id, {
      copyrightRemoved: true,
      isAvailable: false,
      credits: [{ name: 'Guest', role: 'producer', nameKey: 'guest' }],
    });

    expect(await loadCreditedOn(guest)).toEqual([]);
  });

  /**
   * TWO TESTS WERE DELETED HERE, and the reason is a schema fact rather than a
   * change of mind.
   *
   * They covered the in-memory refinement `loadCreditedOn` used to apply: a
   * credit counted when it was explicitly linked to THIS artist
   * (`credits[].catalogEntityId`), or when it linked nowhere and matched by
   * name; a credit resolved to a DIFFERENT entity sharing a name key was
   * excluded. `track_credits` has no `catalog_entity_id` column —
   * `schema/catalog.ts` dropped it across all four places it was declared
   * because NONE of them was ever written — so the distinction the two tests
   * drew is not expressible, and neither is the fixture that set it up.
   *
   * Behaviour is unchanged in practice: the field being always absent means
   * every credit was already the "links nowhere" case. What is gone is a
   * refinement that could never fire, and the tests that gave it the appearance
   * of being load-bearing.
   *
   * If a high-confidence credit link is wanted back, it is a schema change
   * (a real `catalog_entity_id` FK on `track_credits`) plus a writer — not a
   * predicate restored in this file.
   */

  it('returns nothing for an artist with no name key rather than matching everything', async () => {
    const artist = await makeArtist({ name: 'No Key' });
    const host = await makeArtist({ name: 'Host', nameKey: 'host' });
    await makeTrack(host.id, {
      credits: [{ name: 'No Key', role: 'artist', nameKey: 'no key' }],
    });

    // The absent key is expressed on the SOURCE the function takes, not by
    // unsetting a column: `nameKey` is optional on `ArtistProfileSource`
    // precisely so a caller that failed to load it is the case under test.
    // A credit that WOULD match by name exists, so this fails if the guard goes.
    expect(await loadCreditedOn({ ...artist, nameKey: undefined })).toEqual([]);
  });
});

// ── Playlists ─────────────────────────────────────────────────────────────────

describe('loadCreditedOn — the cap counts TRACKS, not credit rows', () => {
  /**
   * The review's finding: `credits.nameKey` is one-to-many, so a `LIMIT` over
   * the joined shape bounds credit ROWS. Mongo bounded 50 documents and folded
   * roles afterwards. Without the two-query form, an artist credited twice on
   * every track gets half a shelf — and the shortfall scales with how rich
   * their credits are, which is the opposite of the intent.
   *
   * Two roles per track, so a row-bounded implementation returns half as many.
   */
  it('returns a full page of tracks even when each carries several roles', async () => {
    const guest = await makeArtist({ name: 'Busy Guest', nameKey: 'busy guest' });
    const host = await makeArtist({ name: 'Prolific Host', nameKey: 'prolific host' });

    const wanted = 8;
    for (let i = 0; i < wanted; i += 1) {
      await makeTrack(host.id, {
        credits: [
          { name: 'Busy Guest', role: 'producer', nameKey: 'busy guest' },
          { name: 'Busy Guest', role: 'composer', nameKey: 'busy guest' },
        ],
      });
    }

    const credited = await loadCreditedOn(guest);

    expect(credited).toHaveLength(wanted);
    // …and the roles still fold, so this is not passing by dropping the join.
    expect(credited[0]?.roles.sort()).toEqual(['composer', 'producer']);
  });
});

describe('loadPlaylistsFeaturing — readability is canViewPlaylist\'s decision', () => {
  it('includes a public playlist that contains one of the artist\'s tracks', async () => {
    const artist = await makeArtist();
    const trackId = await makeTrack(artist.id);
    const playlistId = await makePlaylist([trackId]);

    const playlists = await loadPlaylistsFeaturing(artist.id);
    expect(ids(playlists)).toEqual([playlistId]);
  });

  it('hides a PRIVATE playlist from a guest but shows it to its owner', async () => {
    const artist = await makeArtist();
    const trackId = await makeTrack(artist.id);
    const playlistId = await makePlaylist([trackId], {
      visibility: PlaylistVisibility.PRIVATE,
      ownerOxyUserId: 'curator-1',
    });

    expect(await loadPlaylistsFeaturing(artist.id)).toEqual([]);
    expect(ids(await loadPlaylistsFeaturing(artist.id, 'curator-1'))).toEqual([playlistId]);
  });

  it('shows a private playlist to a collaborator', async () => {
    const artist = await makeArtist();
    const trackId = await makeTrack(artist.id);
    const playlistId = await makePlaylist([trackId], {
      visibility: PlaylistVisibility.PRIVATE,
      ownerOxyUserId: 'curator-1',
      collaborators: ['friend-2'],
    });

    expect(ids(await loadPlaylistsFeaturing(artist.id, 'friend-2'))).toEqual([playlistId]);
  });

  it('excludes a playlist whose tracks are all taken down', async () => {
    const artist = await makeArtist();
    const trackId = await makeTrack(artist.id);
    await makePlaylist([trackId]);
    await getDb()
      .update(tracks)
      .set({ copyrightRemoved: true, isAvailable: false })
      .where(eq(tracks.id, trackId));

    expect(await loadPlaylistsFeaturing(artist.id)).toEqual([]);
  });

  it('is empty for an artist with no playable tracks at all', async () => {
    const artist = await makeArtist();
    expect(await loadPlaylistsFeaturing(artist.id)).toEqual([]);
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
    // `sources` is supplied on the SOURCE rather than seeded into
    // `catalog_entity_sources`: `loadProfileState` reads it off its argument,
    // which is what lets the caller pass the provenance it already loaded
    // instead of this function issuing a second query for it.
    const artist = {
      ...(await makeArtist()),
      sources: [
        { provider: 'cc' as const, externalId: 'mb-1', importedAt: '2026-01-01', fields: ['bio', 'country'] },
        { provider: 'cc' as const, externalId: 'wd-1', importedAt: '2026-01-02', fields: ['country', 'image'] },
      ],
    };

    const state = await loadProfileState(artist, []);
    expect(state.externallySourcedFields.sort()).toEqual(['bio', 'country', 'image']);
  });

  it('separates tracks a third party contributed from the artist\'s own', async () => {
    const artist = await makeArtist();
    const own = await makeTrack(artist.id);
    const contributed = await makeTrack(artist.id);
    await getDb().insert(contributionAttestations).values({
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
    const artistId = artist.id;

    const albumId = await makeAlbum(artistId, { type: 'ep' });
    const ownTrack = await makeTrack(artistId, { albumId });

    const host = await makeArtist({ name: 'Host', nameKey: 'host' });
    await makeTrack(host.id, {
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
