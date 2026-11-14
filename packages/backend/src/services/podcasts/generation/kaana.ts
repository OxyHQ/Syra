/**
 * The one way Syra reaches inference: Kaana's SDK over Syra's own Oxy
 * workload (`oxyClient.ts`), on the SDK's one production origin. Syra holds
 * no provider key and no Kaana key; Oxy admits, meters and bills every
 * request, and Kaana runs it. See `docs/ai-routing.md`.
 *
 * Every client is attributed to the person the episode is for, so their usage
 * is recorded against their account. The SDK is ESM-only and this package
 * emits CommonJS, so it is loaded once with a dynamic import.
 */

import type { Kaana } from '@kaana.ai/sdk' with { 'resolution-mode': 'import' };
import { oxy } from '../../../oxyClient';

type KaanaSdk = typeof import('@kaana.ai/sdk', { with: { 'resolution-mode': 'import' }});

export type GenerationKaana = Kaana & { dispose(): void };
export type KaanaModel = Awaited<ReturnType<Kaana['models']['list']>>[number];

let sdk: Promise<KaanaSdk> | undefined;

export function kaanaSdk(): Promise<KaanaSdk> {
  sdk ??= import('@kaana.ai/sdk');
  return sdk;
}

/** A client attributed to `accountId`. Dispose it when the work is done. */
export async function kaanaForAccount(accountId: string): Promise<GenerationKaana> {
  const { kaanaForOxyService } = await import('@kaana.ai/sdk/server');
  return kaanaForOxyService(oxy, { attribution: { accountId } });
}

/**
 * What the owner reads when Kaana refused or failed: one sentence per kind,
 * never Kaana's or a provider's own message.
 */
export async function describeKaanaFailure(error: unknown): Promise<string | null> {
  const { KaanaBillingError, KaanaRateLimitError, KaanaError, KaanaConnectionError } =
    await kaanaSdk();
  if (error instanceof KaanaBillingError || error instanceof KaanaRateLimitError) {
    return 'The generation limit has been reached. Please try again later.';
  }
  if (error instanceof KaanaError || error instanceof KaanaConnectionError) {
    return 'Episode generation is not available right now. Please try again later.';
  }
  return null;
}
