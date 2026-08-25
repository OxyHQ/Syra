import { useQuery } from '@tanstack/react-query';
import { PODCAST_QUERY_KEYS, usePodcast, useEpisodes, useEpisode } from './usePodcasts';
import { useAuthGate, type AuthGate } from '@/hooks/useAuthGate';

/**
 * The three reads addressed BY ID, exercised through the options they hand
 * React Query rather than through a renderer.
 *
 * Two things have to hold, and neither did. A guest answer must never be served
 * to the signed-in owner, or the 404 a stranger correctly receives for a private
 * show survives the sign-in that would have made it a 200 — which is how a
 * creator ends up locked out of their own show by a cache. And nothing may be
 * fetched before the Oxy session has resolved into one identity or the other,
 * because a read fired mid-boot is a read fired as a guest that the session is
 * about to stop being.
 *
 * Same shape as `useRadio.test.tsx`, which pins the same two properties for the
 * station reads. Following it rather than inventing a second convention is the
 * point: these are the same concern.
 */

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(() => ({})),
  useMutation: jest.fn(() => ({})),
  useQueryClient: jest.fn(() => ({ removeQueries: jest.fn(), invalidateQueries: jest.fn() })),
}));

jest.mock('@/hooks/useAuthGate', () => ({ useAuthGate: jest.fn() }));
jest.mock('@/hooks/useLibrary', () => ({
  LIBRARY_QUERY_KEY: ['library'],
  useLibrary: jest.fn(() => ({})),
  withMembership: jest.fn(),
}));
jest.mock('@oxyhq/services', () => ({ useOxy: jest.fn(() => ({ canUsePrivateApi: false })) }));
jest.mock('@oxyhq/bloom/toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('@/services/podcastService', () => ({ podcastService: {} }));
jest.mock('@/services/episodeService', () => ({ episodeService: {} }));

const mockUseQuery = useQuery as jest.MockedFunction<typeof useQuery>;
const mockUseAuthGate = useAuthGate as jest.MockedFunction<typeof useAuthGate>;

const RESOLVING_GATE: AuthGate = {
  status: 'resolving',
  isResolving: true,
  isTimedOut: false,
  isResolved: false,
  canUsePrivateApi: false,
  isAuthenticated: false,
  catalogIdentity: 'guest',
  retry: () => undefined,
};

const GUEST_GATE: AuthGate = { ...RESOLVING_GATE, status: 'guest', isResolving: false, isResolved: true };

const AUTH_GATE: AuthGate = {
  ...GUEST_GATE,
  status: 'authenticated',
  canUsePrivateApi: true,
  isAuthenticated: true,
  catalogIdentity: 'auth',
};

/** The options the hook passed to `useQuery` on its most recent call. */
function lastQueryOptions() {
  const calls = mockUseQuery.mock.calls;
  return calls[calls.length - 1][0] as { queryKey: readonly unknown[]; enabled?: boolean };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe.each([
  ['usePodcast', () => usePodcast('show-1'), (identity: string) => PODCAST_QUERY_KEYS.show(identity, 'show-1')],
  ['useEpisodes', () => useEpisodes('show-1'), (identity: string) => PODCAST_QUERY_KEYS.episodes(identity, 'show-1', 50)],
  ['useEpisode', () => useEpisode('episode-1'), (identity: string) => PODCAST_QUERY_KEYS.episode(identity, 'episode-1')],
])('%s', (_name, run, keyFor) => {
  it('caches a guest answer under a different key than the signed-in one', () => {
    mockUseAuthGate.mockReturnValue(GUEST_GATE);
    run();
    const guestKey = lastQueryOptions().queryKey;

    mockUseAuthGate.mockReturnValue(AUTH_GATE);
    run();
    const authKey = lastQueryOptions().queryKey;

    expect(guestKey).toEqual(keyFor('guest'));
    expect(authKey).toEqual(keyFor('auth'));
    expect(guestKey).not.toEqual(authKey);
  });

  it('stays disabled while the auth gate is unresolved', () => {
    mockUseAuthGate.mockReturnValue(RESOLVING_GATE);

    run();

    expect(lastQueryOptions().enabled).toBe(false);
  });

  it('runs once the gate reaches a terminal identity', () => {
    mockUseAuthGate.mockReturnValue(GUEST_GATE);

    run();

    expect(lastQueryOptions().enabled).toBe(true);
  });
});

describe('an id is still required', () => {
  it('does not read a show without one', () => {
    mockUseAuthGate.mockReturnValue(AUTH_GATE);

    usePodcast(undefined);

    expect(lastQueryOptions().enabled).toBe(false);
  });
});
