import { test, expect } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { OxyServices } from '@oxy.so/core';
import { RoomSocketService } from './spaceSocketService';

const token = (userId: string, exp = 2_000_000_000) =>
  `e30.${Buffer.from(JSON.stringify({ userId, sessionId: userId, exp })).toString('base64url')}.fixture`;
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Socket condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture() {
  const http = createServer();
  const io = new Server(http);
  const rooms = io.of('/rooms');
  const handshakes: Record<string, unknown>[] = [];
  rooms.use((socket, next) => {
    handshakes.push(socket.handshake.auth);
    next();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const oxy = new OxyServices({ baseURL });
  const client = new RoomSocketService(baseURL);
  return {
    io,
    rooms,
    handshakes,
    oxy,
    client,
    async close() {
      client.disconnect();
      oxy.dispose();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}

test('two consumers share refreshed authority; releasing one preserves the other and last release disconnects', async () => {
  const f = await fixture();
  try {
    f.oxy.session.setAccessToken(token('A', 1));
    let refreshes = 0;
    f.oxy.http.setAuthRefreshHandler(async () => {
      refreshes++;
      return token('A');
    });
    const releaseA = f.client.connectWithOxy(f.oxy);
    const releaseB = f.client.connectWithOxy(f.oxy);
    await until(() => f.client.isConnected);
    expect(f.handshakes).toEqual([{ token: token('A') }]);
    expect(refreshes).toBe(1);
    releaseA();
    expect(f.client.isConnected).toBe(true);
    expect(f.rooms.sockets.size).toBe(1);
    releaseB();
    await until(() => f.rooms.sockets.size === 0);
    expect(f.client.isConnected).toBe(false);
  } finally {
    await f.close();
  }
});

test('account switch cancels all old consumers and late cleanup cannot close the new account', async () => {
  const f = await fixture();
  try {
    f.oxy.session.setAccessToken(token('A'));
    let ended = 0;
    const releaseA = f.client.connectWithOxy(f.oxy, () => {
      ended++;
    });
    const releaseB = f.client.connectWithOxy(f.oxy, () => {
      ended++;
    });
    await until(() => f.client.isConnected);
    let events = 0;
    const onStarted = () => {
      events++;
    };
    const stopOldListener = f.client.onRoomStarted(onStarted);
    f.oxy.session.setAccessToken(token('B'));
    expect(f.client.isConnected).toBe(false);
    expect(ended).toBe(2);
    const releaseNew = f.client.connectWithOxy(f.oxy);
    await until(() => f.client.isConnected && f.rooms.sockets.size === 1);
    f.client.onRoomStarted(onStarted);
    releaseA();
    releaseB();
    stopOldListener();
    expect(f.client.isConnected).toBe(true);
    f.rooms.emit('room:started', { roomId: 'new-account' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toBe(1);
    expect(f.handshakes).toEqual([{ token: token('A') }, { token: token('B') }]);
    releaseNew();
  } finally {
    await f.close();
  }
});

test('last release or account switch aborts a pending shared handshake refresh', async () => {
  for (const action of ['release', 'switch'] as const) {
    const f = await fixture();
    let finish: (() => void) | undefined;
    try {
      f.oxy.session.setAccessToken(token('A', 1));
      f.oxy.http.setAuthRefreshHandler(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return token('A');
      });
      const releaseA = f.client.connectWithOxy(f.oxy);
      const releaseB = f.client.connectWithOxy(f.oxy);
      await until(() => !!finish);
      releaseA();
      if (action === 'release') releaseB();
      else f.oxy.session.setAccessToken(token('B'));
      finish?.();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(f.handshakes).toEqual([]);
      expect(f.rooms.sockets.size).toBe(0);
      if (action === 'switch') expect(f.oxy.session.userId).toBe('B');
      releaseB();
    } finally {
      finish?.();
      await f.close();
    }
  }
});

test('external explicit credentials retain their public handshake and replace a previous external identity', async () => {
  const f = await fixture();
  try {
    f.client.connect('external-a', 'credential-a');
    await until(() => f.client.isConnected);
    f.client.connect('external-b', 'credential-b');
    await until(() => f.client.isConnected && f.handshakes.length === 2);
    expect(f.handshakes).toEqual([
      { userId: 'external-a', token: 'credential-a' },
      { userId: 'external-b', token: 'credential-b' },
    ]);
  } finally {
    await f.close();
  }
});
