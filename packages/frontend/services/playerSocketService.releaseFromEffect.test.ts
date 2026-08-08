/**
 * The service's module graph reaches the player store, which imports `expo-audio`
 * — a native module jest-expo cannot instantiate. Mocked to nothing useful on
 * purpose: this file tests socket teardown, and a real audio player would only
 * add a way for the test to fail for an unrelated reason.
 */
jest.mock('expo-audio', () => ({ createAudioPlayer: jest.fn(() => ({})) }));
// The two stores reach `@oxyhq/core`, published as untransformed ESM that
// jest-expo does not put through babel. Neither store participates in socket
// teardown, so they are stubbed at the boundary rather than transformed.
jest.mock('../stores/playerStore', () => ({ usePlayerStore: { getState: () => ({}) } }));
jest.mock('../stores/queueStore', () => ({ useQueueStore: { getState: () => ({}) } }));

import { playerSocketService } from './playerSocketService';

/**
 * `releaseFromEffect` exists because `connect()`'s handshake guard fixes only
 * half the problem.
 *
 * That guard is on the CONNECT side, and React orders a dependency change as
 * cleanup-then-effect — so an unconditional `disconnect()` in the cleanup has
 * already killed an in-flight attempt before `connect()` ever looks at it. The
 * browser reports it as "WebSocket is closed before the connection is
 * established", which is exactly what production logged.
 *
 * The fixtures below are the point: `active && !connected` is the handshaking
 * state, and it is the ONLY one where the two behaviours differ. A test that
 * only exercised a connected socket, or only a null one, would pass against an
 * unconditional disconnect and prove nothing.
 */

type FakeSocket = { active: boolean; connected: boolean; disconnect: () => void };

function withSocket(socket: FakeSocket | null): { disconnected: () => boolean } {
  let disconnected = false;
  if (socket) socket.disconnect = () => { disconnected = true; };
  // The service holds its socket privately; this is the one place a test needs
  // to reach it, so the cast is narrow and local rather than an `any` on the API.
  (playerSocketService as unknown as { socket: FakeSocket | null }).socket = socket;
  return { disconnected: () => disconnected };
}

afterEach(() => {
  (playerSocketService as unknown as { socket: FakeSocket | null }).socket = null;
});

describe('releaseFromEffect', () => {
  it('leaves a HANDSHAKING socket alone — the case the whole method exists for', () => {
    const probe = withSocket({ active: true, connected: false, disconnect: () => {} });

    playerSocketService.releaseFromEffect();

    expect(probe.disconnected()).toBe(false);
  });

  it('tears down a CONNECTED socket, because a real teardown must still work', () => {
    const probe = withSocket({ active: true, connected: true, disconnect: () => {} });

    playerSocketService.releaseFromEffect();

    expect(probe.disconnected()).toBe(true);
  });

  it('tears down an idle socket that is neither active nor connected', () => {
    const probe = withSocket({ active: false, connected: false, disconnect: () => {} });

    playerSocketService.releaseFromEffect();

    expect(probe.disconnected()).toBe(true);
  });

  it('is a no-op with no socket, so a gated-off boot does not throw', () => {
    withSocket(null);

    expect(() => playerSocketService.releaseFromEffect()).not.toThrow();
  });
});
