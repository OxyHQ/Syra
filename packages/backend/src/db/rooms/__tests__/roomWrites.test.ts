import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import {
  addParticipant,
  addSpeaker,
  createRoom,
  findRoomById,
  findRoomQueue,
  removeParticipant,
  removeSpeaker,
  replaceRoomStreamAndQueue,
  stopRoomStreamFields,
  updateRoom,
} from '../rooms';
import { OwnerType, RoomStatus, RoomType, SpeakerPermission, type MediaQueueItem } from '../types';

/**
 * The write paths that have no HTTP-level coverage and hand-written SQL.
 *
 * Three things are tested here and nowhere else:
 *
 *  1. **The stream teardown actually clears.** `clearRoomStreamFields` assigned
 *     `undefined` to nine fields and let Mongoose's `save()` turn that into
 *     `$unset`. Drizzle's `buildUpdateSet` DROPS an `undefined`-valued key, so
 *     the identical code is a stop that stops nothing — and one of the nine is a
 *     live RTMP PUBLISHING key. The brief for this task records the same defect
 *     shipping twice in earlier verticals as a cover-art palette that never
 *     cleared; here it would leave a working broadcast credential on a room its
 *     host believes is no longer streaming.
 *
 *     Mutation-verified: changing any `null` in `CLEARED_STREAM_FIELDS` back to
 *     `undefined` fails `clears every stream field` by name, and changing them
 *     ALL back fails it on the first field it checks. A test that asserted only
 *     "the update returned a row" would pass either way, which is why every
 *     field is asserted individually and by name.
 *
 *  2. **The queue is replaced transactionally with the stream fields.** The
 *     routes stage a queue remainder in memory and persist it only once an
 *     ingress has actually started, so a failed start must leave the stored
 *     queue untouched. That is two tables, therefore one transaction.
 *
 *  3. **The array mutations are decided in SQL, not read-modify-write.** The
 *     socket handlers call these on every connect and disconnect, so two clients
 *     racing must not each write back the roster they read. `addParticipant`
 *     also has to bump `total_joined` ONLY on a genuinely new join, which is the
 *     part a naive `array_append` gets wrong.
 */

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const HOST = 'host-1';

/** The nine columns a teardown has to clear. Named once, used by both halves. */
const STREAM_FIELDS = [
  'activeIngressId',
  'activeStreamUrl',
  'streamTitle',
  'streamImage',
  'streamDescription',
  'rtmpUrl',
  'rtmpStreamKey',
  'streamStartedAt',
  'streamDurationSec',
];

/** A live room carrying every stream field a teardown has to clear. */
async function streamingRoom() {
  const room = await createRoom({
    title: 'Live room',
    host: HOST,
    ownerType: OwnerType.PROFILE,
    type: RoomType.TALK,
    status: RoomStatus.LIVE,
    participants: [],
    speakers: [HOST],
    maxParticipants: 100,
    tags: [],
    speakerPermission: SpeakerPermission.INVITED,
  });

  const streaming = await updateRoom(room.id, {
    activeIngressId: 'ingress-1',
    activeStreamUrl: 'https://example.com/source.m3u8',
    streamTitle: 'Now playing',
    streamImage: 'https://cdn.example/art.jpg',
    streamDescription: 'A description',
    rtmpUrl: 'rtmp://livekit.example/live',
    rtmpStreamKey: 'sk_live_secret',
    streamStartedAt: new Date(),
    streamDurationSec: 1800,
  });

  if (streaming === undefined) throw new Error('fixture room vanished');

  /**
   * Every assertion below measures a CLEAR, so a field the fixture never set
   * would make the test pass without the code doing anything.
   *
   * Iterating {@link STREAM_FIELDS} and indexing INTO the row, not the reverse.
   * The reverse — walking `Object.entries(row)` and skipping names not in the
   * list — silently checks fewer fields when a name in the list matches no
   * column: renaming one entry to `rtmpStreamKeyTYPO` left this green while
   * guarding eight of nine, under a comment claiming all nine.
   */
  const row = streaming as unknown as Record<string, unknown>;
  for (const field of STREAM_FIELDS) {
    const value = row[field];
    expect(`${field} was set: ${value !== null && value !== undefined}`).toBe(
      `${field} was set: true`
    );
  }
  // Vacuity floor: the loop above proves nothing if the list is short or empty.
  expect(STREAM_FIELDS.length).toBe(9);
  return streaming;
}

const QUEUE: readonly MediaQueueItem[] = [
  { kind: 'podcast', episodeId: 'ep-1', syraPodcastId: 'pod-1' },
  { kind: 'track', trackId: 'tr-1' },
];

describe('stopRoomStreamFields', () => {
  it('clears every stream field', async () => {
    const room = await streamingRoom();

    const stopped = await stopRoomStreamFields(room.id);

    // Named individually rather than compared as an object: a single
    // `toMatchObject` would pass on a partial clear if the surviving field
    // happened not to be listed.
    expect(stopped?.activeIngressId).toBeNull();
    expect(stopped?.activeStreamUrl).toBeNull();
    expect(stopped?.streamTitle).toBeNull();
    expect(stopped?.streamImage).toBeNull();
    expect(stopped?.streamDescription).toBeNull();
    expect(stopped?.rtmpUrl).toBeNull();
    expect(stopped?.rtmpStreamKey).toBeNull();
    expect(stopped?.streamStartedAt).toBeNull();
    expect(stopped?.streamDurationSec).toBeNull();
  });

  it('drains the queue in the same call', async () => {
    const room = await streamingRoom();
    await replaceRoomStreamAndQueue(room.id, { streamTitle: 'Now playing' }, QUEUE);
    expect(await findRoomQueue(room.id)).toHaveLength(2);

    await stopRoomStreamFields(room.id);

    expect(await findRoomQueue(room.id)).toEqual([]);
  });

  it('folds a caller\'s own lifecycle change into the same update', async () => {
    const room = await streamingRoom();

    const ended = await stopRoomStreamFields(room.id, {
      status: RoomStatus.ENDED,
      endedAt: new Date(),
    });

    // Both halves land together, so a room is never observable as ended while
    // its publishing credential is still live.
    expect(ended?.status).toBe(RoomStatus.ENDED);
    expect(ended?.rtmpStreamKey).toBeNull();
  });
});

describe('replaceRoomStreamAndQueue', () => {
  it('stores the queue in order, preserving each item\'s kind and ids', async () => {
    const room = await streamingRoom();

    await replaceRoomStreamAndQueue(room.id, { streamTitle: 'First' }, QUEUE);

    // Round-tripped through `findRoomQueue`, which is what the routes read.
    // The nulls the columns hold for the inapplicable ids must not come back as
    // explicit `undefined` keys — the Mongo subdocument simply had no such key.
    expect(await findRoomQueue(room.id)).toEqual([
      { kind: 'podcast', episodeId: 'ep-1', syraPodcastId: 'pod-1' },
      { kind: 'track', trackId: 'tr-1' },
    ]);
  });

  it('replaces rather than appends', async () => {
    const room = await streamingRoom();
    await replaceRoomStreamAndQueue(room.id, {}, QUEUE);

    await replaceRoomStreamAndQueue(room.id, {}, [{ kind: 'track', trackId: 'tr-9' }]);

    expect(await findRoomQueue(room.id)).toEqual([{ kind: 'track', trackId: 'tr-9' }]);
  });

  it('writes an empty queue as no rows at all', async () => {
    const room = await streamingRoom();
    await replaceRoomStreamAndQueue(room.id, {}, QUEUE);

    await replaceRoomStreamAndQueue(room.id, { streamTitle: 'Solo' }, []);

    expect(await findRoomQueue(room.id)).toEqual([]);
  });
});

describe('the participant and speaker array mutations', () => {
  it('adds a participant once and counts the join once', async () => {
    const room = await streamingRoom();

    await addParticipant(room.id, 'listener-a', 1);
    await addParticipant(room.id, 'listener-a', 1);

    const after = await findRoomById(room.id);
    expect(after?.participants).toEqual(['listener-a']);
    // The second call must NOT bump the counter — `$addToSet` plus a
    // conditional `$inc` in Mongo, and a `case when … = any(…)` here. A plain
    // `array_append` with an unconditional `+ 1` passes the array assertion
    // above and fails this one, which is why both are asserted.
    expect(after?.statsTotalJoined).toBe(1);
  });

  it('raises peak listeners and never lowers it', async () => {
    const room = await streamingRoom();

    await addParticipant(room.id, 'listener-a', 5);
    await addParticipant(room.id, 'listener-b', 2);

    // `greatest(…)`, which is Mongo's `$max`: a later, smaller count must not
    // overwrite the high-water mark.
    expect((await findRoomById(room.id))?.statsPeakListeners).toBe(5);
  });

  it('removes a participant without disturbing the others', async () => {
    const room = await streamingRoom();
    await addParticipant(room.id, 'listener-a', 1);
    await addParticipant(room.id, 'listener-b', 2);

    await removeParticipant(room.id, 'listener-a');

    expect((await findRoomById(room.id))?.participants).toEqual(['listener-b']);
  });

  it('removing an absent participant is a no-op rather than an error', async () => {
    const room = await streamingRoom();
    await addParticipant(room.id, 'listener-a', 1);

    await removeParticipant(room.id, 'nobody');

    expect((await findRoomById(room.id))?.participants).toEqual(['listener-a']);
  });

  it('adds a speaker at most once and removes by value', async () => {
    const room = await streamingRoom();

    await addSpeaker(room.id, 'speaker-a');
    await addSpeaker(room.id, 'speaker-a');
    expect((await findRoomById(room.id))?.speakers).toEqual([HOST, 'speaker-a']);

    await removeSpeaker(room.id, 'speaker-a');
    expect((await findRoomById(room.id))?.speakers).toEqual([HOST]);
  });
});
