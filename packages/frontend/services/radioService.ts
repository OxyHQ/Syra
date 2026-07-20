import { api } from '@/utils/api';
import {
  radioPageSchema,
  trackSchema,
  type RadioPage,
  type RadioSeed,
  type RadioSeedType,
} from '@syra/shared-types';
import { z } from 'zod';
import { normalizeTrackImages } from '@/utils/catalogImages';
import { getDeviceId } from '@/utils/deviceId';

/**
 * Radio pages are stateful server-side: each page advances the station's
 * generator. A cache hit would silently hand back a page the listener already
 * heard, so every read bypasses the SDK's GET cache.
 */
const FRESH_RADIO_READ = { cache: false } as const;

/**
 * Tracks stay `passthrough` so backend fields the shared contract does not yet
 * name survive into the objects the player consumes — same tolerance
 * {@link file://./browseService.ts} applies to every catalog read.
 */
const radioPageResponseSchema = radioPageSchema.extend({
  tracks: z.array(trackSchema.passthrough()),
}).passthrough();

export interface RadioPageParams {
  seedType: RadioSeedType;
  seedId: string;
  /** Opaque station cursor; omit for the first page. */
  cursor?: string;
  limit?: number;
}

function radioSeedQuery(seed: RadioSeed): string {
  return new URLSearchParams({ seedType: seed.seedType, seedId: seed.seedId }).toString();
}

/**
 * Syra Radio API service.
 *
 * A station is server-authoritative and stateful — the backend owns which
 * tracks a listener has already been handed and whether a guest has hit the
 * preview wall. Reads go through the linked Oxy client so that state is scoped
 * to the session; guests are identified by the installation's device ID.
 */
export const radioService = {
  /** One page of a station. `cursor: null` on the result means the station is closed. */
  async getPage(params: RadioPageParams): Promise<RadioPage> {
    const deviceId = await getDeviceId();
    const response = await api.get<unknown>(
      '/radio',
      {
        seedType: params.seedType,
        seedId: params.seedId,
        cursor: params.cursor,
        limit: params.limit,
      },
      { ...FRESH_RADIO_READ, headers: { 'X-Syra-Device-Id': deviceId } },
    );

    const parsed = radioPageResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Invalid radio page response: ${parsed.error.message}`);
    }

    return { ...parsed.data, tracks: parsed.data.tracks.map(normalizeTrackImages) };
  },

  /** Forget everything the station has handed out, so it starts fresh. */
  async reset(seed: RadioSeed): Promise<void> {
    const deviceId = await getDeviceId();
    await api.delete<unknown>(`/radio?${radioSeedQuery(seed)}`, {
      headers: { 'X-Syra-Device-Id': deviceId },
    });
  },
};
