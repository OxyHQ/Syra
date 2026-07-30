import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../test/mongo';
import RoomModel, { RoomStatus, RoomType, OwnerType } from '../models/Room';
import RecordingModel, { RecordingStatus, RecordingAccess } from '../models/Recording';
import { PlaylistModel } from '../models/Playlist';
import { subjectProviderFor } from './subjects/registry';
import { ReportedType } from '../models/Report';
import type { ModerationResource } from './subjects/types';

/**
 * What a room report does and does not carry.
 *
 * This is the file that holds the answer to "a live room is too ephemeral to
 * report". It is not: the host-authored text is durable and answerable. What is
 * withheld is the conversation and the recording, and each omission is asserted
 * rather than left to a comment, because both are the kind of thing a later
 * change would quietly add.
 */

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

const HOST = 'oxy-host-1';

async function makeRoom(overrides: Record<string, unknown> = {}) {
  return await RoomModel.create({
    title: 'Late night talk',
    description: 'A description the host wrote',
    topic: 'music',
    tags: ['jazz', 'live'],
    host: HOST,
    ownerType: OwnerType.PROFILE,
    type: RoomType.TALK,
    status: RoomStatus.LIVE,
    participants: ['listener-a', 'listener-b'],
    speakers: ['speaker-a'],
    streamTitle: 'Stream title',
    streamDescription: 'Stream description',
    ...overrides,
  });
}

const provider = subjectProviderFor(ReportedType.ROOM);

describe('room subject provider', () => {
  it('is registered', () => {
    expect(provider).toBeDefined();
  });

  it('pins the host-authored text and names the host as author', async () => {
    const room = await makeRoom();
    const snapshot = await provider?.snapshot(String(room._id));

    expect(snapshot).not.toBeNull();
    expect(snapshot?.subject.type).toBe('custom.syra.room');
    expect(snapshot?.subject.externalId).toBe(String(room._id));
    // The host wrote the title and description, so the host is answerable for them.
    expect(snapshot?.subject.author?.oxyUserId).toBe(HOST);

    const content = snapshot?.content as ModerationResource;
    expect(content.type).toBe('metadata');
    expect(content).toMatchObject({
      data: {
        title: 'Late night talk',
        description: 'A description the host wrote\n\nStream description',
        topicAndTags: 'music, jazz, live',
        streamTitle: 'Stream title',
      },
    });
  });

  /**
   * The participant list changes every few seconds, so pinning it would describe
   * a roster that was never true of the session as a whole — and it would name
   * people who did nothing but listen. Neither participants nor speakers may
   * appear anywhere in the snapshot.
   */
  it('never carries the participant or speaker list', async () => {
    const room = await makeRoom();
    const snapshot = await provider?.snapshot(String(room._id));
    const serialised = JSON.stringify(snapshot);

    expect(serialised).not.toContain('listener-a');
    expect(serialised).not.toContain('listener-b');
    expect(serialised).not.toContain('speaker-a');
    expect(snapshot?.content).toMatchObject({ data: { participantsIncluded: false } });
  });

  /**
   * Syra records rooms by default and keeps them for months, so the temptation to
   * attach one is real. It is refused on a privacy argument AND a mechanical one:
   * recordings live in object storage addressed by `objectKey` with no digest, so
   * there is no bare Oxy `fileId` an `AssetRef` could carry — only a URL on Syra's
   * own host, which evidence must never be.
   *
   * The EXISTENCE is declared, so a jury can answer `insufficient_context` for the
   * right reason instead of assuming the title was all there was.
   */
  it('declares that a recording exists without attaching it', async () => {
    const room = await makeRoom();
    await RecordingModel.create({
      roomId: String(room._id),
      roomTitle: room.title,
      host: HOST,
      status: RecordingStatus.READY,
      egressId: 'egress-1',
      objectKey: 'recordings/room-1.ogg',
      startedAt: new Date(),
      access: RecordingAccess.PUBLIC,
      expiresAt: new Date(Date.now() + 1_000_000),
    });

    const snapshot = await provider?.snapshot(String(room._id));
    expect(snapshot?.content).toMatchObject({
      data: { recordingExists: true, recordingAttached: false },
    });
    // No attachment, and nothing that could be dereferenced back to Syra.
    expect(snapshot?.attachments).toBeUndefined();
    const serialised = JSON.stringify(snapshot);
    expect(serialised).not.toContain('objectKey');
    expect(serialised).not.toContain('recordings/room-1.ogg');
    expect(serialised).not.toContain('egress-1');
  });

  it('says so plainly when there is no recording', async () => {
    const room = await makeRoom();
    const snapshot = await provider?.snapshot(String(room._id));
    expect(snapshot?.content).toMatchObject({ data: { recordingExists: false } });
  });

  it('returns null for a deleted room and for an id that is not one', async () => {
    expect(await provider?.snapshot(new mongoose.Types.ObjectId().toHexString())).toBeNull();
    expect(await provider?.snapshot('not-an-object-id')).toBeNull();
  });
});

describe('playlist subject provider', () => {
  const playlistProvider = subjectProviderFor(ReportedType.PLAYLIST);

  /**
   * A private playlist has no audience, so a report about one either came from its
   * owner — who can simply edit it — or from somebody who should not have seen it.
   * Handing it to a jury of strangers would disclose more than the report ever
   * justified.
   */
  it('declines a private playlist', async () => {
    const playlist = await PlaylistModel.create({
      name: 'Private mix',
      ownerOxyUserId: 'oxy-user-9',
      ownerUsername: 'owner9',
      visibility: 'private',
    });
    expect(await playlistProvider?.snapshot(String(playlist._id))).toBeNull();
  });

  it('describes a public playlist and names its owner', async () => {
    const playlist = await PlaylistModel.create({
      name: 'Public mix',
      description: 'Words the owner wrote',
      ownerOxyUserId: 'oxy-user-9',
      ownerUsername: 'owner9',
      visibility: 'public',
    });
    const snapshot = await playlistProvider?.snapshot(String(playlist._id));
    expect(snapshot?.subject.author?.oxyUserId).toBe('oxy-user-9');
    expect(snapshot?.content).toMatchObject({
      type: 'listing',
      data: { title: 'Public mix', description: 'Words the owner wrote' },
    });
  });
});
