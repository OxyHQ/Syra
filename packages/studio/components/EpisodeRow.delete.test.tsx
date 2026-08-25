import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Episode } from '@syra/shared-types';
import { EpisodeRow } from './EpisodeRow';
import { episodeService } from '@/services/episodeService';

/**
 * The affordance this file exists for: `DELETE /episodes/:id` shipped behind
 * auth and NOTHING in either client called it, so a creator could not remove an
 * episode anywhere in the product. What has to hold is not that a request can
 * be made — it is that it takes a confirmation to make one.
 *
 * Bloom's `AlertDialog` is replaced by a passthrough that renders nothing and
 * exposes the props it was handed. Its own open/close/animation behaviour is
 * bloom's, tested there; what is Syra's is WHICH handler destroys an episode,
 * and the mock is what lets this file drive confirm and cancel separately
 * rather than through a Dialog whose exit animation would have to be waited on.
 */

const dialogProps: Record<string, unknown>[] = [];

jest.mock('@oxyhq/bloom/alert-dialog', () => ({
  AlertDialog: (props: Record<string, unknown>) => {
    dialogProps.push(props);
    return null;
  },
}));

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({ colors: { error: '#ff0000', text: '#000', textSecondary: '#666', primary: '#00f' } }),
}));

jest.mock('@oxyhq/bloom/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock('@oxyhq/bloom/badge', () => ({
  Badge: () => null,
}));

jest.mock('@/components/Artwork', () => ({
  Artwork: () => null,
}));

// `hooks/usePodcasts` pulls the Oxy session in for its queries. Nothing on the
// delete path reads it, and the package ships untranspiled sources that jest
// cannot load, so it is stubbed at the boundary.
jest.mock('@oxyhq/services', () => ({
  useOxy: () => ({ user: { id: 'owner-1' }, canUsePrivateApi: true, isPrivateApiPending: false }),
}));

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: { createLinkedClient: () => ({ client: {} }) },
}));

jest.mock('@/services/episodeService', () => ({
  episodeService: { deleteEpisode: jest.fn() },
}));

const mockDeleteEpisode = episodeService.deleteEpisode as jest.MockedFunction<
  typeof episodeService.deleteEpisode
>;

const EPISODE: Episode = {
  id: 'ep-1',
  podcastId: 'show-1',
  podcastTitle: 'The Wednesday Musk',
  title: 'Episode One',
  guid: 'guid-1',
  duration: 1800,
  pubDate: '2026-08-01T00:00:00.000Z',
  episodeType: 'full',
  explicit: false,
  status: 'ready',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
} as Episode;

/**
 * A real React Query client with its cache methods watched, rather than a
 * stubbed `useQueryClient`: the hook under test IS the invalidation, so what
 * has to run is `useMutation`'s own success path, not a hand-written stand-in
 * for it.
 */
let queryClient: QueryClient;
let invalidateQueries: jest.SpyInstance;
let removeQueries: jest.SpyInstance;

function renderRow(deletable: boolean): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <QueryClientProvider client={queryClient}>
        <EpisodeRow episode={EPISODE} deletable={deletable} />
      </QueryClientProvider>,
    );
  });
  return tree;
}

/**
 * The row's delete triggers, found by testID rather than by component type:
 * NativeWind rewrites the element it compiles `className` onto, so a
 * `findAllByType(Pressable)` matches nothing and every press below would
 * silently do nothing while the assertions still passed.
 */
function deleteTriggers(tree: ReactTestRenderer) {
  return tree.root.findAll(
    (node) => node.props?.testID === 'delete-episode-ep-1' && typeof node.props?.onPress === 'function',
  );
}

/** Press the row's delete control, failing loudly when there is none to press. */
function pressDelete(tree: ReactTestRenderer): void {
  const [trigger] = deleteTriggers(tree);
  if (!trigger) throw new Error('no delete control rendered — nothing was pressed');
  act(() => {
    trigger.props.onPress();
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

/** The props of the most recent `AlertDialog` render. */
function lastDialog(): Record<string, unknown> {
  const props = dialogProps[dialogProps.length - 1];
  if (!props) throw new Error('no AlertDialog was rendered');
  return props;
}

beforeEach(() => {
  dialogProps.length = 0;
  jest.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');
  removeQueries = jest.spyOn(queryClient, 'removeQueries');
  mockDeleteEpisode.mockResolvedValue({ id: 'ep-1', podcastId: 'show-1', objectsDeleted: 3 });
});

afterEach(() => {
  // In `afterEach`, never at the end of a body: a failing assertion skips
  // whatever follows it, so cleanup written inline leaks into the next test —
  // and a leaked cache is exactly what makes a broken mutation look green.
  queryClient.clear();
});

describe('EpisodeRow delete affordance', () => {
  it('offers no delete control to a viewer who does not own the show', () => {
    const tree = renderRow(false);

    expect(deleteTriggers(tree)).toHaveLength(0);
    expect(dialogProps).toHaveLength(0);
  });

  it('asks before it deletes — pressing delete opens a confirmation and calls nothing', async () => {
    const tree = renderRow(true);

    expect(lastDialog().visible).toBe(false);

    pressDelete(tree);
    await flush();

    expect(mockDeleteEpisode).not.toHaveBeenCalled();
    expect(lastDialog().visible).toBe(true);
  });

  it('names the episode it is about to destroy, and says the loss is permanent', () => {
    const tree = renderRow(true);
    pressDelete(tree);

    expect(lastDialog().title).toContain('Episode One');
    expect(lastDialog().destructive).toBe(true);
    expect(String(lastDialog().description)).toMatch(/cannot be restored/i);
  });

  it('deletes nothing when the confirmation is dismissed', async () => {
    const tree = renderRow(true);
    pressDelete(tree);

    act(() => {
      (lastDialog().onClose as () => void)();
    });
    await flush();

    expect(mockDeleteEpisode).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(lastDialog().visible).toBe(false);
  });

  it('deletes exactly this episode, exactly once, when the confirmation is confirmed', async () => {
    const tree = renderRow(true);
    pressDelete(tree);

    await act(async () => {
      (lastDialog().onConfirm as () => void)();
    });

    expect(mockDeleteEpisode).toHaveBeenCalledTimes(1);
    expect(mockDeleteEpisode).toHaveBeenCalledWith('ep-1');
    // The dialog closes on confirm too: leaving it open would let a second
    // press fire a second DELETE at a row that is already gone.
    expect(lastDialog().visible).toBe(false);
  });

  it('refreshes the lists that showed the episode once the delete succeeds', async () => {
    const tree = renderRow(true);
    pressDelete(tree);

    await act(async () => {
      (lastDialog().onConfirm as () => void)();
    });

    // The show survives an episode delete, so these are invalidated (refetched)
    // rather than removed — and `mine` is among them because the dashboard card
    // carries the `episodeCount` the backend just recomputed.
    const invalidated = invalidateQueries.mock.calls.map((call) => call[0].queryKey);
    expect(invalidated).toContainEqual(['studio', 'podcasts', 'detail', 'show-1']);
    expect(invalidated).toContainEqual(['studio', 'podcasts', 'episodes', 'show-1']);
    expect(invalidated).toContainEqual(['studio', 'podcasts', 'mine']);
    // And nothing is REMOVED: the show is still there to be refetched, so
    // dropping its cache would leave the open screen with nothing to render.
    expect(removeQueries).not.toHaveBeenCalled();
  });

  it('refreshes nothing when the delete is refused', async () => {
    mockDeleteEpisode.mockRejectedValue(new Error('You do not own this podcast'));
    const tree = renderRow(true);
    pressDelete(tree);

    await act(async () => {
      (lastDialog().onConfirm as () => void)();
    });

    // A 403 that still refreshed the list would read to the creator as a
    // delete that worked, right up until the row came back.
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
