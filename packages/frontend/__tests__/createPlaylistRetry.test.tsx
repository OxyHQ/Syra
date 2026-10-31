import TestRenderer, { act } from 'react-test-renderer';
import { OxyServices } from '@oxy.so/core';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

const mockOxy = new OxyServices({ baseURL: 'https://identity.example', enableCache: false });
const mockToast = { error: jest.fn(), success: jest.fn() };
const mockRouter = { replace: jest.fn(), back: jest.fn() };
jest.mock('@/lib/oxyServices', () => ({ oxyServices: mockOxy }));
jest.mock('@/config', () => ({ API_URL: 'https://syra.example' }));
jest.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({ isAuthenticated: true }) }));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: mockToast }));
jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({
    colors: {
      text: '#000',
      textSecondary: '#000',
      primary: '#000',
      primaryForeground: '#fff',
      backgroundSecondary: '#fff',
      border: '#000',
    },
  }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'Icon');
jest.mock('@/components/playlists/CoverArtPicker', () => ({ CoverArtPicker: () => null }));
jest.mock('@/components/SEO', () => ({ __esModule: true, default: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const CreatePlaylistScreen = require('@/app/create-playlist').default;
const { QUERY_CLIENT_CONFIG } = require('@/components/providers/constants');
const token = `e30.${Buffer.from(JSON.stringify({ userId: 'alice', sessionId: 'alice', exp: 2000000000 })).toString('base64url')}.fixture`;
const originalFetch = globalThis.fetch;
let renderer: TestRenderer.ReactTestRenderer;
let client: QueryClient;

function submit() {
  let button = renderer.root.findByProps({ children: 'common.create' }).parent;
  while (button && typeof button.props.onPress !== 'function') button = button.parent;
  if (!button) throw new Error('Create button not found');
  button.props.onPress();
}

beforeEach(async () => {
  jest.clearAllMocks();
  onlineManager.setOnline(true);
  mockOxy.session.setAccessToken(token);
  client = new QueryClient({
    ...QUERY_CLIENT_CONFIG,
    defaultOptions: {
      ...QUERY_CLIENT_CONFIG.defaultOptions,
      mutations: { ...QUERY_CLIENT_CONFIG.defaultOptions.mutations, retryDelay: 1 },
    },
  });
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <CreatePlaylistScreen />
      </QueryClientProvider>,
    );
  });
});

afterEach(async () => {
  await act(async () => renderer.unmount());
  client.clear();
  onlineManager.setOnline(true);
  globalThis.fetch = originalFetch;
});

it('still runs a same-session create that was queued while offline', async () => {
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    status: 201,
    headers: { get: () => 'application/json' },
    json: async () => ({
      id: 'playlist',
      name: 'Alice playlist',
      ownerOxyUserId: 'alice',
      ownerUsername: 'alice',
      visibility: 'private',
      trackCount: 0,
      totalDuration: 0,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }),
    text: async () => '{}',
  })) as unknown as typeof fetch;
  onlineManager.setOnline(false);
  await act(async () => {
    renderer.root
      .findByProps({ placeholder: 'createPlaylist.namePlaceholder' })
      .props.onChangeText('Alice playlist');
  });
  await act(async () => {
    submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const mutation = client.getMutationCache().getAll()[0];
  expect(mutation.state.isPaused).toBe(true);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await act(async () => {
    onlineManager.setOnline(true);
    await mutation.continue();
  });
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(mockRouter.replace).toHaveBeenCalled();
});
afterAll(() => mockOxy.dispose());

it('sends one create request and preserves the form when the server accepted it but the response was lost', async () => {
  let accepted = 0;
  globalThis.fetch = jest.fn(async () => {
    accepted += 1;
    throw new TypeError('Connection lost after server accepted the POST');
  }) as typeof fetch;
  await act(async () => {
    renderer.root
      .findByProps({ placeholder: 'createPlaylist.namePlaceholder' })
      .props.onChangeText('Alice private playlist');
  });
  await act(async () => {
    submit();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(accepted).toBe(1);
  expect(
    renderer.root.findByProps({ placeholder: 'createPlaylist.namePlaceholder' }).props.value,
  ).toBe('Alice private playlist');
  expect(mockToast.error).toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});
