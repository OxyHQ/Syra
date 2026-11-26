/** A browser that blocks site storage keeps the account cache in memory instead of failing the app. */
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: {} }));

import { createPlatformStorage } from '@/lib/accountQueryCache';

describe('createPlatformStorage on the web', () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
  afterEach(() => {
    if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
    else delete (window as { localStorage?: Storage }).localStorage;
  });

  it('falls back to memory when reading localStorage throws', async () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: blocked');
      },
    });
    const storage = createPlatformStorage();
    await storage.setItem('k', 'v');
    expect(await storage.getItem('k')).toBe('v');
  });

  it('uses localStorage when the browser allows it', async () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    const storage = createPlatformStorage();
    await storage.setItem('syra-test', '1');
    expect(values.get('syra-test')).toBe('1');
    await storage.removeItem('syra-test');
    expect(values.has('syra-test')).toBe(false);
  });
});
