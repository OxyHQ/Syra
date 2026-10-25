import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCurrentUserPrivacySettings } from './usePrivacySettings';

const mockGet = jest.fn();
const mockRemove = jest.fn(async (_key: string) => undefined);
const mockRead = jest.fn();
let mockAccount: string | null = 'account-a';
const mockListeners = new Set<() => void>();
const mockOxy = {
  session: {
    get userId() {
      return mockAccount;
    },
    onChange: (listener: () => void) => {
      mockListeners.add(listener);
      return () => {
        mockListeners.delete(listener);
      };
    },
  },
};
jest.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({
    user: mockAccount ? { id: mockAccount } : null,
    canUsePrivateApi: !!mockAccount,
    oxyServices: mockOxy,
  }),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { removeItem: (key: string) => mockRemove(key), getItem: mockRead },
}));
jest.mock('@/utils/api', () => ({
  api: { get: (...args: unknown[]) => mockGet(...args) },
  isNotFoundError: () => false,
}));
jest.mock('@/utils/logger', () => ({ createScopedLogger: () => ({ debug: jest.fn() }) }));
let client: QueryClient;
let renderer: ReactTestRenderer;
function Probe() {
  return <>{JSON.stringify(useCurrentUserPrivacySettings())}</>;
}
function view() {
  return (
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>
  );
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
}
async function switchAccount(id: string | null) {
  act(() => {
    mockAccount = id;
    for (const listener of mockListeners) listener();
    renderer.update(view());
  });
  await flush();
}
beforeEach(() => {
  jest.useFakeTimers();
  mockAccount = 'account-a';
  mockListeners.clear();
  mockGet.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => renderer?.unmount());
  client.clear();
  jest.useRealTimers();
});
it('does not expose the previous account privacy while switching or after logout', async () => {
  mockGet.mockResolvedValueOnce({ data: { privacy: { hiddenWords: ['private-a'] } } });
  await act(async () => {
    renderer = create(view());
  });
  await flush();
  expect(JSON.stringify(renderer.toJSON())).toContain('private-a');
  mockGet.mockRejectedValue(new Error('offline'));
  await switchAccount('account-b');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('private-a');
  await switchAccount(null);
  expect(renderer.toJSON()).toBe('null');
  expect(mockRead).not.toHaveBeenCalled();
  expect(mockRemove).toHaveBeenCalledWith('@syra_privacy_settings');
});
it('rejects an old in-flight response after the verified account changes', async () => {
  let complete: ((value: unknown) => void) | undefined;
  mockGet.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () => {
    renderer = create(view());
  });
  mockGet.mockResolvedValue({ data: { privacy: { hiddenWords: ['private-b'] } } });
  await switchAccount('account-b');
  await act(async () => {
    complete?.({ data: { privacy: { hiddenWords: ['private-a'] } } });
  });
  await flush();
  expect(JSON.stringify(renderer.toJSON())).toContain('private-b');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('private-a');
});
