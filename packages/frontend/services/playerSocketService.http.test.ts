jest.mock('../stores/playerStore', () => ({ usePlayerStore: { getState: () => ({}) } }));
jest.mock('../stores/queueStore', () => ({ useQueueStore: { getState: () => ({}) } }));
let mockBaseURL = '';
jest.mock('@/config', () => ({
  get API_URL() {
    return mockBaseURL;
  },
  get API_URL_SOCKET() {
    return mockBaseURL;
  },
}));

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { OxyServices } from '@oxy.so/core';
import { playerSocketService } from './playerSocketService';

const token = (userId: string, exp = 2_000_000_000) =>
  `e30.${Buffer.from(JSON.stringify({ userId, sessionId: userId, exp })).toString('base64url')}.fixture`;
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Socket timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture() {
  const http = createServer();
  const io = new Server(http);
  const players = io.of('/player');
  const credentials: unknown[] = [];
  const registrations: unknown[] = [];
  players.use((socket, next) => {
    credentials.push(socket.handshake.auth);
    next();
  });
  players.on('connection', (socket) => {
    socket.on('device:register', (value) => registrations.push(value));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  mockBaseURL = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const oxy = new OxyServices({ baseURL: mockBaseURL });
  return {
    players,
    credentials,
    registrations,
    oxy,
    async close() {
      playerSocketService.disconnect();
      oxy.dispose();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}

test('connected player changes account immediately, clears previous device attribution and ignores old cleanup', async () => {
  const f = await fixture();
  try {
    f.oxy.session.setAccessToken(token('A', 1));
    let refreshed = 0;
    f.oxy.http.setAuthRefreshHandler(async () => {
      refreshed++;
      return token('A');
    });
    let ended = 0;
    const releaseOld = playerSocketService.connect(f.oxy, () => {
      ended++;
    });
    const releasePanel = playerSocketService.connect(f.oxy);
    await until(() => playerSocketService.connected);
    releasePanel();
    expect(playerSocketService.connected).toBe(true);
    playerSocketService.emitDeviceRegister({
      deviceId: 'device-a',
      name: 'A',
      type: 'web',
      capabilities: [],
    });
    await until(() => f.registrations.length === 1);
    expect(refreshed).toBe(1);
    f.oxy.session.setAccessToken(token('B'));
    expect(playerSocketService.connected).toBe(false);
    expect(ended).toBe(1);
    const releaseNew = playerSocketService.connect(f.oxy);
    await until(() => playerSocketService.connected && f.players.sockets.size === 1);
    releaseOld();
    expect(playerSocketService.connected).toBe(true);
    expect(f.credentials).toEqual([{ token: token('A') }, { token: token('B') }]);
    expect(f.registrations).toHaveLength(1);
    releaseNew();
    await until(() => f.players.sockets.size === 0);
  } finally {
    await f.close();
  }
});

test('unmount while refresh is pending never authenticates a detached player', async () => {
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
    const release = playerSocketService.connect(f.oxy);
    await until(() => !!finish);
    release();
    finish?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(f.credentials).toEqual([]);
    expect(f.players.sockets.size).toBe(0);
  } finally {
    finish?.();
    await f.close();
  }
});
