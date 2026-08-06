import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { and, asc, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities, catalogEntityStrikes, tracks } from '../db/schema/catalog';
import { isPlayableTrack, playableTrackFilter } from '../db/catalog/visibility';
import {
  addStrike,
  removeStrike,
  checkUploadPermission,
  isRepeatInfringer,
  STRIKE_TERMINATION_THRESHOLD,
} from './strikeService';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeArtist(
  overrides: Partial<typeof catalogEntities.$inferInsert> = {}
): Promise<string> {
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: 'Test Artist',
      // Unique per fixture: `catalog_entities_artist_name_key_key` is a unique
      // partial index on `name_key` for artists, so two same-named fixtures in
      // one test collide.
      nameKey: `test-artist-${uuidv7()}`,
      statsFollowers: 0,
      statsAlbums: 0,
      statsTracks: 0,
      statsTotalPlays: 0,
      source: 'upload',
      ...overrides,
    })
    .returning({ id: catalogEntities.id });

  if (!artist) throw new Error('makeArtist: insert returned no row');
  return artist.id;
}

async function makeTrack(artistId: string): Promise<string> {
  const [track] = await getDb()
    .insert(tracks)
    .values({
      title: 'Test Track',
      artistId,
      artistName: 'Test Artist',
      duration: 180,
      source: 'upload',
      status: 'ready',
    })
    .returning({ id: tracks.id });

  if (!track) throw new Error('makeTrack: insert returned no row');
  return track.id;
}

async function readArtist(artistId: string) {
  const [artist] = await getDb()
    .select()
    .from(catalogEntities)
    .where(eq(catalogEntities.id, artistId))
    .limit(1);
  return artist;
}

async function readTrack(trackId: string) {
  const [track] = await getDb().select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
  return track;
}

/** An id shaped like a real one that no row carries. */
function missingId(): string {
  return uuidv7();
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

// ── STRIKE_TERMINATION_THRESHOLD ──────────────────────────────────────────────

describe('STRIKE_TERMINATION_THRESHOLD', () => {
  it('equals 3', () => {
    expect(STRIKE_TERMINATION_THRESHOLD).toBe(3);
  });
});

// ── isRepeatInfringer ─────────────────────────────────────────────────────────

describe('isRepeatInfringer', () => {
  it('returns false when strikeCount below threshold', () => {
    expect(isRepeatInfringer(2)).toBe(false);
    expect(isRepeatInfringer(0)).toBe(false);
  });

  it('returns true at threshold', () => {
    expect(isRepeatInfringer(STRIKE_TERMINATION_THRESHOLD)).toBe(true);
  });

  it('returns true above threshold', () => {
    expect(isRepeatInfringer(5)).toBe(true);
  });
});

// ── addStrike — termination at third strike ───────────────────────────────────

describe('addStrike — termination', () => {
  it('terminates artist and takes down tracks on third strike', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);

    // Two strikes — not yet terminated
    await addStrike(artistId, 'first infringement');
    await addStrike(artistId, 'second infringement');

    const afterTwo = await readArtist(artistId);
    expect(afterTwo?.terminated).toBe(false);
    expect(afterTwo?.uploadsDisabled).toBe(false);

    // Third strike — termination fires
    const result = await addStrike(artistId, 'third infringement', trackId);
    expect(result).not.toBeNull();
    expect(result?.strikeCount).toBe(3);
    expect(result?.terminated).toBe(true);

    const artist = await readArtist(artistId);
    expect(artist?.terminated).toBe(true);
    expect(artist?.terminatedAt).toBeInstanceOf(Date);
    expect(typeof artist?.terminationReason).toBe('string');
    expect(artist?.uploadsDisabled).toBe(true);

    // Track taken down
    const track = await readTrack(trackId);
    expect(track?.copyrightRemoved).toBe(true);
    expect(track?.removedAt).toBeInstanceOf(Date);
    expect(track?.removedReason).toContain('Repeat-infringer');
  });

  it('does not terminate before third strike', async () => {
    const artistId = await makeArtist();

    await addStrike(artistId, 'first infringement');
    const artist = await readArtist(artistId);
    expect(artist?.terminated).toBeFalsy();
    expect(artist?.strikeCount).toBe(1);
  });

  it('takes down ALL artist tracks (not just strike-associated track)', async () => {
    const artistId = await makeArtist();
    const track1 = await makeTrack(artistId);
    const track2 = await makeTrack(artistId);

    await addStrike(artistId, 'infringement 1');
    await addStrike(artistId, 'infringement 2');
    await addStrike(artistId, 'infringement 3');

    const [t1, t2] = await Promise.all([readTrack(track1), readTrack(track2)]);
    expect(t1?.copyrightRemoved).toBe(true);
    expect(t2?.copyrightRemoved).toBe(true);
  });

  /**
   * The one shape the partial indexes on `tracks` cannot serve, and the reason
   * migration 0017 exists: a track that is UNPUBLISHED (`is_available = false`)
   * but not yet copyright-removed must still be marked removed by a termination.
   * A version of `takeDownArtistTracks` narrowed to satisfy the partial index —
   * by adding `is_available = true` — passes every other test in this file and
   * leaves exactly this track behind.
   */
  it('takes down an unpublished track too, not only the listed ones', async () => {
    const artistId = await makeArtist();
    const unpublished = await makeTrack(artistId);
    await getDb().update(tracks).set({ isAvailable: false }).where(eq(tracks.id, unpublished));

    await addStrike(artistId, 'infringement 1');
    await addStrike(artistId, 'infringement 2');
    await addStrike(artistId, 'infringement 3');

    const track = await readTrack(unpublished);
    expect(track?.copyrightRemoved).toBe(true);
    expect(track?.removedReason).toContain('Repeat-infringer');
  });

  it('returns null for unknown artistId', async () => {
    const result = await addStrike(missingId(), 'reason');
    expect(result).toBeNull();
  });

  /**
   * A person row is not an artist. `catalog_entities` holds both, and Mongoose's
   * discriminator used to add `type` to every query invisibly — so a strike
   * against a person id must find nothing rather than silently writing artist
   * columns onto a person.
   */
  it('returns null for a person id, not a strike against a person row', async () => {
    const [person] = await getDb()
      .insert(catalogEntities)
      .values({ type: 'person', name: 'A Person', nameKey: `person-${uuidv7()}` })
      .returning({ id: catalogEntities.id });

    expect(await addStrike(person?.id ?? '', 'reason')).toBeNull();
    expect(await checkUploadPermission(person?.id ?? '')).toBe(false);
  });

  /**
   * The catalog filter keys off `isAvailable`, the playback gate off
   * `copyrightRemoved`. A takedown that sets only the latter leaves the track
   * listed and searchable but unplayable, so termination must set BOTH — the same
   * pair the single-report takedown in copyright.controller writes.
   */
  it('marks taken-down tracks unavailable so they leave the catalog, not just playback', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);

    await addStrike(artistId, 'infringement 1');
    await addStrike(artistId, 'infringement 2');
    await addStrike(artistId, 'infringement 3');

    const track = await readTrack(trackId);
    expect(track?.copyrightRemoved).toBe(true);
    expect(track?.isAvailable).toBe(false);
  });

  it('excludes taken-down tracks from the catalog filter', async () => {
    const artistId = await makeArtist();
    await makeTrack(artistId);

    await addStrike(artistId, 'infringement 1');
    await addStrike(artistId, 'infringement 2');
    await addStrike(artistId, 'infringement 3');

    const visible = await getDb()
      .select({ id: tracks.id })
      .from(tracks)
      .where(and(eq(tracks.artistId, artistId), playableTrackFilter()));
    expect(visible).toHaveLength(0);
  });

  /**
   * Repairs already-struck tracks without a backfill: a track carrying the OLD
   * takedown shape (copyrightRemoved only, isAvailable still true) must not be
   * served by the catalog either.
   */
  it('excludes a legacy takedown that set copyrightRemoved but left isAvailable true', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    await getDb()
      .update(tracks)
      .set({ copyrightRemoved: true, isAvailable: true })
      .where(eq(tracks.id, trackId));

    const visible = await getDb()
      .select({ id: tracks.id })
      .from(tracks)
      .where(and(eq(tracks.artistId, artistId), playableTrackFilter()));
    expect(visible).toHaveLength(0);
    expect(isPlayableTrack({ isAvailable: true, copyrightRemoved: true })).toBe(false);
  });

  /**
   * `strikeCount` is counted from `catalog_entity_strikes` rather than
   * incremented, so a column that has drifted out of step with the rows is
   * repaired by the next write rather than compounding. The Mongo version
   * incremented on add and recomputed on remove, so the two disagreed forever
   * once they diverged.
   */
  it('recomputes strikeCount from the rows, repairing a drifted counter', async () => {
    const artistId = await makeArtist();
    await addStrike(artistId, 'infringement 1');

    await getDb()
      .update(catalogEntities)
      .set({ strikeCount: 47 })
      .where(eq(catalogEntities.id, artistId));

    await addStrike(artistId, 'infringement 2');

    const artist = await readArtist(artistId);
    expect(artist?.strikeCount).toBe(2);
  });
});

// ── checkUploadPermission — terminated blocks upload ─────────────────────────

describe('checkUploadPermission', () => {
  it('returns true when no strikes', async () => {
    const artistId = await makeArtist();
    expect(await checkUploadPermission(artistId)).toBe(true);
  });

  it('returns false when uploadsDisabled', async () => {
    const artistId = await makeArtist({ uploadsDisabled: true });
    expect(await checkUploadPermission(artistId)).toBe(false);
  });

  it('returns false when terminated (even if uploadsDisabled not set separately)', async () => {
    const artistId = await makeArtist({ terminated: true, uploadsDisabled: true });
    expect(await checkUploadPermission(artistId)).toBe(false);
  });

  it('returns false for unknown artist', async () => {
    expect(await checkUploadPermission(missingId())).toBe(false);
  });
});

// ── removeStrike — does NOT un-terminate ─────────────────────────────────────

describe('removeStrike — does not un-terminate', () => {
  it('removing a strike from terminated artist keeps terminated=true', async () => {
    const artistId = await makeArtist();

    await addStrike(artistId, 'infringement 1');
    await addStrike(artistId, 'infringement 2');
    const result = await addStrike(artistId, 'infringement 3');

    expect(result?.terminated).toBe(true);

    const [firstStrike] = await getDb()
      .select({ id: catalogEntityStrikes.id })
      .from(catalogEntityStrikes)
      .where(eq(catalogEntityStrikes.catalogEntityId, artistId))
      .orderBy(asc(catalogEntityStrikes.createdAt))
      .limit(1);
    expect(firstStrike?.id).toBeTruthy();

    if (firstStrike) {
      await removeStrike(artistId, firstStrike.id);
    }

    const after = await readArtist(artistId);
    expect(after?.terminated).toBe(true);
    expect(after?.terminatedAt).toBeInstanceOf(Date);
    expect(after?.strikeCount).toBe(2);
  });

  /**
   * The strike id is scoped to the artist it is removed from. Without the
   * `catalog_entity_id` condition, an admin endpoint for artist A could delete
   * artist B's moderation history by id.
   */
  it('will not remove a strike belonging to a different artist', async () => {
    const [victim, other] = await Promise.all([makeArtist(), makeArtist()]);
    await addStrike(victim, 'infringement');
    await addStrike(other, 'unrelated');

    const [victimStrike] = await getDb()
      .select({ id: catalogEntityStrikes.id })
      .from(catalogEntityStrikes)
      .where(eq(catalogEntityStrikes.catalogEntityId, victim))
      .limit(1);

    await removeStrike(other, victimStrike?.id ?? '');

    const remaining = await getDb()
      .select({ id: catalogEntityStrikes.id })
      .from(catalogEntityStrikes)
      .where(eq(catalogEntityStrikes.catalogEntityId, victim));
    expect(remaining).toHaveLength(1);
  });
});
