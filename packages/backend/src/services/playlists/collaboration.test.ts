import { beforeAll, afterAll, afterEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { connectDb, clearDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { playlists, playlistCollaborators } from '../../db/schema/library';
import { playlistInvites } from '../../db/schema/playlist-sharing';
import { changePlaylistMember, createPlaylistInvite, joinPlaylist, lockPlaylistForEdit, readPlaylistActivity, revokePlaylistInvites } from './collaboration';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

async function makePlaylist() {
  const [row] = await getDb().insert(playlists).values({ name: 'Shared', ownerOxyUserId: 'owner', ownerUsername: 'Owner', visibility: 'private' }).returning({ id: playlists.id });
  if (!row) throw new Error('Missing playlist fixture');
  return row.id;
}

async function members(id: string) {
  return getDb().select().from(playlistCollaborators).where(eq(playlistCollaborators.playlistId, id));
}

describe('explicit playlist collaboration', () => {
  it('only the owner can issue invitations, and issuance does not expose private content or add a member', async () => {
    const id = await makePlaylist();
    await expect(createPlaylistInvite(id, 'stranger', 'editor')).rejects.toMatchObject({ status: 403 });
    const grant = await createPlaylistInvite(id, 'owner', 'editor');
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [stored] = await getDb().select({ hash: playlistInvites.tokenHash }).from(playlistInvites).where(eq(playlistInvites.playlistId, id));
    expect(stored.hash).not.toBe(grant.token);
    expect(stored.hash).toHaveLength(64);
    expect(await members(id)).toHaveLength(0);
    await expect(readPlaylistActivity(id, 'stranger')).rejects.toMatchObject({ status: 403 });
  });

  it('acceptance is idempotent even when two requests arrive together, and another link cannot escalate a viewer', async () => {
    const id = await makePlaylist();
    const viewer = await createPlaylistInvite(id, 'owner', 'viewer');
    await Promise.all([joinPlaylist(viewer.token, 'member', 'Member'), joinPlaylist(viewer.token, 'member', 'Member')]);
    expect(await members(id)).toHaveLength(1);
    const editor = await createPlaylistInvite(id, 'owner', 'editor');
    await joinPlaylist(editor.token, 'member', 'Member');
    expect((await members(id))[0].role).toBe('viewer');
    await expect(getDb().transaction((tx) => lockPlaylistForEdit(tx, id, 'member'))).rejects.toMatchObject({ status: 403 });
    await changePlaylistMember(id, 'owner', 'member', 'editor');
    await getDb().transaction((tx) => lockPlaylistForEdit(tx, id, 'member'));
    await expect(createPlaylistInvite(id, 'member', 'editor')).rejects.toMatchObject({ status: 403 });
    const events = (await readPlaylistActivity(id, 'member')).items;
    expect(events.filter((event) => event.action === 'member_joined')).toHaveLength(1);
    expect(events.some((event) => event.action === 'role_changed')).toBe(true);
  });

  it('refuses expired and tampered grants, and revocation invalidates pending links', async () => {
    const id = await makePlaylist();
    const expired = await createPlaylistInvite(id, 'owner', 'editor');
    await getDb().update(playlistInvites).set({ expiresAt: new Date(0) }).where(eq(playlistInvites.playlistId, id));
    await expect(joinPlaylist(expired.token, 'member', 'Member')).rejects.toMatchObject({ status: 404 });
    await expect(joinPlaylist('x'.repeat(43), 'member', 'Member')).rejects.toMatchObject({ status: 404 });
    const valid = await createPlaylistInvite(id, 'owner', 'viewer');
    await revokePlaylistInvites(id, 'owner');
    await expect(joinPlaylist(valid.token, 'member', 'Member')).rejects.toMatchObject({ status: 404 });
  });

  it('removal cannot be undone with a previously shared link and the removed member loses private activity access', async () => {
    const id = await makePlaylist();
    const grant = await createPlaylistInvite(id, 'owner', 'editor');
    await joinPlaylist(grant.token, 'member', 'Member');
    await expect(changePlaylistMember(id, 'member', 'owner', null)).rejects.toMatchObject({ status: 403 });
    await changePlaylistMember(id, 'owner', 'member', null);
    await expect(joinPlaylist(grant.token, 'member', 'Member')).rejects.toMatchObject({ status: 404 });
    await expect(readPlaylistActivity(id, 'member')).rejects.toMatchObject({ status: 403 });
    expect(await members(id)).toHaveLength(0);
  });

  it('bounds active links and does not allow more than fifty collaborators', async () => {
    const id = await makePlaylist();
    const grant = await createPlaylistInvite(id, 'owner', 'viewer');
    for (let index = 1; index < 10; index += 1) await createPlaylistInvite(id, 'owner', 'viewer');
    await expect(createPlaylistInvite(id, 'owner', 'viewer')).rejects.toMatchObject({ status: 409 });
    await getDb().insert(playlistCollaborators).values(Array.from({ length: 50 }, (_, index) => ({ playlistId: id, oxyUserId: `member-${index}`, username: `Member ${index}`, role: 'viewer' as const, addedAt: new Date() })));
    await expect(joinPlaylist(grant.token, 'extra', 'Extra')).rejects.toMatchObject({ status: 409 });
    await joinPlaylist(grant.token, 'member-0', 'Member 0');
    expect(await members(id)).toHaveLength(50);
    await expect(changePlaylistMember(id, 'owner', 'owner', 'viewer')).rejects.toMatchObject({ status: 400 });
  });

  it('a permission check queued behind revocation sees the new role', async () => {
    const id = await makePlaylist();
    const invite = await createPlaylistInvite(id, 'owner', 'editor');
    await joinPlaylist(invite.token, 'member', 'Member');
    let unlock: (() => void) | undefined;
    let locked: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const revoked = getDb().transaction(async (tx) => {
      await lockPlaylistForEdit(tx, id, 'owner', true);
      locked?.();
      await new Promise<void>((resolve) => { unlock = resolve; });
      await tx.delete(playlistCollaborators).where(and(eq(playlistCollaborators.playlistId, id), eq(playlistCollaborators.oxyUserId, 'member')));
    });
    await ready;
    const editing = getDb().transaction((tx) => lockPlaylistForEdit(tx, id, 'member'));
    unlock?.();
    await revoked;
    await expect(editing).rejects.toMatchObject({ status: 403 });
  });
});
