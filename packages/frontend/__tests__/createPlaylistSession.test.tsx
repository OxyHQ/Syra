import TestRenderer, { act } from 'react-test-renderer';
import { OxyServices } from '@oxy.so/core';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

const mockOxy = new OxyServices({ baseURL: 'https://identity.example', enableCache: false });
const mockToast = { error: jest.fn(), success: jest.fn() };
const mockRouter = { replace: jest.fn(), back: jest.fn() };
let mockIsAuthenticated = true;
let mockVisibleUser = 'alice';
jest.mock('@/lib/oxyServices', () => ({ oxyServices: mockOxy }));
jest.mock('@/config', () => ({ API_URL: 'https://syra.example' }));
jest.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ isAuthenticated: mockIsAuthenticated, user: { id: mockVisibleUser } }),
}));
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

let mockDiscardNextOwnerMemo = false;
const reactModule = require('react') as typeof import('react');
const realUseMemo = reactModule.useMemo;
jest.spyOn(reactModule, 'useMemo').mockImplementation(((factory, deps) => {
  const value = realUseMemo(factory, deps);
  if (
    mockDiscardNextOwnerMemo &&
    value !== null &&
    typeof value === 'object' &&
    Object.keys(value).length === 1 &&
    'accountId' in value
  ) {
    mockDiscardNextOwnerMemo = false;
    return { ...value };
  }
  return value;
}) as typeof reactModule.useMemo);

const linkedClients: Array<{ dispose(): void }> = [];
const createLinkedClient = mockOxy.createLinkedClient.bind(mockOxy);
jest.spyOn(mockOxy, 'createLinkedClient').mockImplementation((options) => {
  const linked = createLinkedClient(options);
  linkedClients.push(linked);
  return linked;
});
const CreatePlaylistScreen = require('@/app/create-playlist').default;
const {
  createAccountQueryPersistence,
} = require('../../../node_modules/@oxy.so/services/lib/commonjs/ui/hooks/accountQueryPersistence.js');
const token = (userId: string, version = 1) =>
  `e30.${Buffer.from(JSON.stringify({ userId, sessionId: userId, version, exp: 2000000000 })).toString('base64url')}.fixture`;
const response = () =>
  ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({
      id: 'playlist',
      name: 'Alice private playlist',
      ownerOxyUserId: 'alice',
      ownerUsername: 'alice',
      visibility: 'private',
      trackCount: 0,
      totalDuration: 0,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }),
    text: async () => '{}',
  }) as unknown as Response;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let renderer: TestRenderer.ReactTestRenderer;
let client: QueryClient;
let persistence: {
  setStorage(storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  }): void;
  activate(id: string | null): void;
  attach(): void;
  detach(): void;
};
const oldFetch = globalThis.fetch;

beforeEach(async () => {
  jest.clearAllMocks();
  mockIsAuthenticated = true;
  mockDiscardNextOwnerMemo = false;
  mockVisibleUser = 'alice';
  onlineManager.setOnline(true);
  mockOxy.session.setAccessToken(token('alice'));
  client = new QueryClient({ defaultOptions: { mutations: { retry: 1, retryDelay: 1 } } });
  persistence = createAccountQueryPersistence(client, {
    roots: 'all',
    memoryOnlyRoots: ['search'],
  });
  persistence.setStorage({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  });
  persistence.attach();
  persistence.activate('alice');
  await tick();
  globalThis.fetch = jest.fn(async () => response()) as typeof fetch;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <CreatePlaylistScreen />
      </QueryClientProvider>,
    );
  });
});

afterAll(() => {
  for (const linked of linkedClients) linked.dispose();
  mockOxy.dispose();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  persistence.detach();
  client.clear();
  onlineManager.setOnline(true);
  globalThis.fetch = oldFetch;
});

async function startOffline() {
  onlineManager.setOnline(false);
  await act(async () => {
    renderer.root
      .findByProps({ placeholder: 'createPlaylist.namePlaceholder' })
      .props.onChangeText('Alice private playlist');
  });
  await act(async () => {
    renderer.root.findByProps({ testID: 'create-playlist-submit' }).props.onPress();
    await tick();
  });
  const mutation = client.getMutationCache().getAll()[0];
  expect(mutation.state.isPaused).toBe(true);
  return mutation;
}

it('does not submit an offline playlist after A→B→A and resets the form', async () => {
  const mutation = await startOffline();
  await act(async () => {
    mockOxy.session.setAccessToken(token('bob'));
    persistence.activate('bob');
    mockOxy.session.setAccessToken(token('alice', 2));
    persistence.activate('alice');
    await tick();
  });
  expect(
    renderer.root.findByProps({ placeholder: 'createPlaylist.namePlaceholder' }).props.value,
  ).toBe('');
  expect(client.getMutationCache().getAll()).toContain(mutation);
  await act(async () => {
    onlineManager.setOnline(true);
    await mutation.continue().catch(() => undefined);
    await tick();
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(mockToast.error).not.toHaveBeenCalled();
  expect(mockToast.success).not.toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('resumes the same session offline work and reports success', async () => {
  const mutation = await startOffline();
  await act(async () => {
    mockOxy.session.setAccessToken(token('alice', 2));
  });
  await act(async () => {
    onlineManager.setOnline(true);
    await mutation.continue();
    await tick();
  });
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(mockToast.success).toHaveBeenCalledTimes(1);
  expect(mockRouter.replace).toHaveBeenCalledTimes(1);
});

it('suppresses success callbacks from a request completed after the account changed', async () => {
  let finish!: (response: Response) => void;
  globalThis.fetch = jest.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  ) as typeof fetch;
  await act(async () => {
    renderer.root
      .findByProps({ placeholder: 'createPlaylist.namePlaceholder' })
      .props.onChangeText('Alice private playlist');
  });
  await act(async () => {
    renderer.root.findByProps({ testID: 'create-playlist-submit' }).props.onPress();
    await tick();
  });
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    mockOxy.session.setAccessToken(token('bob'));
    persistence.activate('bob');
    await tick();
  });
  await act(async () => {
    finish(response());
    await tick();
  });
  expect(mockToast.success).not.toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('rejects queued A work after the SDK clears the token on 401 and B signs in', async () => {
  const mutation = await startOffline();
  const epoch = mockOxy.http.getSessionEpoch();
  globalThis.fetch = jest.fn(async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    headers: { get: () => 'application/json' },
    json: async () => ({ error: 'expired' }),
    text: async () => '{"error":"expired"}',
  })) as unknown as typeof fetch;
  await act(async () => {
    await mockOxy.http.get('/expired', { retry: false, deduplicate: false }).catch(() => undefined);
  });
  expect(mockOxy.http.getAccessToken()).toBeNull();
  expect(mockOxy.http.getSessionEpoch()).toBeGreaterThan(epoch);
  await act(async () => {
    mockOxy.session.setAccessToken(token('bob'));
    persistence.activate('bob');
    await tick();
  });
  jest.mocked(globalThis.fetch).mockClear();
  await act(async () => {
    onlineManager.setOnline(true);
    await mutation.continue().catch(() => undefined);
    await tick();
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(mockToast.error).not.toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('ignores an old create callback invoked after the account changes', async () => {
  await act(async () => {
    renderer.root
      .findByProps({ placeholder: 'createPlaylist.namePlaceholder' })
      .props.onChangeText('Alice private playlist');
  });
  const oldPress = renderer.root.findByProps({ testID: 'create-playlist-submit' }).props.onPress;
  await act(async () => {
    mockOxy.session.setAccessToken(token('bob'));
    persistence.activate('bob');
    await tick();
  });
  await act(async () => {
    oldPress();
    await tick();
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(mockToast.error).not.toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('suppresses errors from a request that fails after an account change', async () => {
  let fail!: (error: Error) => void;
  globalThis.fetch = jest.fn(
    () =>
      new Promise<Response>((_resolve, reject) => {
        fail = reject;
      }),
  ) as typeof fetch;
  await act(async () => {
    renderer.root
      .findByProps({ placeholder: 'createPlaylist.namePlaceholder' })
      .props.onChangeText('Alice private playlist');
  });
  await act(async () => {
    renderer.root.findByProps({ testID: 'create-playlist-submit' }).props.onPress();
    await tick();
  });
  await act(async () => {
    mockOxy.session.setAccessToken(token('bob'));
    persistence.activate('bob');
    await tick();
  });
  await act(async () => {
    fail(new Error('offline'));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  expect(mockToast.error).not.toHaveBeenCalled();
  expect(mockToast.success).not.toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('does not retry a late 401 from A as B', async () => {
  let finish!: (response: Response) => void;
  const requests: Array<Record<string, string>> = [];
  globalThis.fetch = jest.fn((_url, init) => {
    requests.push(init?.headers as Record<string, string>);
    if (requests.length === 1)
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    return Promise.resolve(response());
  }) as typeof fetch;
  const refresh = jest.fn(async () => token('bob', 2));
  mockOxy.http.setAuthRefreshHandler(refresh);
  await act(async () => {
    renderer.root
      .findByProps({ placeholder: 'createPlaylist.namePlaceholder' })
      .props.onChangeText('Alice private playlist');
  });
  await act(async () => {
    renderer.root.findByProps({ testID: 'create-playlist-submit' }).props.onPress();
    await tick();
  });
  await act(async () => {
    mockOxy.session.setAccessToken(token('bob'));
    persistence.activate('bob');
    await tick();
  });
  await act(async () => {
    finish({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'expired' }),
      text: async () => '{}',
    } as unknown as Response);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(requests).toHaveLength(1);
  expect(refresh).not.toHaveBeenCalled();
  expect(mockOxy.http.getAccessToken()).toBe(token('bob'));
  mockOxy.http.setAuthRefreshHandler(null);
});

it('still reports sign-in is required for the current signed-out form', async () => {
  mockIsAuthenticated = false;
  await act(async () => {
    mockOxy.http.clearTokens();
    persistence.activate(null);
    await tick();
  });
  await act(async () => {
    renderer.root
      .findByProps({ placeholder: 'createPlaylist.namePlaceholder' })
      .props.onChangeText('Playlist');
  });
  await act(async () => {
    renderer.root.findByProps({ testID: 'create-playlist-submit' }).props.onPress();
    await tick();
  });
  expect(mockToast.error).toHaveBeenCalledWith('createPlaylist.signInRequired');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('does not send a playlist when token B arrives before auth publishes user B', async () => {
  await act(async () => {
    mockOxy.session.setAccessToken(token('bob'));
    persistence.activate('bob');
    await tick();
  });
  expect(renderer.root.findByProps({ accessibilityRole: 'alert' }).props.children).toBe(
    'createPlaylist.sessionUnverified',
  );
  await act(async () => {
    renderer.root
      .findByProps({ placeholder: 'createPlaylist.namePlaceholder' })
      .props.onChangeText('Still visible as Alice');
  });
  const intermediatePress = renderer.root.findByProps({ testID: 'create-playlist-submit' }).props
    .onPress;
  await act(async () => {
    intermediatePress();
    await tick();
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  mockVisibleUser = 'bob';
  await act(async () => {
    renderer.update(
      <QueryClientProvider client={client}>
        <CreatePlaylistScreen />
      </QueryClientProvider>,
    );
    await tick();
  });
  await act(async () => {
    intermediatePress();
    await tick();
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(
    renderer.root.findByProps({ placeholder: 'createPlaylist.namePlaceholder' }).props.value,
  ).toBe('');
});

it('shows a localized verification error for an opaque bearer and does not create a playlist', async () => {
  await act(async () => {
    mockOxy.session.setAccessToken('opaque-token');
    await tick();
  });
  expect(renderer.root.findByProps({ accessibilityRole: 'alert' }).props.children).toBe(
    'createPlaylist.sessionUnverified',
  );
  await act(async () => {
    renderer.root
      .findByProps({ placeholder: 'createPlaylist.namePlaceholder' })
      .props.onChangeText('Playlist');
  });
  const submit = renderer.root.findByProps({ testID: 'create-playlist-submit' });
  expect(submit.props.disabled).toBe(true);
  await act(async () => {
    submit.props.onPress();
    await tick();
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('rejects a retained A handler after the visible account becomes B before the token changes', async () => {
  await act(async () => {
    renderer.root
      .findByProps({ placeholder: 'createPlaylist.namePlaceholder' })
      .props.onChangeText('Alice private playlist');
  });
  const oldPress = renderer.root.findByProps({ testID: 'create-playlist-submit' }).props.onPress;
  mockVisibleUser = 'bob';
  await act(async () => {
    renderer.update(
      <QueryClientProvider client={client}>
        <CreatePlaylistScreen />
      </QueryClientProvider>,
    );
    await tick();
  });
  await act(async () => {
    oldPress();
    await tick();
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(mockToast.error).not.toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('rejects a retained A handler after visible A→B→A even if the bearer never changes', async () => {
  await act(async () => {
    renderer.root
      .findByProps({ placeholder: 'createPlaylist.namePlaceholder' })
      .props.onChangeText('Alice private playlist');
  });
  const oldPress = renderer.root.findByProps({ testID: 'create-playlist-submit' }).props.onPress;
  mockVisibleUser = 'bob';
  await act(async () => {
    renderer.update(
      <QueryClientProvider client={client}>
        <CreatePlaylistScreen />
      </QueryClientProvider>,
    );
    await tick();
  });
  mockVisibleUser = 'alice';
  await act(async () => {
    renderer.update(
      <QueryClientProvider client={client}>
        <CreatePlaylistScreen />
      </QueryClientProvider>,
    );
    await tick();
  });
  await act(async () => {
    oldPress();
    await tick();
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(mockToast.error).not.toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('suppresses an in-flight A success after visible A→B→A without a token change', async () => {
  let finish!: (response: Response) => void;
  globalThis.fetch = jest.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  ) as typeof fetch;
  await act(async () => {
    renderer.root
      .findByProps({ placeholder: 'createPlaylist.namePlaceholder' })
      .props.onChangeText('Alice private playlist');
  });
  await act(async () => {
    renderer.root.findByProps({ testID: 'create-playlist-submit' }).props.onPress();
    await tick();
  });
  mockVisibleUser = 'bob';
  await act(async () => {
    renderer.update(
      <QueryClientProvider client={client}>
        <CreatePlaylistScreen />
      </QueryClientProvider>,
    );
    await tick();
  });
  mockVisibleUser = 'alice';
  await act(async () => {
    renderer.update(
      <QueryClientProvider client={client}>
        <CreatePlaylistScreen />
      </QueryClientProvider>,
    );
    await tick();
  });
  await act(async () => {
    finish(response());
    await tick();
  });
  expect(mockToast.success).not.toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('keeps queued work valid across a same-account rerender', async () => {
  const mutation = await startOffline();
  await act(async () => {
    renderer.update(
      <QueryClientProvider client={client}>
        <CreatePlaylistScreen />
      </QueryClientProvider>,
    );
    await tick();
  });
  await act(async () => {
    onlineManager.setOnline(true);
    await mutation.continue();
    await tick();
  });
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(mockToast.success).toHaveBeenCalledTimes(1);
});

it('preserves the form and warns before retry if React replaces the owner memo', async () => {
  await act(async () => {
    renderer.root
      .findByProps({ placeholder: 'createPlaylist.namePlaceholder' })
      .props.onChangeText('My unsent playlist');
  });
  mockDiscardNextOwnerMemo = true;
  await act(async () => {
    renderer.update(
      <QueryClientProvider client={client}>
        <CreatePlaylistScreen />
      </QueryClientProvider>,
    );
    await tick();
  });
  expect(mockDiscardNextOwnerMemo).toBe(false);
  expect(
    renderer.root.findByProps({ placeholder: 'createPlaylist.namePlaceholder' }).props.value,
  ).toBe('My unsent playlist');
  expect(renderer.root.findByProps({ accessibilityRole: 'alert' }).props.children).toBe(
    'createPlaylist.verifyBeforeRetry',
  );
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await act(async () => {
    renderer.root.findByProps({ testID: 'create-playlist-submit' }).props.onPress();
    await tick();
  });
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(mockToast.success).toHaveBeenCalledTimes(1);
});
