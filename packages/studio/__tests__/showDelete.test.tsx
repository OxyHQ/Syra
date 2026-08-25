import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Podcast } from '@syra/shared-types';
import ShowDetailScreen from '@/app/podcasts/[id]/index';
import { podcastService } from '@/services/podcastService';

/**
 * "The Wednesday Musk" is why this file exists: a real published show, seven
 * episodes, deleted by its creator in the app that made it and still standing
 * in Syra because `DELETE /podcasts/:id` shipped with nothing calling it. One
 * source of truth means the delete has to be reachable from the surface where
 * an owner manages their shows.
 *
 * It lives OUTSIDE `app/` on purpose: every file under `app/` is an Expo Router
 * route, so a test placed beside the screen would publish itself at
 * `/podcasts/[id]/showDelete.test`.
 *
 * The screen renders for real — the mutation, the cache invalidation and the
 * ownership gate all run. What is stubbed is the boundary around it: bloom's
 * own surfaces (whose behaviour is bloom's, tested there), the router, the Oxy
 * session, and the HTTP service whose call this file is asserting.
 */

const mockDialogProps: Record<string, unknown>[] = [];

jest.mock('@oxyhq/bloom/alert-dialog', () => ({
  AlertDialog: (props: Record<string, unknown>) => {
    mockDialogProps.push(props);
    return null;
  },
}));

jest.mock('@oxyhq/bloom/button', () => {
  const { Pressable } = jest.requireActual('react-native');
  // Modelled on the real Button in the one respect this file depends on: a
  // disabled or loading button does not fire. A passthrough that always fired
  // would report a button that cannot block a second press as if it could.
  return {
    Button: ({
      onPress,
      disabled,
      loading,
      testID,
      children,
    }: {
      onPress?: () => void;
      disabled?: boolean;
      loading?: boolean;
      testID?: string;
      children?: React.ReactNode;
    }) => (
      <Pressable testID={testID} onPress={disabled || loading ? () => undefined : onPress}>
        {children}
      </Pressable>
    ),
  };
});

jest.mock('@oxyhq/bloom/loading', () => ({ Loading: () => null }));
jest.mock('@oxyhq/bloom/badge', () => ({ Badge: () => null }));
jest.mock('@oxyhq/bloom/toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({ colors: { error: '#f00', text: '#000', textSecondary: '#666', primary: '#00f' } }),
}));

jest.mock('@/components/Artwork', () => ({ Artwork: () => null }));
jest.mock('@/components/CopyableField', () => ({ CopyableField: () => null }));

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockBack = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush, back: mockBack }),
  useLocalSearchParams: () => ({ id: 'show-1' }),
  usePathname: () => '/podcasts/show-1',
}));

let mockViewerId: string | undefined = 'owner-1';

jest.mock('@oxyhq/services', () => ({
  useOxy: () => ({
    user: mockViewerId ? { id: mockViewerId } : undefined,
    canUsePrivateApi: true,
    isPrivateApiPending: false,
    openAccountDialog: jest.fn(),
  }),
}));

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: { createLinkedClient: () => ({ client: {} }) },
}));

jest.mock('@/services/podcastService', () => ({
  podcastService: { getPodcast: jest.fn(), deletePodcast: jest.fn() },
  podcastRssUrl: () => 'https://syra.fm/api/podcasts/show-1/rss',
}));

jest.mock('@/services/episodeService', () => ({
  episodeService: { deleteEpisode: jest.fn() },
}));

const mockGetPodcast = podcastService.getPodcast as jest.MockedFunction<typeof podcastService.getPodcast>;
const mockDeletePodcast = podcastService.deletePodcast as jest.MockedFunction<
  typeof podcastService.deletePodcast
>;

const SHOW = {
  id: 'show-1',
  title: 'The Wednesday Musk',
  explicit: false,
  type: 'episodic',
  source: 'syra',
  ownerOxyUserId: 'owner-1',
  refreshIntervalMin: 60,
  episodeCount: 7,
  status: 'active',
  visibility: 'public',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
} as Podcast;

let queryClient: QueryClient;
let invalidateQueries: jest.SpyInstance;
let removeQueries: jest.SpyInstance;

async function renderScreen(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <QueryClientProvider client={queryClient}>
        <ShowDetailScreen />
      </QueryClientProvider>,
    );
  });

  // React Query settles over a chain of microtasks, and one flush is not
  // reliably enough: a screen still in its loading state renders no controls at
  // all, which reads exactly like "the owner was offered no delete". A macrotask
  // turn settles it deterministically.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // Positive control for the flush above. The loading branch renders no show
  // title, so its absence means the screen never got past loading — and every
  // "no delete control was offered" assertion below would be vacuous.
  const showedTitle = tree.root.findAll(
    (node) => typeof node.props?.children === 'string' && node.props.children.includes('The Wednesday Musk'),
  );
  if (showedTitle.length === 0) {
    throw new Error('the show never loaded — the screen is still in its loading state');
  }

  return tree;
}

/**
 * Found by testID rather than by component type: NativeWind rewrites the
 * element it compiles `className` onto, so matching on `Pressable` finds
 * nothing and every press below would silently do nothing while the assertions
 * still passed.
 */
function deleteButtons(tree: ReactTestRenderer) {
  // `deep: false` stops the search at each match. Without it the mocked Button
  // and the Pressable it renders both carry the testID, so one control counts
  // as two.
  return tree.root.findAll(
    (node) => node.props?.testID === 'delete-show-button' && typeof node.props?.onPress === 'function',
    { deep: false },
  );
}

function pressDelete(tree: ReactTestRenderer): void {
  const [button] = deleteButtons(tree);
  if (!button) throw new Error('no delete control rendered — nothing was pressed');
  act(() => {
    button.props.onPress();
  });
}

/**
 * Let anything the last press scheduled actually run.
 *
 * React Query dispatches a mutation over microtasks, so a synchronous
 * "the service was not called" assertion passes even when the press DID fire
 * one — it just has not landed yet. Every such assertion below is made after a
 * flush, or it measures nothing.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function lastDialog(): Record<string, unknown> {
  const props = mockDialogProps[mockDialogProps.length - 1];
  if (!props) throw new Error('no AlertDialog was rendered');
  return props;
}

beforeEach(() => {
  mockDialogProps.length = 0;
  jest.clearAllMocks();
  mockViewerId = 'owner-1';
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');
  removeQueries = jest.spyOn(queryClient, 'removeQueries');
  mockGetPodcast.mockResolvedValue({ podcast: SHOW, episodes: [] });
  mockDeletePodcast.mockResolvedValue({ id: 'show-1', episodesDeleted: 7, objectsDeleted: 31 });
});

afterEach(() => {
  // In `afterEach`, never at the end of a body: a failing assertion skips
  // whatever follows it, so cleanup written inline leaks into the next test.
  queryClient.clear();
});

describe('who the show screen offers a delete to', () => {
  it('offers it to the signed-in owner of a Syra-hosted show', async () => {
    const tree = await renderScreen();
    expect(deleteButtons(tree)).toHaveLength(1);
  });

  /**
   * Each row is a refusal `loadOwnedShowOrRespond` already makes — a 403 for
   * someone else's show or an RSS-mirrored one, a 409 for a platform takedown.
   * `getPodcast` is a VIEWER read, so a creator really can reach another
   * creator's public show at this URL.
   */
  it.each([
    ['a viewer who is not the owner', { podcast: SHOW }, 'someone-else'],
    ['a signed-out viewer', { podcast: SHOW }, undefined],
    ['an RSS-mirrored show that belongs to nobody', { podcast: { ...SHOW, source: 'rss' as const } }, 'owner-1'],
    ['a show under a platform takedown', { podcast: { ...SHOW, status: 'removed' as const } }, 'owner-1'],
    [
      'an unowned show seen by a viewer with no id — two undefineds must not compare into a grant',
      { podcast: { ...SHOW, ownerOxyUserId: undefined } },
      undefined,
    ],
  ])('offers none to %s', async (_case, override, viewer) => {
    mockViewerId = viewer;
    mockGetPodcast.mockResolvedValue({ podcast: override.podcast as Podcast, episodes: [] });

    const tree = await renderScreen();

    expect(deleteButtons(tree)).toHaveLength(0);
    expect(mockDeletePodcast).not.toHaveBeenCalled();
  });
});

describe('the show screen delete affordance', () => {
  it('asks before it deletes — pressing delete opens a confirmation and calls nothing', async () => {
    const tree = await renderScreen();

    expect(lastDialog().visible).toBe(false);
    pressDelete(tree);
    await flush();

    expect(mockDeletePodcast).not.toHaveBeenCalled();
    expect(lastDialog().visible).toBe(true);
  });

  it('names the show and the number of episodes going with it', async () => {
    const tree = await renderScreen();
    pressDelete(tree);

    expect(String(lastDialog().title)).toContain('The Wednesday Musk');
    const description = String(lastDialog().description);
    expect(description).toContain('The Wednesday Musk');
    expect(description).toContain('7 episodes');
    expect(lastDialog().destructive).toBe(true);
  });

  it('counts the episodes the SHOW has, not the page the screen is holding', async () => {
    // The screen renders one episode; the show has seven. A confirmation built
    // from `episodes.length` would promise to destroy one of the seven.
    mockGetPodcast.mockResolvedValue({
      podcast: SHOW,
      episodes: [
        {
          id: 'ep-1',
          podcastId: 'show-1',
          title: 'One',
          status: 'ready',
          duration: 60,
          pubDate: '2026-08-01T00:00:00.000Z',
        } as never,
      ],
    });
    const tree = await renderScreen();
    pressDelete(tree);

    expect(String(lastDialog().description)).toContain('7 episodes');
  });

  it('deletes nothing when the confirmation is dismissed', async () => {
    const tree = await renderScreen();
    pressDelete(tree);

    act(() => {
      (lastDialog().onClose as () => void)();
    });
    await flush();

    expect(mockDeletePodcast).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(lastDialog().visible).toBe(false);
  });

  it('deletes exactly this show, exactly once, when the confirmation is confirmed', async () => {
    const tree = await renderScreen();
    pressDelete(tree);

    await act(async () => {
      (lastDialog().onConfirm as () => void)();
    });

    expect(mockDeletePodcast).toHaveBeenCalledTimes(1);
    expect(mockDeletePodcast).toHaveBeenCalledWith('show-1');
  });

  it('leaves the show screen once the show is gone', async () => {
    const tree = await renderScreen();
    pressDelete(tree);

    await act(async () => {
      (lastDialog().onConfirm as () => void)();
    });

    // `replace`, not `push`: the screen being left is a show that no longer
    // exists, so it must not stay on the back stack.
    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('refreshes the dashboard and drops the deleted show’s own caches', async () => {
    const tree = await renderScreen();
    pressDelete(tree);

    await act(async () => {
      (lastDialog().onConfirm as () => void)();
    });

    const invalidated = invalidateQueries.mock.calls.map((call) => call[0].queryKey);
    expect(invalidated).toContainEqual(['studio', 'podcasts', 'mine']);

    // Removed rather than invalidated: invalidating asks the screen to refetch
    // a row that no longer exists, which answers 404.
    const removed = removeQueries.mock.calls.map((call) => call[0].queryKey);
    expect(removed).toContainEqual(['studio', 'podcasts', 'detail', 'show-1']);
    expect(removed).toContainEqual(['studio', 'podcasts', 'episodes', 'show-1']);
  });

  it('stays put and refreshes nothing when the delete is refused', async () => {
    mockDeletePodcast.mockRejectedValue(new Error('You do not own this podcast'));
    const tree = await renderScreen();
    pressDelete(tree);

    await act(async () => {
      (lastDialog().onConfirm as () => void)();
    });

    // Navigating away on a 403 would read to the creator as a delete that
    // worked — and the show would still be on the dashboard they land on.
    expect(mockReplace).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(removeQueries).not.toHaveBeenCalled();
  });
});
