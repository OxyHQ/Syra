/**
 * Studio's queries follow the session's account (`AccountQueryScope`): on a
 * switch or a sign-out nothing of the account that was left is held, rendered
 * (even by a component the switch does not re-render) or reached by its late
 * answer. Only the session runtime is a fake: published, then every subscriber
 * woken in one pass, as Services' `createOxyRuntime` does.
 */
import { type Query, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { memo } from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { followAccount, type SubjectSource } from '@/components/providers/AccountQueryScope';

jest.mock('@oxy.so/services/runtime', () => ({ useOxyRuntime: jest.fn() }));

function createRuntime(initial: string | null) {
  let snapshot: { account: { id: string } | null } = { account: initial ? { id: initial } : null };
  const listeners = new Set<() => void>();
  const runtime: SubjectSource & { become: (id: string | null) => void } = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    become: (id) => {
      snapshot = { account: id ? { id } : null };
      for (const listener of [...listeners]) listener();
    },
  };
  return runtime;
}

const SHOWS_KEY = ['podcasts', 'mine'] as const;

/** Reads the creator's shows and never re-renders for the session. */
const Shows = memo(function Shows({ load }: { load: () => Promise<string[]> }) {
  const { data } = useQuery({ queryKey: SHOWS_KEY, queryFn: load });
  return <Text testID="shows">{(data ?? []).join('|')}</Text>;
});

let client: QueryClient;
let renderer: ReactTestRenderer | undefined;
let unfollow: () => void = () => undefined;
const created = new Set<Query>();

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  unfollow();
  unfollow = () => undefined;
  client.clear();
  // A query removed while a screen watched it schedules its garbage collection
  // (out of the client's reach) when the screen leaves it; that timer would
  // keep Jest alive.
  for (const query of created) query.destroy();
  created.clear();
});

const shows = () => String(renderer!.root.findByProps({ testID: 'shows' }).props.children ?? '');
const held = () =>
  JSON.stringify(
    client
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
  );

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

it('drops the account’s queries on a switch and a sign-out, and a late answer lands nowhere', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.getQueryCache().subscribe((event) => {
    if (event.type === 'added') created.add(event.query);
  });
  const runtime = createRuntime('A');
  unfollow = followAccount(client, runtime);
  let answer: (value: string[]) => void = () => undefined;
  const load = jest.fn(async () => ['A-show']);

  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Shows load={load} />
      </QueryClientProvider>,
    );
  });
  await settle();
  expect(shows()).toBe('A-show');

  // A read for A is still in flight when the session moves to B.
  load.mockImplementation(
    () =>
      new Promise<string[]>((resolve) => {
        answer = resolve;
      }),
  );
  await act(async () => {
    void client.invalidateQueries({ queryKey: SHOWS_KEY });
  });
  const lateForA = answer;
  act(() => runtime.become('B'));
  expect(shows()).toBe('');
  expect(held()).not.toContain('A-');

  // A's late answer reaches neither the screen nor the cache.
  await act(async () => {
    lateForA(['A-late-show']);
  });
  await settle();
  expect(shows()).not.toContain('A-');
  expect(held()).not.toContain('A-');

  // B's own read answers.
  await act(async () => {
    answer(['B-show']);
  });
  await settle();
  expect(shows()).toBe('B-show');

  // Sign-out: nothing of B's is held or shown.
  act(() => runtime.become(null));
  expect(shows()).toBe('');
  expect(held()).not.toContain('B-');
});
