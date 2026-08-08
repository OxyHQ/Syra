import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { devices } from '../../db/schema/library';
import {
  registerDevice,
  listDevices,
  heartbeat,
  markInactive,
} from './deviceService';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const USER_A = 'user-aaa';
const USER_B = 'user-bbb';

const BASE_INPUT = {
  deviceId: 'device-001',
  name: 'My Web Browser',
  type: 'web' as const,
  capabilities: ['play', 'volume'],
};

/** The stored rows for one account — the assertions' view of the table. */
function rowsFor(oxyUserId: string) {
  return getDb().select().from(devices).where(eq(devices.oxyUserId, oxyUserId));
}

function rowFor(oxyUserId: string, deviceId: string) {
  return getDb()
    .select()
    .from(devices)
    .where(and(eq(devices.oxyUserId, oxyUserId), eq(devices.deviceId, deviceId)))
    .limit(1);
}

describe('registerDevice', () => {
  it('creates a device row with correct fields', async () => {
    const device = await registerDevice(USER_A, BASE_INPUT);

    expect(device.oxyUserId).toBe(USER_A);
    expect(device.deviceId).toBe('device-001');
    expect(device.name).toBe('My Web Browser');
    expect(device.type).toBe('web');
    expect(device.capabilities).toEqual(['play', 'volume']);
    expect(device.isActive).toBe(true);
    expect(device.lastSeen).toBeInstanceOf(Date);
  });

  it('upserts on re-register — same deviceId → only 1 row, name updated', async () => {
    await registerDevice(USER_A, BASE_INPUT);
    await registerDevice(USER_A, { ...BASE_INPUT, name: 'Updated Name' });

    const rows = await rowsFor(USER_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Updated Name');
  });

  it('re-registering without capabilities CLEARS them, as the upsert always set them', async () => {
    // Parity with the Mongoose `findOneAndUpdate`, whose update document always
    // carried `capabilities: input.capabilities ?? []`. The conflict branch of
    // the drizzle upsert has to set the same key or the field silently becomes
    // sticky — a difference no type would catch, since both spellings compile.
    await registerDevice(USER_A, BASE_INPUT);
    await registerDevice(USER_A, { deviceId: 'device-001', name: 'Same', type: 'web' });

    const rows = await rowsFor(USER_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].capabilities).toEqual([]);
  });

  it('two different deviceIds for the same user → 2 rows', async () => {
    await registerDevice(USER_A, { ...BASE_INPUT, deviceId: 'device-001' });
    await registerDevice(USER_A, { ...BASE_INPUT, deviceId: 'device-002', name: 'Mobile' });

    expect(await rowsFor(USER_A)).toHaveLength(2);
  });

  it('same deviceId for two different users → 2 distinct rows (compound key)', async () => {
    await registerDevice(USER_A, BASE_INPUT);
    await registerDevice(USER_B, BASE_INPUT);

    const rowsA = await rowsFor(USER_A);
    const rowsB = await rowsFor(USER_B);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0].id).not.toBe(rowsB[0].id);
  });
});

describe('listDevices', () => {
  it('returns devices sorted by lastSeen descending (most recent first)', async () => {
    // Register device-001 first, then device-002 — device-002 has newer lastSeen
    await registerDevice(USER_A, { ...BASE_INPUT, deviceId: 'device-001' });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));
    await registerDevice(USER_A, { ...BASE_INPUT, deviceId: 'device-002', name: 'Mobile' });

    const listed = await listDevices(USER_A);
    expect(listed).toHaveLength(2);
    expect(listed[0].deviceId).toBe('device-002');
    expect(listed[1].deviceId).toBe('device-001');
  });

  it('returns the wire shape the socket promises — id, no oxyUserId, lastSeen a string', async () => {
    // `listDevices` IS the `device:list` payload (three emit sites in
    // `sockets/playerSocket.ts`), and `deviceSchema` is its declared contract.
    // The Mongoose version emitted raw documents, so `_id`/`__v` reached
    // clients and `lastSeen` was a Date. Asserted here because nothing else
    // parses this payload server-side.
    await registerDevice(USER_A, BASE_INPUT);

    const [device] = await listDevices(USER_A);
    expect(Object.keys(device).sort()).toEqual(
      ['capabilities', 'deviceId', 'id', 'isActive', 'lastSeen', 'name', 'type'].sort()
    );
    expect(typeof device.lastSeen).toBe('string');
    expect(new Date(device.lastSeen).getTime()).not.toBeNaN();
  });

  it('returns empty array when user has no devices', async () => {
    expect(await listDevices(USER_A)).toHaveLength(0);
  });

  it('does not leak another account’s devices', async () => {
    await registerDevice(USER_B, BASE_INPUT);

    expect(await listDevices(USER_A)).toHaveLength(0);
  });
});

describe('heartbeat', () => {
  it('updates lastSeen to a newer timestamp and keeps isActive true', async () => {
    const before = await registerDevice(USER_A, BASE_INPUT);
    const beforeLastSeen = before.lastSeen.getTime();

    // Ensure time advances
    await new Promise((r) => setTimeout(r, 5));
    await heartbeat(USER_A, 'device-001');

    const [after] = await rowFor(USER_A, 'device-001');
    expect(after).toBeDefined();
    expect(after.lastSeen.getTime()).toBeGreaterThan(beforeLastSeen);
    expect(after.isActive).toBe(true);
  });

  it('is a no-op for a device that was never registered', async () => {
    // The socket heartbeats on a timer; a client that has not sent
    // `device:register` yet must not throw one.
    await heartbeat(USER_A, 'never-registered');

    expect(await rowsFor(USER_A)).toHaveLength(0);
  });
});

describe('markInactive', () => {
  it('sets isActive to false', async () => {
    await registerDevice(USER_A, BASE_INPUT);
    await markInactive(USER_A, 'device-001');

    const [row] = await rowFor(USER_A, 'device-001');
    expect(row).toBeDefined();
    expect(row.isActive).toBe(false);
  });

  it('leaves another account’s identically-named device alone', async () => {
    await registerDevice(USER_A, BASE_INPUT);
    await registerDevice(USER_B, BASE_INPUT);

    await markInactive(USER_A, 'device-001');

    const [mine] = await rowFor(USER_A, 'device-001');
    const [theirs] = await rowFor(USER_B, 'device-001');
    expect(mine.isActive).toBe(false);
    expect(theirs.isActive).toBe(true);
  });
});
