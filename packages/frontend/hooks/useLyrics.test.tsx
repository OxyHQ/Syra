import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLyrics } from './useLyrics';

const mockGet = jest.fn();
jest.mock('@/utils/api', () => ({ api: { get: (...args: unknown[]) => mockGet(...args) }, isNotFoundError: (error: unknown) => error instanceof Error && error.message === '404' }));

const lyrics = { trackId: 'first', synced: false, plain: 'A line', lines: [{ timeMs: 0, text: 'A line' }], source: 'lrclib' };
let renderer: ReactTestRenderer | undefined;
let client: QueryClient;
function Probe({ trackId, position = 0 }: { trackId?: string; position?: number }) {
  const result = useLyrics(trackId);
  return <>{JSON.stringify({ ...result, position })}</>;
}
function view(trackId?: string, position = 0) {
  return <QueryClientProvider client={client}><Probe trackId={trackId} position={position} /></QueryClientProvider>;
}
beforeEach(() => {
  jest.useFakeTimers();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockGet.mockResolvedValue({ data: lyrics });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  client.clear();
  jest.clearAllMocks();
  jest.useRealTimers();
});
async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { jest.advanceTimersByTime(1); });
}
async function mount(trackId?: string) {
  await act(async () => { renderer = create(view(trackId)); });
  await flush();
  if (!renderer) throw new Error('Renderer did not mount');
  return renderer;
}
it('does not fetch without a track id', async () => {
  await mount();
  expect(mockGet).not.toHaveBeenCalled();
});
it('reuses lyrics while scrubbing and reopening after the default five-minute garbage collection interval', async () => {
  const tree = await mount('first');
  expect(mockGet).toHaveBeenCalledTimes(1);
  act(() => tree.update(view('first', 90)));
  act(() => tree.update(<QueryClientProvider client={client}><React.Fragment /></QueryClientProvider>));
  act(() => jest.advanceTimersByTime(6 * 60 * 1000));
  act(() => tree.update(view('first', 30)));
  await flush();
  expect(mockGet).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(tree.toJSON())).toContain('A line');
});
it('caches an unavailable response and does not fetch it again when reopening', async () => {
  mockGet.mockRejectedValue(new Error('404'));
  const tree = await mount('missing');
  expect(client.getQueryData(['lyrics', 'missing'])).toBeNull();
  act(() => tree.update(<React.Fragment />));
  act(() => tree.update(view('missing')));
  await flush();
  expect(mockGet).toHaveBeenCalledTimes(1);
});
it('separates different tracks and rejects invalid provider DTOs', async () => {
  const tree = await mount('first');
  mockGet.mockResolvedValue({ data: { unexpected: true } });
  act(() => tree.update(view('second')));
  await flush();
  await act(async () => { jest.advanceTimersByTime(1500); });
  await flush();
  expect(client.getQueryState(['lyrics', 'second'])?.status).toBe('error');
  expect(client.getQueryData(['lyrics', 'first'])).toEqual(lyrics);
});
