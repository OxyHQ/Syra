import { describe, expect, it } from 'bun:test';
import {
  HOUSE_DISCOVERY_LEVELS,
  HOUSE_JOIN_POLICIES,
  HOUSE_MEMBER_ROLES,
  HOUSE_ROOM_ACCESS_LEVELS,
  LIVE_VISIBILITIES,
  MEDIA_QUEUE_KINDS,
  RECORDING_ACCESS_LEVELS,
  RECORDING_STATUSES,
  ROOM_BROADCAST_KINDS,
  ROOM_OWNER_TYPES,
  ROOM_SPEAKER_PERMISSIONS,
  ROOM_STATUSES,
  ROOM_TYPES,
  SERIES_RECURRENCE_TYPES,
} from '../../schema/rooms';
import {
  BroadcastKind,
  HouseDiscovery,
  HouseJoin,
  HouseMemberRole,
  HouseRooms,
  LIVE_VISIBILITY_VALUES,
  OwnerType,
  RecordingAccess,
  RecordingStatus,
  RecurrenceType,
  RoomStatus,
  RoomType,
  SpeakerPermission,
  type MediaQueueKind,
} from '../types';

/**
 * The rooms vertical states each closed value set TWICE — once as a schema
 * `as const` tuple (which types the column and derives its CHECK) and once as a
 * `db/rooms/types.ts` enum (which ~60 call sites read as `RoomStatus.LIVE`).
 * This pins them together, which is the whole reason keeping both was
 * acceptable: add a value to one side without the other and a case below fails
 * by name.
 *
 * ## Why the ORDER is asserted, not just the membership
 *
 * `inList()` renders each tuple straight into its CHECK constraint, so the tuple
 * is the database's own definition of the set. A set comparison would pass on a
 * reordering, which is harmless — but a set comparison ALSO passes when one side
 * has a duplicate and the other does not, which is not. Comparing the arrays
 * directly rejects both, and costs nothing: neither side has any reason to be
 * reordered.
 *
 * ## The vacuity floor
 *
 * `Object.values()` on a string enum returns its members; on an enum that got
 * emptied by a bad refactor it returns `[]`, and `[] === []` would pass against
 * an equally-empty tuple. {@link EXPECTED_PAIRS} is asserted to be non-empty and
 * each pair's length to be at least 2 — every set here has at least two members
 * — so a traversal that silently found nothing cannot read as agreement.
 */

/** Each closed value set, as `[name, enum values, schema tuple]`. */
const EXPECTED_PAIRS: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
  ['HouseMemberRole', Object.values(HouseMemberRole), HOUSE_MEMBER_ROLES],
  ['HouseDiscovery', Object.values(HouseDiscovery), HOUSE_DISCOVERY_LEVELS],
  ['HouseRooms', Object.values(HouseRooms), HOUSE_ROOM_ACCESS_LEVELS],
  ['HouseJoin', Object.values(HouseJoin), HOUSE_JOIN_POLICIES],
  ['RoomStatus', Object.values(RoomStatus), ROOM_STATUSES],
  ['RoomType', Object.values(RoomType), ROOM_TYPES],
  ['OwnerType', Object.values(OwnerType), ROOM_OWNER_TYPES],
  ['BroadcastKind', Object.values(BroadcastKind), ROOM_BROADCAST_KINDS],
  ['SpeakerPermission', Object.values(SpeakerPermission), ROOM_SPEAKER_PERMISSIONS],
  ['RecurrenceType', Object.values(RecurrenceType), SERIES_RECURRENCE_TYPES],
  ['RecordingStatus', Object.values(RecordingStatus), RECORDING_STATUSES],
  ['RecordingAccess', Object.values(RecordingAccess), RECORDING_ACCESS_LEVELS],
  ['LiveVisibility', LIVE_VISIBILITY_VALUES, LIVE_VISIBILITIES],
] as const;

describe('db/rooms/types enums match db/schema/rooms tuples', () => {
  it('covers every closed value set, none of them empty', () => {
    expect(EXPECTED_PAIRS.length).toBe(13);
    for (const [name, values, tuple] of EXPECTED_PAIRS) {
      expect(`${name}:${values.length >= 2}`).toBe(`${name}:true`);
      expect(`${name}:${tuple.length >= 2}`).toBe(`${name}:true`);
    }
  });

  for (const [name, values, tuple] of EXPECTED_PAIRS) {
    it(`${name} matches its schema tuple exactly`, () => {
      expect(values).toEqual([...tuple]);
    });
  }

  /**
   * `MediaQueueKind` is a string-literal union rather than an enum (nothing
   * reads it as a member), so it is pinned by assigning each schema value to the
   * union type: a value added to `MEDIA_QUEUE_KINDS` without the union fails
   * `tsc` here rather than at some call site later.
   */
  it('MediaQueueKind covers MEDIA_QUEUE_KINDS', () => {
    const kinds: MediaQueueKind[] = [...MEDIA_QUEUE_KINDS];
    expect(kinds).toEqual(['podcast', 'track']);
  });
});
