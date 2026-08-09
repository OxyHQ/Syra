/**
 * A featured guest has an artist page.
 *
 * ## The bug this exists for
 *
 * `playableArtistsWhere` asked one question: does a track's `artist_id` point
 * at this entity? A guest owns nothing — the recording belongs to the
 * principal, and the guest exists only as a `track_credits` row carrying their
 * id — so the answer was no and `GET /api/artists/:id` returned 404.
 *
 * That landed the same day the credits started rendering: the name appeared on
 * every screen, it linked, and the link was dead, for exactly the artists a
 * multi-artist credit exists to surface. The page was not even empty —
 * `artistProfile`'s "credited on" section already renders these tracks. Nothing
 * could reach it.
 *
 * ## Why the fixtures look the way they do
 *
 * Three artists, each on a different side of the predicate, because a fixture
 * set of only owners cannot tell the old condition from the new one, and a set
 * of only guests cannot tell "credits count" from "everything counts":
 *
 *  - an OWNER of a playable track — visible before this change and after it,
 *  - a GUEST who owns nothing and is credited with their id — the new case,
 *  - a NAMED-ONLY credit with a null `catalog_entity_id`, plus an artist of
 *    that same name, which must stay invisible: a name off a file tag is not a
 *    claim that this artist was on the record, and letting it summon a page is
 *    the identity guess the credits schema deliberately refuses.
 *
 * A fourth, credited on an UNPLAYABLE track, pins that the credit path applies
 * the same playability filter as the ownership path — otherwise a takedown
 * would still leave its guests browsable.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { catalogEntities, trackCredits, tracks } from '../../schema/catalog';
import { findOneArtistWithPlayableTracks } from '../containers';

beforeAll(async () => {
  await connectDb();
});
afterEach(async () => {
  await clearDb();
});
afterAll(async () => {
  await disconnectDb();
});

async function makeArtist(name: string, nameKey?: string): Promise<string> {
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({ type: 'artist', name, nameKey: nameKey ?? `k-${uuidv7()}`, source: 'upload' })
    .returning({ id: catalogEntities.id });
  if (!artist) throw new Error('makeArtist: insert returned no row');
  return artist.id;
}

async function makeTrack(ownerId: string, playable: boolean): Promise<string> {
  const [track] = await getDb()
    .insert(tracks)
    .values({
      title: `track-${uuidv7()}`,
      artistId: ownerId,
      artistName: 'owner',
      duration: 100,
      source: 'upload',
      status: 'ready',
      // What `playableTrackFilter` actually reads is `is_available` and
      // `copyright_removed` — NOT `status`. Syra is an own-catalogue platform,
      // so a track is playable iff it is available and not copyright-removed.
      // An earlier version of this fixture flipped `status` instead and the
      // "unplayable" case was not unplayable at all.
      isAvailable: playable,
    })
    .returning({ id: tracks.id });
  if (!track) throw new Error('makeTrack: insert returned no row');
  return track.id;
}

async function credit(trackId: string, name: string, catalogEntityId?: string): Promise<void> {
  await getDb()
    .insert(trackCredits)
    .values({ trackId, position: 0, name, nameKey: name.toLowerCase(), role: 'artist', catalogEntityId });
}

describe('playableArtistsWhere — credited artists', () => {
  it('still finds an artist who OWNS a playable track', async () => {
    const owner = await makeArtist('Principal');
    await makeTrack(owner, true);

    expect((await findOneArtistWithPlayableTracks(owner))?.id).toBe(owner);
  });

  it('finds a guest who owns NOTHING and is credited with their id', async () => {
    const owner = await makeArtist('benny blanco');
    const guest = await makeArtist('Bb trickz');
    const trackId = await makeTrack(owner, true);
    await credit(trackId, 'Bb trickz', guest);

    // The regression this file exists for: 404 before the fix.
    expect((await findOneArtistWithPlayableTracks(guest))?.id).toBe(guest);
  });

  it('does NOT summon a page from a credit that names an artist without claiming them', async () => {
    const owner = await makeArtist('Principal');
    // The artist's key is set to EXACTLY the key the credit carries. Without
    // that the case passes against a name-matching implementation too — the two
    // simply never collide — and the test proves nothing about the rule it is
    // named for. Verified by mutation: matching on `name_key` instead of
    // `catalog_entity_id` must fail HERE.
    const namesake = await makeArtist('Ana Gil', 'ana gil');
    const trackId = await makeTrack(owner, true);
    // Null entity id: a name off a file tag. It matches by NAME and by nothing else.
    await credit(trackId, 'Ana Gil');

    expect(await findOneArtistWithPlayableTracks(namesake)).toBeNull();
  });

  it('does not make a guest browsable through an UNPLAYABLE track', async () => {
    const owner = await makeArtist('Principal');
    const guest = await makeArtist('Invitada');
    const trackId = await makeTrack(owner, false);
    await credit(trackId, 'Invitada', guest);

    expect(await findOneArtistWithPlayableTracks(guest)).toBeNull();
  });

  it('leaves an artist with neither a track nor a credit invisible', async () => {
    const orphan = await makeArtist('Nadie');

    expect(await findOneArtistWithPlayableTracks(orphan)).toBeNull();
  });

  it('keeps a guest visible after their own credit row is the only one left', async () => {
    // Deleting the credit must take the page away again — the predicate has to
    // read the rows, not a state something set once at write time.
    const owner = await makeArtist('Principal');
    const guest = await makeArtist('Invitada');
    const trackId = await makeTrack(owner, true);
    await credit(trackId, 'Invitada', guest);

    expect(await findOneArtistWithPlayableTracks(guest)).not.toBeNull();

    await getDb().delete(trackCredits).where(eq(trackCredits.trackId, trackId));

    expect(await findOneArtistWithPlayableTracks(guest)).toBeNull();
  });
});
