import { describe, expect, it } from 'bun:test';
import { stripInternalStreamFields } from '../db/rooms/serialize';
import type { RoomWithCredentials } from '../db/rooms/rooms';
import { OwnerType, RoomStatus, RoomType, SpeakerPermission } from '../db/rooms/types';

/** A live RTMP publishing credential — the value that must never reach a client. */
const SECRET_STREAM_KEY = 'LK_sensitive_stream_key';

/**
 * A complete `rooms` row carrying every stream credential, as a manager-scoped
 * read returns it.
 *
 * Spelled out in full rather than as a partial cast, because that is precisely
 * what this suite is for. The regression being guarded was a sanitizer that
 * `delete`d the credential keys from its ARGUMENT: that worked on the sparse
 * object literal a `.lean()` read produced and was a silent no-op on a hydrated
 * Mongoose document, where schema fields are prototype getters rather than own
 * properties. Mongoose is gone, so the hydrated-document case no longer exists —
 * but the property it was really testing does: the sanitizer must REBUILD from
 * its allowlist rather than subtract from its input. A row with all four
 * credentials present as own properties is the input that tells those two
 * implementations apart, which is what makes this fixture the load-bearing one.
 */
function roomWithCredentials(): RoomWithCredentials {
  const now = new Date('2026-08-07T10:00:00.000Z');
  return {
    id: 'room-1',
    title: 'Live room',
    description: null,
    ownerType: OwnerType.PROFILE,
    host: 'host-1',
    houseId: null,
    createdByAdmin: null,
    type: RoomType.BROADCAST,
    broadcastKind: 'user',
    status: RoomStatus.LIVE,
    scheduledStart: null,
    startedAt: now,
    endedAt: null,
    speakerPermission: SpeakerPermission.INVITED,
    participants: [],
    speakers: ['host-1'],
    maxParticipants: 100,
    topic: null,
    tags: [],
    archived: false,
    seriesId: null,
    statsPeakListeners: 0,
    statsTotalJoined: 0,
    recordingEnabled: true,
    recordingEgressId: null,
    activeIngressId: 'ingress-1',
    activeStreamUrl: 'https://example.com/source.m3u8',
    streamTitle: 'Public stream title',
    streamImage: null,
    streamDescription: null,
    rtmpUrl: 'rtmp://livekit.example/live',
    rtmpStreamKey: SECRET_STREAM_KEY,
    streamStartedAt: now,
    streamDurationSec: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('room response sanitization', () => {
  it('returns only allowlisted fields, rebuilding rather than subtracting', () => {
    const sanitized = stripInternalStreamFields(roomWithCredentials());

    expect(sanitized.id).toBe('room-1');
    expect(sanitized.title).toBe('Live room');
    expect(sanitized.host).toBe('host-1');
    expect(sanitized.streamTitle).toBe('Public stream title');
    // `stats` was a Mongo subdocument and is two flat columns; the serializer
    // rebuilds the nested shape so the wire format is unchanged.
    expect(sanitized.stats).toEqual({ peakListeners: 0, totalJoined: 0 });
    // No queue was passed, so the key is absent rather than an empty array —
    // matching the Mongo field's `default: undefined`.
    expect('podcastQueue' in sanitized).toBe(false);
  });

  it('drops every stream credential, key names included', () => {
    // Assert on the serialized payload, because that is what actually reaches
    // the client.
    const serialized = JSON.stringify(stripInternalStreamFields(roomWithCredentials()));

    expect(serialized).not.toContain(SECRET_STREAM_KEY);
    expect(serialized).not.toContain('rtmp://livekit.example/live');
    expect(serialized).not.toContain('ingress-1');
    expect(serialized).not.toContain('source.m3u8');
    // The key names must be gone too, not merely emptied.
    expect(serialized).not.toContain('rtmpStreamKey');
    expect(serialized).not.toContain('rtmpUrl');
    expect(serialized).not.toContain('activeIngressId');
    expect(serialized).not.toContain('activeStreamUrl');
    // Public fields still survive the rebuild.
    expect(serialized).toContain('Public stream title');
    expect(serialized).toContain('Live room');
  });

  /**
   * `topicId` named a column this schema does not have — `models/Room.ts`
   * declared `ref: 'Topic'` against a model the repo never contained, so the
   * field was `undefined` on every document ever written and the allowlist entry
   * copied nothing. It is out of `PUBLIC_ROOM_FIELDS` now, and this pins that:
   * an allowlist naming a field no row can produce is how a dropped column comes
   * back by accident.
   */
  it('no longer names the dropped topicId field', () => {
    const sanitized = stripInternalStreamFields({
      ...roomWithCredentials(),
      // A stray value under the old key must not be copied through.
      topicId: 'some-topic',
    } as RoomWithCredentials & { topicId: string });

    expect('topicId' in sanitized).toBe(false);
  });
});
