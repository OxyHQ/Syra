import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { uuidv7 } from '@oxy.so/db';
import { eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { catalogEntities, tracks } from '../../db/schema/catalog';
import { playlists, playlistTracks, playlistCollaborators, userLikedTracks, userFollowedArtists } from '../../db/schema/library';
import { tasteMixes } from '../../db/schema/listener-tools';
import { notificationPreferences, userMusicPreferences } from '../../db/schema/user';
import { readCuratedPlaylists, selectCuratedPlaylists } from './curated-playlists';
import { previewPlaylistImport, commitPlaylistImport } from './playlist-import';
import { balanceTasteTracks, createTasteMix, joinTasteMix, revokeTasteMix, listTasteMixes } from './taste-mixes';
import { createPlaylistInvite, changePlaylistMember } from '../playlists/collaboration';
import { readDownloadPolicy, setDownloadPolicy, grantDownload } from './downloads';
import { notifyFollowersOfNewRelease, readReleasePreference, setReleasePreference } from './release-notifications';

beforeAll(connectDb);
afterAll(disconnectDb);
afterEach(clearDb);

async function recording(title = 'A recording', owner = 'owner', isExplicit = false) {
  const [artist] = await getDb().insert(catalogEntities).values({ type: 'artist', name: `Artist ${uuidv7()}`, source: 'upload', ownerOxyUserId: owner }).returning({ id: catalogEntities.id });
  if (!artist) throw new Error('Missing artist fixture');
  const [track] = await getDb().insert(tracks).values({ title, artistId: artist.id, artistName: 'Artist', duration: 180, source: 'upload', isExplicit }).returning({ id: tracks.id });
  if (!track) throw new Error('Missing track fixture');
  return { id: track.id, artistId: artist.id };
}
async function playlist(trackId: string, visibility: 'public' | 'private' = 'public', owner = 'owner') {
  const [row] = await getDb().insert(playlists).values({ name: 'Playlist', visibility, ownerOxyUserId: owner, ownerUsername: owner }).returning({ id: playlists.id });
  if (!row) throw new Error('Missing playlist fixture');
  await getDb().insert(playlistTracks).values({ playlistId: row.id, trackId, position: 0, addedAt: new Date(), addedBy: owner });
  return row.id;
}

it('only an artist owner can choose owned public playlists, with an atomic selection change', async () => {
  const track = await recording();
  const first = await playlist(track.id);
  const second = await playlist(track.id);
  const hidden = await playlist(track.id, 'private');
  await expect(selectCuratedPlaylists(track.artistId, 'other', [first])).rejects.toMatchObject({ status: 403 });
  expect((await selectCuratedPlaylists(track.artistId, 'owner', [second, first])).items.map((item) => item.id)).toEqual([second, first]);
  await expect(selectCuratedPlaylists(track.artistId, 'owner', [hidden])).rejects.toMatchObject({ status: 400 });
  expect((await readCuratedPlaylists(track.artistId)).items.map((item) => item.id)).toEqual([second, first]);
  await getDb().update(playlists).set({ visibility: 'private' }).where(eq(playlists.id, second));
  expect((await readCuratedPlaylists(track.artistId)).items.map((item) => item.id)).toEqual([first]);
  await getDb().update(tracks).set({ copyrightRemoved: true }).where(eq(tracks.id, track.id));
  expect((await readCuratedPlaylists(track.artistId)).items).toHaveLength(0);
});

it('metadata preview does not guess ambiguous titles or fall through a wrong strong identifier', async () => {
  const first = await recording('Repeated title');
  await recording('Repeated title');
  await getDb().update(tracks).set({ externalIsrc: 'USABC2600001' }).where(eq(tracks.id, first.id));
  const result = await previewPlaylistImport([
    { title: 'Repeated title', artist: 'Artist' }, { isrc: 'us-abc-26-00001' },
    { catalogId: 'missing', title: 'Repeated title', artist: 'Artist' }, { title: 'No match', artist: 'Artist' },
  ]);
  expect(result.items.map((row) => row.status)).toEqual(['ambiguous', 'matched', 'missing', 'missing']);
  expect(result.items[1].track?.id).toBe(first.id);
  await getDb().update(tracks).set({ copyrightRemoved: true }).where(eq(tracks.id, first.id));
  expect((await previewPlaylistImport([{ catalogId: first.id }])).items[0].status).toBe('missing');
});

it('import confirmations are private, atomic and idempotent, preserving repeated occurrences', async () => {
  const track = await recording();
  const request = uuidv7();
  const [first, retry] = await Promise.all([
    commitPlaylistImport('owner', 'Owner', 'Imported', [track.id, track.id], request),
    commitPlaylistImport('owner', 'Owner', 'Imported', [track.id, track.id], request),
  ]);
  expect(first).toEqual(retry);
  const [row] = await getDb().select().from(playlists).where(eq(playlists.id, first.playlistId));
  expect(row.visibility).toBe('private');
  expect(row.trackCount).toBe(2);
  expect(row.totalDuration).toBe(360);
  expect(await getDb().select().from(playlistTracks)).toHaveLength(2);
  await expect(commitPlaylistImport('owner', 'Owner', 'Different', [track.id], request)).rejects.toMatchObject({ status: 409 });
  await expect(commitPlaylistImport('owner', 'Owner', 'Missing', ['gone'], uuidv7())).rejects.toMatchObject({ status: 409 });
  expect(await getDb().select().from(playlists)).toHaveLength(1);
});

describe('two-person taste consent', () => {
  it('balances overlap and alternating picks with no duplicates', () => {
    expect(balanceTasteTracks(['a', 'b', 'c', 'd'], ['b', 'e', 'f'], 5)).toEqual(['b', 'a', 'e', 'c', 'f']);
    expect(balanceTasteTracks(['a', 'a'], ['a', 'a'], 30)).toEqual(['a']);
    expect(balanceTasteTracks(['a'], ['b'], 0)).toEqual([]);
  });
  it('an invitation alone neither reads nor publishes tastes; join needs both libraries and another person', async () => {
    const invite = await createTasteMix('owner', 'Owner');
    expect(await getDb().select().from(playlists)).toHaveLength(0);
    const [stored] = await getDb().select({ hash: tasteMixes.tokenHash }).from(tasteMixes);
    expect(stored.hash).not.toBe(invite.token);
    await expect(joinTasteMix(invite.token, 'owner', 'Owner')).rejects.toMatchObject({ status: 400 });
    await expect(joinTasteMix(invite.token, 'guest', 'Guest')).rejects.toMatchObject({ status: 409 });
    expect((await listTasteMixes('stranger')).items).toHaveLength(0);
  });
  it('joint mixes honor explicit-content preferences and are private and limited to the two consenting people', async () => {
    const first = await recording('First');
    const second = await recording('Second');
    const explicit = await recording('Explicit', 'owner', true);
    await getDb().insert(userLikedTracks).values([{ oxyUserId: 'owner', trackId: first.id }, { oxyUserId: 'owner', trackId: explicit.id }, { oxyUserId: 'guest', trackId: second.id }]);
    await getDb().insert(userMusicPreferences).values({ oxyUserId: 'guest', explicitContent: false });
    const invite = await createTasteMix('owner', 'Owner');
    const created = await joinTasteMix(invite.token, 'guest', 'Guest');
    expect(await joinTasteMix(invite.token, 'guest', 'Guest')).toEqual(created);
    await expect(joinTasteMix(invite.token, 'stranger', 'Stranger')).rejects.toMatchObject({ status: 409 });
    const [row] = await getDb().select().from(playlists).where(eq(playlists.id, created.playlistId));
    expect(row.visibility).toBe('private');
    expect(row.ownerUsername).toBe('Owner');
    const entries = await getDb().select().from(playlistTracks).where(eq(playlistTracks.playlistId, created.playlistId));
    expect(new Set(entries.map((entry) => entry.trackId))).toEqual(new Set([first.id, second.id]));
    expect(await getDb().select().from(playlistCollaborators)).toHaveLength(1);
    await expect(createPlaylistInvite(created.playlistId, 'owner', 'viewer')).rejects.toMatchObject({ status: 400 });
    await expect(changePlaylistMember(created.playlistId, 'owner', 'guest', null)).rejects.toMatchObject({ status: 400 });
    await expect(revokeTasteMix(invite.id, 'stranger')).rejects.toMatchObject({ status: 404 });
    await revokeTasteMix(invite.id, 'guest');
    expect(await getDb().select().from(playlists)).toHaveLength(0);
    expect(await getDb().select({ id: tasteMixes.id }).from(tasteMixes)).toHaveLength(0);
    expect(await getDb().select().from(playlistCollaborators)).toHaveLength(0);
  });
  it('limits live invitations and rejects expired or revoked tokens', async () => {
    const first = await createTasteMix('owner', 'Owner');
    for (let index = 1; index < 5; index += 1) await createTasteMix('owner', 'Owner');
    await expect(createTasteMix('owner', 'Owner')).rejects.toMatchObject({ status: 409 });
    await getDb().update(tasteMixes).set({ expiresAt: new Date(0) }).where(eq(tasteMixes.id, first.id));
    await expect(joinTasteMix(first.token, 'guest', 'Guest')).rejects.toMatchObject({ status: 404 });
    const replacement = await createTasteMix('owner', 'Owner');
    await revokeTasteMix(replacement.id, 'owner');
    await expect(joinTasteMix(replacement.token, 'guest', 'Guest')).rejects.toMatchObject({ status: 404 });
  });
});

it('download grants fail closed before storage access and only the creator can opt in or out', async () => {
  const track = await recording();
  expect(await readDownloadPolicy(track.id, 'listener')).toEqual({ allowed: false, canEdit: false });
  await expect(grantDownload(track.id)).rejects.toMatchObject({ status: 403 });
  await expect(setDownloadPolicy(track.id, 'listener', true)).rejects.toMatchObject({ status: 403 });
  expect(await setDownloadPolicy(track.id, 'owner', true)).toEqual({ allowed: true, canEdit: true });
  // No source has been uploaded in this fixture: entitlement cannot manufacture bytes.
  await expect(grantDownload(track.id)).rejects.toMatchObject({ status: 409 });
  await getDb().update(tracks).set({ copyrightRemoved: true }).where(eq(tracks.id, track.id));
  await expect(readDownloadPolicy(track.id, 'owner')).rejects.toMatchObject({ status: 404 });
  await expect(grantDownload(track.id)).rejects.toMatchObject({ status: 403 });
});

it('release opt-out preserves settings for unrelated events', async () => {
  expect(await readReleasePreference('listener')).toEqual({ enabled: true });
  await getDb().insert(notificationPreferences).values({ oxyUserId: 'listener', disabledEvents: ['episode.published'] });
  await Promise.all([setReleasePreference('listener', false), setReleasePreference('listener', false)]);
  expect(await readReleasePreference('listener')).toEqual({ enabled: false });
  await setReleasePreference('listener', true);
  const [row] = await getDb().select().from(notificationPreferences);
  expect(row.disabledEvents).toEqual(['episode.published']);
});

it('release announcements skip unknown/old/hidden recordings, respect opt-out and coalesce', async () => {
  const first = await recording();
  const published = new Date(Date.now() - 1000);
  await getDb().update(tracks).set({ createdAt: published }).where(eq(tracks.id, first.id));
  await getDb().insert(userFollowedArtists).values([
    { artistId: first.artistId, oxyUserId: 'subscribed', createdAt: new Date(0) },
    { artistId: first.artistId, oxyUserId: 'muted', createdAt: new Date(0) },
    { artistId: first.artistId, oxyUserId: 'new-follower', createdAt: new Date() },
  ]);
  await setReleasePreference('muted', false);
  const original = globalThis.fetch;
  let posted = 0;
  globalThis.fetch = Object.assign(async () => { posted += 1; return new Response(JSON.stringify({ ok: true }), { status: 201 }); }, { preconnect: original.preconnect });
  try {
    const deps = { getToken: async () => 'test-token' };
    expect((await notifyFollowersOfNewRelease(first.id, Date.now(), deps)).emitted).toBe(0);
    await getDb().update(tracks).set({ releaseDate: new Date(0) }).where(eq(tracks.id, first.id));
    expect((await notifyFollowersOfNewRelease(first.id, Date.now(), deps)).emitted).toBe(0);
    await getDb().update(tracks).set({ releaseDate: published, copyrightRemoved: true }).where(eq(tracks.id, first.id));
    expect((await notifyFollowersOfNewRelease(first.id, Date.now(), deps)).emitted).toBe(0);
    await getDb().update(tracks).set({ copyrightRemoved: false }).where(eq(tracks.id, first.id));
    expect((await notifyFollowersOfNewRelease(first.id, Date.now(), deps)).emitted).toBe(1);
    expect((await notifyFollowersOfNewRelease(first.id, Date.now(), deps)).emitted).toBe(0);
    expect(posted).toBe(1);
  } finally { globalThis.fetch = original; }
});
