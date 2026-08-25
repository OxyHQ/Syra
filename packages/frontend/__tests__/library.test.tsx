import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { podcastSchema, type Podcast, type PodcastSubscriptions } from '@syra/shared-types';

/**
 * The library screen's query-backed sections, tested for the failure they
 * shipped with: a REJECTED query was indistinguishable from an empty one.
 *
 * `useMyPodcasts()` calls `podcastService.getMyPodcasts()`, which runs
 * `parsePodcastResponse` and THROWS on a 401 or on a single drifted DTO field.
 * The rejection left `myPodcasts` at `?? []`, so the section vanished and the
 * empty state told a creator whose shows exist that they had never made one —
 * no message, no spinner, nothing to retry. Subscriptions, in-progress episodes
 * and the uploads locker swallowed their failures the same way.
 *
 * The screen renders against a REAL React Query client over stubbed services
 * rather than hand-written query objects, so `isPending` / `isError` / `refetch`
 * are the library's own values and a fixture cannot quietly disagree with what
 * the screen sees in production. Only the leaf hooks that would drag in Oxy's
 * session, the audio player or a native module are mocked.
 *
 * `t` is the identity function here, so the assertions read as i18n KEYS: they
 * survive a copy edit and go red on a key rename, which is the half of
 * `check-i18n` that does not cover test files.
 */

jest.mock('@oxyhq/services', () => ({
  useOxy: () => ({ canUsePrivateApi: true, isAuthenticated: true, isPrivateApiPending: false }),
}));

jest.mock('@oxyhq/bloom/toast', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({
    colors: {
      text: '#000000',
      textSecondary: '#666666',
      primary: '#111111',
      primaryForeground: '#ffffff',
      card: '#ffffff',
      error: '#cc0000',
    },
  }),
}));

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

// `t` as the identity function: see the header note on why the assertions below
// read as keys.
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Icons render their glyph as TEXT, which would land in every assertion below
// and make an exact-label match impossible.
jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
  Octicons: () => null,
  MaterialCommunityIcons: () => null,
}));

// The screen uses reanimated for `Animated.ScrollView` and nothing else; the
// real module needs the worklets runtime.
jest.mock('react-native-reanimated', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return { __esModule: true, default: { ScrollView } };
});

jest.mock('@/hooks/useCollapseOnScroll', () => ({
  useCollapseOnScroll: () => ({ expanded: { value: 1 }, scrollHandler: jest.fn() }),
}));

jest.mock('@/components/SEO', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/skeletons', () => ({ LibraryListSkeleton: () => null }));
jest.mock('@/components/ui/Fab', () => ({ Fab: () => null }));
jest.mock('@/components/EpisodeRow', () => ({ EpisodeRow: () => null }));

const mockPlayerState = { currentEpisode: null, isPlaying: false, playEpisode: jest.fn() };
jest.mock('@/stores/playerStore', () => ({
  usePlayerStore: (selector: (state: typeof mockPlayerState) => unknown) => selector(mockPlayerState),
}));

jest.mock('@/hooks/useLibrary', () => ({
  LIBRARY_QUERY_KEY: ['library'],
  useLibrary: () => ({ membership: {}, isLoading: false, isError: false }),
  withMembership: (current: unknown) => current,
}));

jest.mock('@/hooks/useAuthGate', () => ({
  useAuthGate: () => ({
    status: 'authenticated',
    isResolving: false,
    isTimedOut: false,
    isResolved: true,
    canUsePrivateApi: true,
    isAuthenticated: true,
    catalogIdentity: 'auth',
    retry: jest.fn(),
  }),
}));

// The playlist / artist / album collections already have an error path of their
// own (`finalError`); they are held healthy and empty so every assertion below
// is about the sections that had none.
jest.mock('@/hooks/useLibraryCollections', () => ({
  useLibraryCollections: () => ({
    playlists: [],
    savedAlbums: [],
    followedArtists: [],
    likedTracksCount: 0,
    loading: false,
    error: null,
    retry: jest.fn(),
  }),
}));

jest.mock('@/services/podcastService', () => ({
  podcastService: { getSubscriptions: jest.fn(), getMyPodcasts: jest.fn() },
}));

jest.mock('@/services/episodeService', () => ({
  episodeService: { getContinueListening: jest.fn() },
}));

jest.mock('@/services/uploadsService', () => ({
  uploadsService: { listUploads: jest.fn() },
}));

import { podcastService } from '@/services/podcastService';
import { episodeService } from '@/services/episodeService';
import { uploadsService } from '@/services/uploadsService';
import LibraryScreen from '@/app/library';

const getSubscriptions = podcastService.getSubscriptions as jest.MockedFunction<
  typeof podcastService.getSubscriptions
>;
const getMyPodcasts = podcastService.getMyPodcasts as jest.MockedFunction<
  typeof podcastService.getMyPodcasts
>;
const getContinueListening = episodeService.getContinueListening as jest.MockedFunction<
  typeof episodeService.getContinueListening
>;
const listUploads = uploadsService.listUploads as jest.MockedFunction<typeof uploadsService.listUploads>;

/** What `parsePodcastResponse` throws when the DTO drifts or the request 401s. */
const REJECTION = new Error('Invalid my podcasts response: expected string, received undefined');

/** Parsed through the real schema, so a fixture cannot drift out of the DTO. */
function podcast(id: string, title: string): Podcast {
  return podcastSchema.parse({
    id,
    title,
    author: 'A Creator',
    explicit: false,
    type: 'episodic',
    source: 'syra',
    refreshIntervalMin: 60,
    episodeCount: 3,
    status: 'active',
    visibility: 'public',
    aiGenerated: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

const NO_SUBSCRIPTIONS: PodcastSubscriptions = { subscriptions: [], total: 0, oxyUserId: 'oxy-1' };

let renderer: TestRenderer.ReactTestRenderer | undefined;
let client: QueryClient | undefined;

beforeEach(() => {
  getSubscriptions.mockResolvedValue(NO_SUBSCRIPTIONS);
  getMyPodcasts.mockResolvedValue([]);
  getContinueListening.mockResolvedValue([]);
  listUploads.mockResolvedValue({ uploads: [], total: 0, hasMore: false });
});

// In `afterEach`, not at the end of each test body: a failing assertion skips
// everything after it, and a leaked renderer or query client is exactly what a
// failing assertion would leave behind for the next test to inherit.
afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  client?.clear();
  client = undefined;
  jest.clearAllMocks();
});

async function renderLibrary(): Promise<TestRenderer.ReactTestInstance> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client = queryClient;
  await act(async () => {
    renderer = TestRenderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <QueryClientProvider client={queryClient}>
          <LibraryScreen />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  if (!renderer) {
    throw new Error('the library screen did not render');
  }
  await settle(queryClient, renderer.root);
  return renderer.root;
}

/**
 * Flushes until the screen has stopped moving: every query holding a TERMINAL
 * status, nothing in flight, and two consecutive flushes rendering the same
 * text. All three are needed — a fetch that has not STARTED yet also reports
 * nothing in flight, and a query can reach its terminal status a tick before
 * the render that shows it — and any one of them alone returns early and loses
 * the assertions a race.
 */
async function settle(queryClient: QueryClient, root: TestRenderer.ReactTestInstance): Promise<void> {
  const cache = queryClient.getQueryCache();
  let previous = '';
  for (let flush = 0; flush < 50; flush += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const queries = cache.getAll();
    const quiet =
      queries.length > 0 &&
      queryClient.isFetching() === 0 &&
      queries.every((query) => query.state.status !== 'pending');
    const rendered = JSON.stringify(textsOf(root));
    if (quiet && rendered === previous) {
      return;
    }
    previous = rendered;
  }
  throw new Error('the library screen never settled');
}

/** Every string the subtree renders, in tree order. */
function textsOf(node: TestRenderer.ReactTestInstance | string): string[] {
  if (typeof node === 'string') {
    return [node];
  }
  return node.children.flatMap(textsOf);
}

/**
 * Presses the pressable whose subtree renders `label` and nothing else — which
 * is what a filter chip and a "try again" button each are, and what neither a
 * podcast row nor any container around one is.
 *
 * One button can surface as several nodes (`TouchableOpacity` hands `onPress`
 * down to its animated host view), so the guard is that every match carries the
 * SAME handler — one button, however many nodes report it — rather than a node
 * count, which would be counting an implementation detail of react-native.
 */
async function press(root: TestRenderer.ReactTestInstance, label: string): Promise<void> {
  const matches = root.findAll(
    (node) => typeof node.props.onPress === 'function' && textsOf(node).join('') === label,
  );
  expect(matches.length).toBeGreaterThan(0);
  expect(new Set(matches.map((node) => node.props.onPress)).size).toBe(1);
  await act(async () => {
    await matches[0].props.onPress();
  });
}

describe('the library screen when a section query fails', () => {
  it('renders an error with a retry when the owned-shows query rejects', async () => {
    getMyPodcasts.mockRejectedValue(REJECTION);

    const rendered = textsOf(await renderLibrary());

    expect(rendered).toContain('library.errors.shows');
    expect(rendered).toContain('common.tryAgain');
  });

  it('does not call the library empty when the owned-shows query rejected', async () => {
    getMyPodcasts.mockRejectedValue(REJECTION);

    const root = await renderLibrary();

    // The screen opens on `All`, where every other section here is legitimately
    // empty. Before the fix the rejection read as "no shows", and this is the
    // copy the creator was shown over a library that exists.
    expect(textsOf(root)).not.toContain('library.empty.all');

    await press(root, 'library.yourShows');
    const onShowsFilter = textsOf(root);
    expect(onShowsFilter).toContain('library.errors.shows');
    expect(onShowsFilter).not.toContain('library.empty.shows');
  });

  it('still calls the library empty when the owned-shows query succeeded with nothing', async () => {
    const root = await renderLibrary();

    // The control the two assertions above need: same screen, same filters, the
    // only difference being that the query RESOLVED. So "not empty" above is
    // the rejection talking, not some unrelated reason the state never renders.
    expect(textsOf(root)).toContain('library.empty.all');

    await press(root, 'library.yourShows');
    const onShowsFilter = textsOf(root);
    expect(onShowsFilter).toContain('library.empty.shows');
    expect(onShowsFilter).not.toContain('library.errors.shows');
  });

  it('refetches only the failed section when its retry is pressed', async () => {
    getMyPodcasts.mockRejectedValue(REJECTION);

    const root = await renderLibrary();
    expect(getMyPodcasts).toHaveBeenCalledTimes(1);
    const subscriptionCalls = getSubscriptions.mock.calls.length;

    await press(root, 'common.tryAgain');

    expect(getMyPodcasts).toHaveBeenCalledTimes(2);
    expect(getSubscriptions).toHaveBeenCalledTimes(subscriptionCalls);
  });

  it('keeps rendering the sections that loaded', async () => {
    getMyPodcasts.mockRejectedValue(REJECTION);
    getSubscriptions.mockResolvedValue({
      subscriptions: [
        { podcast: podcast('p1', 'A Subscribed Show'), subscribedAt: '2026-01-01T00:00:00.000Z' },
      ],
      total: 1,
      oxyUserId: 'oxy-1',
    });

    const rendered = textsOf(await renderLibrary());

    expect(rendered).toContain('library.errors.shows');
    expect(rendered).toContain('A Subscribed Show');
  });

  it('renders the owned shows, and no error, when the query succeeds', async () => {
    getMyPodcasts.mockResolvedValue([podcast('p2', 'My Own Show')]);

    const rendered = textsOf(await renderLibrary());

    expect(rendered).toContain('My Own Show');
    expect(rendered).not.toContain('library.errors.shows');
    expect(rendered).not.toContain('library.empty.all');
  });

  // The sibling sections that swallowed a rejection the same way. Each is
  // checked on `All` (where it must not let the library be called empty) and on
  // its own filter (where it must not render its own empty copy).
  const SIBLINGS: {
    section: string;
    reject: () => void;
    errorKey: string;
    filterLabel: string;
    emptyKey: string;
  }[] = [
    {
      section: 'subscriptions',
      reject: () => getSubscriptions.mockRejectedValue(REJECTION),
      errorKey: 'library.errors.podcasts',
      filterLabel: 'common.podcasts',
      emptyKey: 'library.empty.podcasts',
    },
    {
      section: 'in-progress episodes',
      reject: () => getContinueListening.mockRejectedValue(REJECTION),
      errorKey: 'library.errors.episodes',
      filterLabel: 'common.episodes',
      emptyKey: 'library.empty.episodes',
    },
    {
      section: 'the uploads locker',
      reject: () => listUploads.mockRejectedValue(REJECTION),
      errorKey: 'uploads.locker.loadError',
      filterLabel: 'uploads.locker.title',
      emptyKey: 'uploads.locker.empty',
    },
  ];

  it.each(SIBLINGS)(
    'surfaces a rejected query for $section instead of an empty section',
    async ({ reject, errorKey, filterLabel, emptyKey }) => {
      reject();

      const root = await renderLibrary();
      const onAllFilter = textsOf(root);
      expect(onAllFilter).toContain(errorKey);
      expect(onAllFilter).not.toContain('library.empty.all');

      await press(root, filterLabel);
      const onOwnFilter = textsOf(root);
      expect(onOwnFilter).toContain(errorKey);
      expect(onOwnFilter).not.toContain(emptyKey);
    },
  );
});
