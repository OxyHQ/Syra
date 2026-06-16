import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../../test/mongo';
import { DeviceModel } from '../../models/Device';
import {
  registerDevice,
  listDevices,
  heartbeat,
  markInactive,
} from './deviceService';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

const USER_A = 'user-aaa';
const USER_B = 'user-bbb';

const BASE_INPUT = {
  deviceId: 'device-001',
  name: 'My Web Browser',
  type: 'web' as const,
  capabilities: ['play', 'volume'],
};

describe('registerDevice', () => {
  it('creates a device doc with correct fields', async () => {
    const device = await registerDevice(USER_A, BASE_INPUT);

    expect(device.oxyUserId).toBe(USER_A);
    expect(device.deviceId).toBe('device-001');
    expect(device.name).toBe('My Web Browser');
    expect(device.type).toBe('web');
    expect(device.capabilities).toEqual(['play', 'volume']);
    expect(device.isActive).toBe(true);
    expect(device.lastSeen).toBeInstanceOf(Date);
  });

  it('upserts on re-register — same deviceId → only 1 doc, name updated', async () => {
    await registerDevice(USER_A, BASE_INPUT);
    await registerDevice(USER_A, { ...BASE_INPUT, name: 'Updated Name' });

    const docs = await DeviceModel.find({ oxyUserId: USER_A });
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe('Updated Name');
  });

  it('two different deviceIds for the same user → 2 docs', async () => {
    await registerDevice(USER_A, { ...BASE_INPUT, deviceId: 'device-001' });
    await registerDevice(USER_A, { ...BASE_INPUT, deviceId: 'device-002', name: 'Mobile' });

    const docs = await DeviceModel.find({ oxyUserId: USER_A });
    expect(docs).toHaveLength(2);
  });

  it('same deviceId for two different users → 2 distinct docs (compound key)', async () => {
    await registerDevice(USER_A, BASE_INPUT);
    await registerDevice(USER_B, BASE_INPUT);

    const docsA = await DeviceModel.find({ oxyUserId: USER_A });
    const docsB = await DeviceModel.find({ oxyUserId: USER_B });
    expect(docsA).toHaveLength(1);
    expect(docsB).toHaveLength(1);
    expect(docsA[0]._id.toString()).not.toBe(docsB[0]._id.toString());
  });
});

describe('listDevices', () => {
  it('returns devices sorted by lastSeen descending (most recent first)', async () => {
    // Register device-001 first, then device-002 — device-002 has newer lastSeen
    await registerDevice(USER_A, { ...BASE_INPUT, deviceId: 'device-001' });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));
    await registerDevice(USER_A, { ...BASE_INPUT, deviceId: 'device-002', name: 'Mobile' });

    const devices = await listDevices(USER_A);
    expect(devices).toHaveLength(2);
    expect(devices[0].deviceId).toBe('device-002');
    expect(devices[1].deviceId).toBe('device-001');
  });

  it('returns empty array when user has no devices', async () => {
    const devices = await listDevices(USER_A);
    expect(devices).toHaveLength(0);
  });
});

describe('heartbeat', () => {
  it('updates lastSeen to a newer timestamp and keeps isActive true', async () => {
    const before = await registerDevice(USER_A, BASE_INPUT);
    const beforeLastSeen = before.lastSeen.getTime();

    // Ensure time advances
    await new Promise((r) => setTimeout(r, 5));
    await heartbeat(USER_A, 'device-001');

    const after = await DeviceModel.findOne({ oxyUserId: USER_A, deviceId: 'device-001' });
    expect(after).not.toBeNull();
    expect(after!.lastSeen.getTime()).toBeGreaterThan(beforeLastSeen);
    expect(after!.isActive).toBe(true);
  });
});

describe('markInactive', () => {
  it('sets isActive to false', async () => {
    await registerDevice(USER_A, BASE_INPUT);
    await markInactive(USER_A, 'device-001');

    const doc = await DeviceModel.findOne({ oxyUserId: USER_A, deviceId: 'device-001' });
    expect(doc).not.toBeNull();
    expect(doc!.isActive).toBe(false);
  });
});
