import { describe, expect, it } from 'bun:test';
import Room, { OwnerType, RoomStatus, RoomType } from '../models/Room';
import { stripInternalStreamFields } from './rooms.routes';

/** A live RTMP publishing credential — the value that must never reach a client. */
const SECRET_STREAM_KEY = 'LK_sensitive_stream_key';

describe('room response sanitization', () => {
  it('removes internal stream credentials from public room payloads', () => {
    const room = {
      _id: 'room-1',
      title: 'Live room',
      host: 'host-1',
      activeIngressId: 'ingress-1',
      activeStreamUrl: 'https://example.com/source.m3u8',
      rtmpUrl: 'rtmp://livekit.example/live',
      rtmpStreamKey: 'LK_sensitive_stream_key',
      streamTitle: 'Public stream title',
    };

    expect(stripInternalStreamFields(room)).toEqual({
      _id: 'room-1',
      title: 'Live room',
      host: 'host-1',
      streamTitle: 'Public stream title',
    });
  });

  // Regression: the sanitizer used to `delete` the credential fields from its argument.
  // That works on a `.lean()` plain object but is a SILENT no-op on a hydrated Mongoose
  // document — schema fields are prototype getters, not own properties — so the RTMP key
  // serialized straight to the client with no error and no failing test. Both current
  // call sites happen to use `.lean()`; this test removes the dependence on that habit.
  it('drops stream credentials from a hydrated Mongoose document, not just a lean object', () => {
    const room = new Room({
      title: 'Live room',
      host: 'host-1',
      ownerType: OwnerType.PROFILE,
      type: RoomType.BROADCAST,
      status: RoomStatus.LIVE,
      activeIngressId: 'ingress-1',
      activeStreamUrl: 'https://example.com/source.m3u8',
      rtmpUrl: 'rtmp://livekit.example/live',
      rtmpStreamKey: SECRET_STREAM_KEY,
      streamTitle: 'Public stream title',
    });

    // Assert on the serialized payload, because that is what actually reaches the client.
    const serialized = JSON.stringify(stripInternalStreamFields(room));

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
});
