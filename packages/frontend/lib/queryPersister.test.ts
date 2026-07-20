import { QueryClient, dehydrate } from '@tanstack/react-query';
import type { PersistedClient } from '@tanstack/react-query-persist-client';

const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn((key: string) => Promise.resolve(mockStorage.get(key) ?? null)),
    setItem: jest.fn((key: string, value: string) => {
      mockStorage.set(key, value);
      return Promise.resolve();
    }),
    removeItem: jest.fn((key: string) => {
      mockStorage.delete(key);
      return Promise.resolve();
    }),
  },
}));

const SCOPE_KEY = 'syra-react-query-active-scope';
const LEGACY_KEY = 'syra-react-query-cache';
const cacheKey = (scope: string) => `syra-react-query-cache:${scope}`;

/** `gcTime: Infinity` skips the garbage-collection timer, so no handle is left open. */
const makeClient = () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });

/** A realistic snapshot: dehydrated from a real client, as the app would store. */
function snapshotOwnedBy(owner: string): PersistedClient {
  const client = makeClient();
  client.setQueryData(['library'], { owner });
  return { buster: 'syra-rq-v1', timestamp: Date.now(), clientState: dehydrate(client) };
}

function storeSnapshot(scope: string, owner: string) {
  mockStorage.set(cacheKey(scope), JSON.stringify(snapshotOwnedBy(owner)));
}

function ownerOf(snapshot: PersistedClient | undefined): unknown {
  const data = snapshot?.clientState.queries[0]?.state.data;
  return (data as { owner?: string } | undefined)?.owner;
}

/**
 * Fresh module state per test — the scope resolution is memoized per app run.
 * `require` rather than a dynamic import: this suite runs under Jest's CommonJS
 * transform, where `import()` needs --experimental-vm-modules. The declared
 * return type keeps call sites fully typed.
 */
function loadPersister(): typeof import('./queryPersister') {
  jest.resetModules();
  return require('./queryPersister');
}

beforeEach(() => {
  mockStorage.clear();
});

describe('cold boot restore', () => {
  it('restores the snapshot of the account the last session left behind', async () => {
    mockStorage.set(SCOPE_KEY, 'user:A');
    storeSnapshot('user:A', 'A');

    const { persistOptions } = loadPersister();
    const restored = await persistOptions.persister.restoreClient();

    expect(ownerOf(restored)).toBe('A');
  });

  it('does not restore a snapshot belonging to a different account', async () => {
    mockStorage.set(SCOPE_KEY, 'user:B');
    storeSnapshot('user:A', 'A');

    const { persistOptions } = loadPersister();

    expect(await persistOptions.persister.restoreClient()).toBeUndefined();
  });

  it('deletes the pre-scoping unscoped snapshot so it can never be served', async () => {
    mockStorage.set(LEGACY_KEY, JSON.stringify(snapshotOwnedBy('A')));

    const { persistOptions } = loadPersister();
    await persistOptions.persister.restoreClient();

    expect(mockStorage.has(LEGACY_KEY)).toBe(false);
  });
});

describe('applyAccountScope', () => {
  it('is a no-op when the same account resolves again (token refresh)', async () => {
    mockStorage.set(SCOPE_KEY, 'user:A');
    storeSnapshot('user:A', 'A');

    const { applyAccountScope, accountScopeFor } = loadPersister();
    const queryClient = makeClient();
    const clear = jest.spyOn(queryClient, 'clear');

    await applyAccountScope(accountScopeFor('A'), queryClient);

    expect(clear).not.toHaveBeenCalled();
    expect(mockStorage.has(cacheKey('user:A'))).toBe(true);
  });

  it('clears memory and erases the snapshot on sign-out', async () => {
    mockStorage.set(SCOPE_KEY, 'user:A');
    storeSnapshot('user:A', 'A');

    const { applyAccountScope, accountScopeFor } = loadPersister();
    const queryClient = makeClient();
    const clear = jest.spyOn(queryClient, 'clear');

    await applyAccountScope(accountScopeFor(null), queryClient);

    expect(clear).toHaveBeenCalled();
    expect(mockStorage.has(cacheKey('user:A'))).toBe(false);
    expect(mockStorage.get(SCOPE_KEY)).toBe('guest');
  });

  it('never serves the outgoing account data after a switch', async () => {
    mockStorage.set(SCOPE_KEY, 'user:A');
    storeSnapshot('user:A', 'A');
    storeSnapshot('user:B', 'B');

    const { applyAccountScope, accountScopeFor, persistOptions } = loadPersister();
    const queryClient = makeClient();
    const clear = jest.spyOn(queryClient, 'clear');

    await applyAccountScope(accountScopeFor('B'), queryClient);

    expect(clear).toHaveBeenCalled();
    // B reads its own snapshot, never A's.
    expect(ownerOf(await persistOptions.persister.restoreClient())).toBe('B');
    // A's snapshot survives under its own key, unreachable from B.
    expect(mockStorage.has(cacheKey('user:A'))).toBe(true);
  });
});

describe('persistClient', () => {
  it('writes under the active account scope', async () => {
    mockStorage.set(SCOPE_KEY, 'user:A');

    const { persistOptions } = loadPersister();
    await persistOptions.persister.persistClient(snapshotOwnedBy('A'));

    expect(ownerOf(JSON.parse(mockStorage.get(cacheKey('user:A')) ?? 'null'))).toBe('A');
    expect(mockStorage.has(LEGACY_KEY)).toBe(false);
  });

  it('refuses to overwrite a stored snapshot with an empty one', async () => {
    mockStorage.set(SCOPE_KEY, 'user:B');
    storeSnapshot('user:B', 'B');

    const { persistOptions } = loadPersister();
    await persistOptions.persister.persistClient({
      buster: 'syra-rq-v1',
      timestamp: Date.now(),
      clientState: dehydrate(makeClient()),
    });

    expect(ownerOf(JSON.parse(mockStorage.get(cacheKey('user:B')) ?? 'null'))).toBe('B');
  });
});
