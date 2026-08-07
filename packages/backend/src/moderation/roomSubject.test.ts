import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../test/mongo';
import { connectDb, clearDb, disconnectDb } from '../test/postgres';
import RoomModel, { RoomStatus, RoomType, OwnerType } from '../models/Room';
import RecordingModel, { RecordingStatus, RecordingAccess } from '../models/Recording';
import { uuidv7 } from '@oxyhq/db';
import { getDb } from '../db/postgres';
import { catalogEntities, tracks } from '../db/schema/catalog';
import { playlists } from '../db/schema/library';
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

// Both stores: rooms and recordings are still Mongoose (Task 14), playlists are
// on Postgres since Task 11, and this file exercises providers for all three.
beforeAll(async () => {
  await connect();
  await connectDb();
});
afterEach(async () => {
  await clear();
  await clearDb();
});
afterAll(async () => {
  await disconnect();
  await disconnectDb();
});

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

  /**
   * The credential question, not the disclosure one.
   *
   * `rtmpStreamKey` + `rtmpUrl` are what a broadcaster authenticates with, so a
   * juror who read them could broadcast into the very room they were asked to
   * judge. This is the test that keeps the provider's projection a whitelist: it
   * fails if anyone widens it to a bare `findById()`.
   */
  it('never carries the RTMP stream credential a juror could broadcast with', async () => {
    const room = await makeRoom({
      rtmpUrl: 'rtmp://ingress.example/live',
      rtmpStreamKey: 'sk_live_super_secret_stream_key',
      activeStreamUrl: 'https://cdn.example/stream.m3u8',
    });

    const snapshot = await provider?.snapshot(String(room._id));
    const serialised = JSON.stringify(snapshot);

    expect(serialised).not.toContain('sk_live_super_secret_stream_key');
    expect(serialised).not.toContain('rtmp://ingress.example/live');
    expect(serialised).not.toContain('rtmpStreamKey');
    // The report is still a real report — the room's own text survives.
    expect(snapshot?.content).toMatchObject({ data: { title: 'Late night talk' } });
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

  async function makePlaylist(over: Partial<typeof playlists.$inferInsert>) {
    const [row] = await getDb()
      .insert(playlists)
      .values({ name: 'Mix', ownerOxyUserId: 'oxy-user-9', ownerUsername: 'owner9', ...over })
      .returning({ id: playlists.id });
    return row.id;
  }

  /**
   * A private playlist has no audience, so a report about one either came from its
   * owner — who can simply edit it — or from somebody who should not have seen it.
   * Handing it to a jury of strangers would disclose more than the report ever
   * justified.
   */
  it('declines a private playlist', async () => {
    const id = await makePlaylist({ name: 'Private mix', visibility: 'private' });
    expect(await playlistProvider?.snapshot(id)).toBeNull();
  });

  it('declines an unlisted playlist, which is not public either', async () => {
    const id = await makePlaylist({ name: 'Unlisted mix', visibility: 'unlisted' });
    expect(await playlistProvider?.snapshot(id)).toBeNull();
  });

  it('declines an id that names no playlist, without an id-shape guard', async () => {
    // The Mongo provider opened with `mongoose.isValidObjectId`, which rejected
    // every uuid v7 the catalogue mints today. `playlists.id` is `text`, so the
    // query answers both cases: a malformed id and a well-formed unknown one.
    expect(await playlistProvider?.snapshot('not-an-object-id')).toBeNull();
    expect(await playlistProvider?.snapshot('01936f00-0000-7000-8000-000000000000')).toBeNull();
  });

  it('describes a public playlist and names its owner', async () => {
    const id = await makePlaylist({
      name: 'Public mix',
      description: 'Words the owner wrote',
      visibility: 'public',
    });
    const snapshot = await playlistProvider?.snapshot(id);
    expect(snapshot?.subject.author?.oxyUserId).toBe('oxy-user-9');
    expect(snapshot?.content).toMatchObject({
      type: 'listing',
      data: { title: 'Public mix', description: 'Words the owner wrote' },
    });
  });
});

describe('the catalog providers scope the discriminator', () => {
  /**
   * `catalog_entities` holds artists AND persons in one table. `ArtistModel` is
   * a Mongoose discriminator, so every query through it carried `type: 'artist'`
   * implicitly; drizzle adds nothing, so both providers that read it have to
   * write the filter out.
   *
   * EVERY fixture here is a `person` behind an id an artist would be expected
   * at, because that is the only shape that tells the scoped query from the
   * unscoped one — a fixture set containing only artists passes either way.
   * The Task 11 review found `trackProvider` missing the filter while
   * `artistProvider`, 85 lines above it, had it.
   */
  const artistProvider = subjectProviderFor(ReportedType.ARTIST);
  const trackProvider = subjectProviderFor(ReportedType.TRACK);

  async function makeEntity(type: 'artist' | 'person', over: Partial<typeof catalogEntities.$inferInsert> = {}) {
    const id = uuidv7();
    await getDb().insert(catalogEntities).values({
      id,
      type,
      name: `${type} name`,
      nameKey: id,
      source: 'upload',
      claimedByOxyUserId: `oxy-${type}-claimant`,
      ...over,
    });
    return id;
  }

  async function makeTrack(artistId: string) {
    const id = uuidv7();
    await getDb()
      .insert(tracks)
      .values({ id, title: 'A track', artistId, artistName: 'whoever', duration: 100, source: 'upload' });
    return id;
  }

  it('artistProvider declines a person reported as an artist profile', async () => {
    expect(await artistProvider?.snapshot(await makeEntity('person'))).toBeNull();
  });

  it('artistProvider still describes a real artist', async () => {
    const snapshot = await artistProvider?.snapshot(await makeEntity('artist'));
    expect(snapshot?.subject.author?.oxyUserId).toBe('oxy-artist-claimant');
  });

  /**
   * The one the review caught. A track whose `artist_id` names a person must
   * NOT name that person as the report's author — the whole point of an author
   * on a moderation subject is that it is who published the thing.
   */
  it('trackProvider names no author when the track points at a person', async () => {
    const snapshot = await trackProvider?.snapshot(await makeTrack(await makeEntity('person')));

    expect(snapshot?.subject.author).toBeUndefined();
    // And the person's name is not handed to the jury as context either.
    expect(JSON.stringify(snapshot?.context ?? [])).not.toContain('person name');
  });

  it('trackProvider still names the artist when the track points at one', async () => {
    const snapshot = await trackProvider?.snapshot(await makeTrack(await makeEntity('artist')));

    expect(snapshot?.subject.author?.oxyUserId).toBe('oxy-artist-claimant');
    expect(JSON.stringify(snapshot?.context ?? [])).toContain('artist name');
  });
});
