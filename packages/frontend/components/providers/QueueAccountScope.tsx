import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOxy } from '@oxy.so/services';
import { z } from 'zod';
import { queueSchema, repeatModeSchema, shuffleModeSchema } from '@syra/shared-types';
import { useQueueStore } from '@/stores/queueStore';
import { usePlayerStore } from '@/stores/playerStore';
import { createScopedLogger } from '@/utils/logger';

const logger = createScopedLogger('QueueAccountScope');
const snapshotSchema = z.object({ queue: queueSchema.nullable(), shuffle: shuffleModeSchema, repeat: repeatModeSchema, savedAt: z.number() });
const MAX_AGE_MS = 28 * 24 * 60 * 60 * 1000;
let pendingWrites = Promise.resolve();

/** Restore queue metadata, never a decoder or automatic playback. */
export function QueueAccountScope(): null {
  const { user, isPrivateApiPending, canUsePrivateApi } = useOxy();
  const account = user?.id ?? (isPrivateApiPending ? undefined : null);
  React.useEffect(() => {
    if (account === undefined) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const previous = useQueueStore.getState().accountId;
    useQueueStore.getState().setAccount(account);
    if (previous !== undefined && previous !== account) void usePlayerStore.getState().stop();
    const revision = useQueueStore.getState().revision;
    const key = `syra:queue:v1:${account === null ? 'guest' : encodeURIComponent(account)}`;
    const persist = () => {
      const state = useQueueStore.getState();
      if (state.accountId !== account) return;
      const value = JSON.stringify({ queue: state.queue, shuffle: state.shuffle, repeat: state.repeat, savedAt: Date.now() });
      pendingWrites = pendingWrites.then(() => AsyncStorage.setItem(key, value)).catch((error: unknown) => logger.error('Queue snapshot write failed', { error }));
    };
    const unsubscribe = useQueueStore.subscribe((state, old) => {
      if (state.queue === old.queue && state.shuffle === old.shuffle && state.repeat === old.repeat) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(persist, 250);
    });
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(key);
        if (disposed || useQueueStore.getState().accountId !== account || useQueueStore.getState().revision !== revision) return;
        if (raw) {
          const parsed = snapshotSchema.safeParse(JSON.parse(raw));
          if (parsed.success && Date.now() - parsed.data.savedAt < MAX_AGE_MS && parsed.data.savedAt <= Date.now() && parsed.data.queue && parsed.data.queue.tracks.length <= 1000) {
            const { queue, shuffle, repeat } = parsed.data;
            if (Number.isInteger(queue.current) && queue.current >= -1 && queue.current < queue.tracks.length) useQueueStore.setState({ queue, shuffle, repeat });
          } else await AsyncStorage.removeItem(key);
        }
      } catch (error) {
        logger.error('Queue snapshot restore failed', { error });
        try { await AsyncStorage.removeItem(key); }
        catch (cleanupError) { logger.error('Corrupt queue cleanup failed', { error: cleanupError }); }
      }
      if (canUsePrivateApi && !disposed && useQueueStore.getState().accountId === account && useQueueStore.getState().revision === revision) {
        await useQueueStore.getState().loadQueue();
      }
    })();
    return () => { disposed = true; unsubscribe(); if (timer) clearTimeout(timer); persist(); };
  }, [account, canUsePrivateApi]);
  return null;
}
