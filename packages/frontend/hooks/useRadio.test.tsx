import { useInfiniteQuery } from '@tanstack/react-query';
import type { RadioPage, RadioSeed } from '@syra/shared-types';
import { RADIO_QUERY_KEYS, useRadioStation } from './useRadio';
import { useAuthGate, type AuthGate } from '@/hooks/useAuthGate';

/**
 * The hook is exercised through the options it hands React Query rather than
 * through a renderer: what has to hold is that a guest station can never be
 * served to an authenticated listener, and that nothing is fetched until the
 * Oxy session has actually resolved into one identity or the other.
 */

jest.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: jest.fn(() => ({})),
  useMutation: jest.fn(() => ({})),
  useQueryClient: jest.fn(() => ({ removeQueries: jest.fn() })),
}));

jest.mock('@/hooks/useAuthGate', () => ({
  useAuthGate: jest.fn(),
}));

jest.mock('@/services/radioService', () => ({
  radioService: {
    getPage: jest.fn(),
    reset: jest.fn(),
  },
}));

const mockUseInfiniteQuery = useInfiniteQuery as jest.MockedFunction<typeof useInfiniteQuery>;
const mockUseAuthGate = useAuthGate as jest.MockedFunction<typeof useAuthGate>;

const SEED: RadioSeed = { seedType: 'artist', seedId: 'artist-1' };

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

const GUEST_GATE: AuthGate = {
  ...RESOLVING_GATE,
  status: 'guest',
  isResolving: false,
  isResolved: true,
};

const AUTH_GATE: AuthGate = {
  ...GUEST_GATE,
  status: 'authenticated',
  canUsePrivateApi: true,
  isAuthenticated: true,
  catalogIdentity: 'auth',
};

function page(cursor: string | null): RadioPage {
  return {
    station: {
      seedType: 'artist',
      seedId: 'artist-1',
      title: 'Artist One Radio',
      subtitle: 'Based on Artist One',
      personalized: false,
      wrapped: false,
    },
    tracks: [],
    cursor,
    gate: null,
  };
}

/** The options the hook passed to `useInfiniteQuery` on its most recent call. */
function lastQueryOptions() {
  const calls = mockUseInfiniteQuery.mock.calls;
  return calls[calls.length - 1][0];
}

describe('useRadioStation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('caches a guest station under a different key than an authenticated one', () => {
    mockUseAuthGate.mockReturnValue(GUEST_GATE);
    useRadioStation(SEED);
    const guestKey = lastQueryOptions().queryKey;

    mockUseAuthGate.mockReturnValue(AUTH_GATE);
    useRadioStation(SEED);
    const authKey = lastQueryOptions().queryKey;

    expect(guestKey).toEqual(RADIO_QUERY_KEYS.station('guest', 'artist', 'artist-1'));
    expect(authKey).toEqual(RADIO_QUERY_KEYS.station('auth', 'artist', 'artist-1'));
    expect(guestKey).not.toEqual(authKey);
  });

  it('stays disabled while the auth gate is unresolved', () => {
    mockUseAuthGate.mockReturnValue(RESOLVING_GATE);

    useRadioStation(SEED);

    expect(lastQueryOptions().enabled).toBe(false);
  });

  it('enables the station once the gate reaches a terminal identity', () => {
    mockUseAuthGate.mockReturnValue(GUEST_GATE);

    useRadioStation(SEED);

    expect(lastQueryOptions().enabled).toBe(true);
  });

  it('stays disabled without a seed', () => {
    mockUseAuthGate.mockReturnValue(AUTH_GATE);

    useRadioStation(null);

    expect(lastQueryOptions().enabled).toBe(false);
  });

  it('never refetches a station on its own — pages are stateful server-side', () => {
    mockUseAuthGate.mockReturnValue(AUTH_GATE);

    useRadioStation(SEED);
    const options = lastQueryOptions();

    expect(options.staleTime).toBe(Infinity);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchOnMount).toBe(false);
    expect(options.initialPageParam).toBeNull();
  });

  it('paginates on the station cursor and stops when the station closes', () => {
    mockUseAuthGate.mockReturnValue(AUTH_GATE);

    useRadioStation(SEED);
    const { getNextPageParam } = lastQueryOptions();

    expect(getNextPageParam(page('cursor-2'), [], null, [])).toBe('cursor-2');
    expect(getNextPageParam(page(null), [], null, [])).toBeNull();
  });
});
