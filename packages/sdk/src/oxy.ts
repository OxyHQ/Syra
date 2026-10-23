import { createSyraClient, DEFAULT_SYRA_BASE_URL, type SyraClient } from './client';

/** Structural: no Oxy runtime, React or native peer enters the headless client. */
export interface SyraLinkedIdentity {
  createLinkedClient(options: { baseURL: string }): { fetch: typeof fetch; dispose(): void };
}
export interface SyraSessionOptions {
  baseURL?: string;
  webBaseURL?: string;
}

/** Own product session follows the account and refresh lifecycle of the existing Oxy client. */
export function syraForOxySession(
  oxy: SyraLinkedIdentity,
  options: SyraSessionOptions = {},
): SyraClient & { dispose(): void } {
  const baseURL = options.baseURL ?? DEFAULT_SYRA_BASE_URL;
  const target = new URL(baseURL);
  if (
    target.username ||
    target.password ||
    target.hash ||
    target.search ||
    !['http:', 'https:'].includes(target.protocol)
  )
    throw new TypeError('Syra: invalid API origin');
  const transport = oxy.createLinkedClient({ baseURL });
  const client = createSyraClient({ ...options, baseURL, transport });
  return Object.assign(client, { dispose: () => transport.dispose() });
}
