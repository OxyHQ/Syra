import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { validateHouse, validateRoom, validateRooms, validateSeries } from './validation';

/**
 * What the rooms engine promises about a room, house or series, pinned without
 * Zod (the parity test proves it matches the `@syra.fm/sdk/schemas` versions;
 * this says what the promise is).
 */

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const room = { id: 'r', title: 'Room', host: 'h', status: 'live', createdAt: '2026' } as const;

describe('a valid room', () => {
  it('gets the documented defaults for what the backend left out', () => {
    expect(validateRoom(room)).toStrictEqual({
      ...room,
      ownerType: 'profile',
      type: 'talk',
      participants: [],
      speakers: [],
      maxParticipants: 100,
      archived: false,
      recordingEnabled: true,
    });
  });

  it('keeps fields the SDK does not name, as sent', () => {
    const checked = validateRoom({ ...room, listenerCount: 12, extra: { a: 1 } });
    expect(checked?.listenerCount).toBe(12);
    expect(checked?.extra).toEqual({ a: 1 });
  });

  it('keeps `null` where the backend clears a field', () => {
    expect(validateRoom({ ...room, topic: null, activeStreamUrl: null })).toMatchObject({
      topic: null,
      activeStreamUrl: null,
    });
  });
});

describe('an invalid room', () => {
  it('is `null` from validateRoom, with a warning naming the field', () => {
    expect(validateRoom({ ...room, status: 'paused' })).toBeNull();
    expect(String(warn.mock.calls[0]?.[1])).toContain('status');
  });

  it('is dropped from a list, and only it', () => {
    const rooms = validateRooms([room, { ...room, host: 1 }, { ...room, id: 'r2' }]);
    expect(rooms.map((r) => r.id)).toEqual(['r', 'r2']);
  });

  it('is refused for `null` where a default exists — a default fills only absence', () => {
    expect(validateRoom({ ...room, type: null })).toBeNull();
  });
});

describe('houses and series', () => {
  it('a house without visibility gets the documented one', () => {
    expect(
      validateHouse({ id: 'h', name: 'H', createdBy: 'u', createdAt: '2026' })?.visibility,
    ).toEqual({ discovery: 'listed', rooms: 'anyone', join: 'invite' });
  });

  it("a series' recurrence time must be HH:MM, and its weekday 0–6", () => {
    const series = {
      id: 's',
      title: 'S',
      createdBy: 'u',
      roomTemplate: { titlePattern: 'x' },
      createdAt: '2026',
    };
    expect(validateSeries({ ...series, recurrence: { type: 'weekly', time: '18:30' } })).not.toBe(
      null,
    );
    expect(validateSeries({ ...series, recurrence: { type: 'weekly', time: '6pm' } })).toBeNull();
    expect(
      validateSeries({ ...series, recurrence: { type: 'weekly', time: '18:30', dayOfWeek: 7 } }),
    ).toBeNull();
  });
});
