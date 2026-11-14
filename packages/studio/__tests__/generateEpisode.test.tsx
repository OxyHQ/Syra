import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EpisodeGeneration, Podcast } from '@syra/shared-types';
import GenerateEpisodeScreen from '@/app/podcasts/[id]/generate';
import { generationService } from '@/services/generationService';

/**
 * The generate screen asks for what the show is about only on its FIRST
 * generated episode, and after that "another episode" is one press with
 * nothing filled in. Outside `app/` because every file there is a route.
 */

jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => () => null);
jest.mock('@oxy.so/bloom/button', () => {
  const { Pressable } = jest.requireActual('react-native');
  return {
    Button: ({
      onPress,
      disabled,
      testID,
      children,
    }: {
      onPress?: () => void;
      disabled?: boolean;
      testID?: string;
      children?: React.ReactNode;
    }) => (
      <Pressable testID={testID} onPress={disabled ? () => undefined : onPress}>
        {children}
      </Pressable>
    ),
  };
});
jest.mock('@oxy.so/bloom/skeleton', () => ({ Box: () => null }));
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: () => null }));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#666', primary: '#00f' } }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({ id: 'show-1' }),
  usePathname: () => '/podcasts/show-1/generate',
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({
    user: { id: 'owner-1' },
    canUsePrivateApi: true,
    isPrivateApiPending: false,
    openAccountDialog: jest.fn(),
  }),
}));
jest.mock('@/lib/oxyServices', () => ({
  oxyServices: { createLinkedClient: () => ({ client: {} }) },
}));
jest.mock('@/services/podcastService', () => ({
  podcastService: { getPodcast: jest.fn() },
  podcastRssUrl: () => '',
}));
jest.mock('@/services/episodeService', () => ({ episodeService: {} }));
jest.mock('@/services/generationService', () => ({
  generationService: { listGenerations: jest.fn(), generateEpisode: jest.fn() },
}));

const { podcastService } = jest.requireMock('@/services/podcastService') as {
  podcastService: { getPodcast: jest.Mock };
};
const listGenerations = generationService.listGenerations as jest.Mock;
const generateEpisode = generationService.generateEpisode as jest.Mock;

const SHOW = {
  id: 'show-1',
  title: 'Hive',
  description: 'A show about bees.',
  source: 'syra',
  ownerOxyUserId: 'owner-1',
  status: 'active',
} as Podcast;

const DONE: EpisodeGeneration = {
  episodeId: 'ep-1',
  podcastId: 'show-1',
  status: 'completed',
  progress: 100,
  topic: 'Why bees dance',
  segments: [],
  error: null,
  createdAt: '2026-11-14T00:00:00.000Z',
  updatedAt: '2026-11-14T00:00:00.000Z',
};

let queryClient: QueryClient;
let tree: ReactTestRenderer | undefined;

async function render(): Promise<ReactTestRenderer> {
  await act(async () => {
    tree = create(
      <QueryClientProvider client={queryClient}>
        <GenerateEpisodeScreen />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  if (!tree) throw new Error('did not mount');
  return tree;
}

const texts = (root: ReactTestRenderer) =>
  root.root
    .findAll((node) => typeof node.props?.children === 'string')
    .map((node) => node.props.children as string);

async function pressGenerate(root: ReactTestRenderer): Promise<void> {
  const [button] = root.root.findAll(
    (node) =>
      node.props?.testID === 'generate-episode-button' && typeof node.props?.onPress === 'function',
    { deep: false },
  );
  if (!button) throw new Error('no generate button');
  await act(async () => {
    button.props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  // `gcTime: Infinity` so no garbage-collection timer outlives the test.
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  podcastService.getPodcast.mockResolvedValue({ podcast: SHOW, episodes: [] });
  generateEpisode.mockResolvedValue({ ...DONE, status: 'queued', progress: 0, topic: null });
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  queryClient.clear();
  jest.clearAllMocks();
});

it('asks for the brief and format on the first episode, prefilled from the description', async () => {
  listGenerations.mockResolvedValue([]);
  const root = await render();
  expect(texts(root)).toContain('What the show is about');
  await pressGenerate(root);
  expect(generateEpisode).toHaveBeenCalledWith('show-1', {
    brief: 'A show about bees.',
    format: 'podcast',
  });
});

it('generates the next episode with nothing filled in once the show has one', async () => {
  listGenerations.mockResolvedValue([DONE]);
  const root = await render();
  expect(texts(root)).not.toContain('What the show is about');
  expect(texts(root)).toContain('Why bees dance');
  await pressGenerate(root);
  expect(generateEpisode).toHaveBeenCalledWith('show-1', {});
});
