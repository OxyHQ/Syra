import { useOxyRuntime } from '@oxy.so/services/runtime';
import { useLayoutEffect } from 'react';
import { followOxyRuntime } from '@/lib/accountQueryCache';
import { accountQueryCache } from '@/lib/queryClient';

/**
 * Keeps Syra's query cache on the session's account (`lib/accountQueryCache.ts`).
 * Mounted once, as the first child of `OxyProvider`, so it follows the runtime
 * before anything else below it mounts; it renders nothing.
 */
export function AccountQueryScope(): null {
  const runtime = useOxyRuntime();
  useLayoutEffect(() => followOxyRuntime(accountQueryCache, runtime), [runtime]);
  return null;
}
