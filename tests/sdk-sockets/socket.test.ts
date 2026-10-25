import { test, expect, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServices } from '@oxy.so/core';
import { Server } from 'socket.io';
import type * as PublicSocket from 'syra-packed-types';

// Extract the actual npm artifact, then load its exported CommonJS entry. The
// isolated harness pins the minimum published core version, independent of the app.
const artifact = join(import.meta.dir, '.artifact');
rmSync(artifact, { recursive: true, force: true });
mkdirSync(artifact, { recursive: true });
execFileSync('bun', ['pm', 'pack', '--destination', artifact], {
  cwd: join(import.meta.dir, '../../packages/sdk'),
  stdio: 'pipe',
});
const manifest = await Bun.file(join(import.meta.dir, '../../packages/sdk/package.json')).json();
execFileSync('tar', [
  '-xzf',
  join(artifact, `syra.fm-sdk-${manifest.version}.tgz`),
  '-C',
  artifact,
]);
const packed = await Bun.file(join(artifact, 'package/package.json')).json();
const entry = packed.exports['./live/socket'].require.default;
const { RoomSocketService }: typeof PublicSocket = await import(join(artifact, 'package', entry));
afterAll(() => rmSync(artifact, { recursive: true, force: true }));
const token = (userId: string) =>
  `e30.${Buffer.from(JSON.stringify({ userId, sessionId: userId, exp: 2_000_000_000 })).toString('base64url')}.fixture`;
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Socket timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('packed public socket entry composes with published core 7.1 and isolates leased accounts', async () => {
  const http = createServer();
  const io = new Server(http);
  const rooms = io.of('/rooms');
  const credentials: unknown[] = [];
  rooms.use((socket, next) => {
    credentials.push(socket.handshake.auth);
    next();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const oxy = new OxyServices({ baseURL });
  const service = new RoomSocketService(baseURL);
  try {
    oxy.session.setAccessToken(token('A'));
    const a = service.connectWithOxy(oxy);
    const b = service.connectWithOxy(oxy);
    await until(() => service.isConnected);
    a();
    expect(service.isConnected).toBe(true);
    oxy.session.setAccessToken(token('B'));
    expect(service.isConnected).toBe(false);
    const c = service.connectWithOxy(oxy);
    await until(() => service.isConnected && rooms.sockets.size === 1);
    b();
    expect(service.isConnected).toBe(true);
    expect(credentials).toEqual([{ token: token('A') }, { token: token('B') }]);
    c();
    await until(() => rooms.sockets.size === 0);
  } finally {
    service.disconnect();
    oxy.dispose();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});
