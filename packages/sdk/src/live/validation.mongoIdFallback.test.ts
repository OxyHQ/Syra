import { describe, expect, it } from 'bun:test';
import { ZRoom, validateRooms } from './validation';

/**
 * The Live screen went empty in production, and this is the test that would have
 * caught it.
 *
 * The PostgreSQL migration made `id` REQUIRED on `ZRoom`, correct against the
 * ported backend. But `deploy-frontends.yml` fires on `packages/frontend` and
 * `packages/shared-types` while the backend deploy is gated on approval — so
 * merging shipped the client half ALONE against a backend still answering `_id`.
 * `validateRooms` DROPS what it cannot parse, so every room vanished and the only
 * evidence was a `console.warn` nobody was reading.
 *
 * That is the shape worth pinning: a stricter client schema does not fail loudly
 * when the server is older, it fails EMPTY.
 *
 * The fixtures therefore carry the `_id`-only shape, because a fixture with `id`
 * present passes whether or not the fallback exists — the input shape that makes
 * the strict and tolerant versions disagree is the one with `_id` and no `id`.
 */

/** The minimum a room needs to satisfy every other required field in `ZRoom`. */
function roomBody(): Record<string, unknown> {
  return {
    title: 'This is another test',
    host: '6981c9178fcdefaf81988ffb',
    status: 'scheduled',
    createdAt: '2026-08-08T19:00:00.000Z',
  };
}

describe('ZRoom accepts the Mongo-era wire shape', () => {
  it('reads `_id` as `id` when the payload carries no `id`', () => {
    const parsed = ZRoom.safeParse({ ...roomBody(), _id: '6a47e96948842c36b38f8267' });

    expect(parsed.success).toBe(true);
    // Not just "it parsed" — the id has to be the value a caller can join with.
    expect(parsed.success && parsed.data.id).toBe('6a47e96948842c36b38f8267');
  });

  it('leaves a payload that already carries `id` untouched', () => {
    const parsed = ZRoom.safeParse({
      ...roomBody(),
      id: 'the-real-id',
      _id: 'the-legacy-id',
    });

    // The ported backend is the authority once it ships; a stray `_id` must never
    // win over the field the contract actually names.
    expect(parsed.success && parsed.data.id).toBe('the-real-id');
  });

  it('still rejects a room with no identity at all', () => {
    // The fallback must not become a way for an unidentified room to pass — that
    // would trade an empty list for rooms nobody can join.
    expect(ZRoom.safeParse(roomBody()).success).toBe(false);
  });

  it('keeps `_id`-only rooms in the list instead of silently dropping them', () => {
    // The production symptom, reproduced at the function that caused it.
    const rooms = validateRooms([
      { ...roomBody(), _id: 'room-one' },
      { ...roomBody(), _id: 'room-two' },
    ]);

    expect(rooms).toHaveLength(2);
    expect(rooms.map((room) => room.id)).toEqual(['room-one', 'room-two']);
  });
});
