import { OxyServices } from '@oxy.so/core';
import { canAttestWorkloadIdentity } from '@oxy.so/core/server';

/**
 * Shared OxyServices client singleton.
 *
 * Lives in its own side-effect-free module (NOT `server.ts`) so controllers,
 * sockets, and services can import the client without pulling in the server
 * bootstrap (express/socket.io/redis) — keeping unit tests that import those
 * modules cheap and isolated. Reads `OXY_API_URL` directly (matching the
 * `env.ts` default) rather than importing the full env schema, so importing this
 * module never forces the env validation — `env.ts` parses at import and refuses
 * a production boot that is missing `DATABASE_URL` or `STREAM_KEY_BASE_URL`,
 * which has nothing to do with constructing an HTTP client.
 */
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';

export const oxy = new OxyServices({ baseURL: OXY_API_URL });

/**
 * The service credential pair this process was given, or `null`.
 *
 * Blank is absent. A task definition that declares the variable and leaves it
 * empty is the shape this actually arrives in, and a pair of empty strings
 * treated as present would REPLACE the attestation path below with a credential
 * that cannot mint.
 *
 * Read on every call rather than captured at import, and handed to
 * `getServiceToken()` at the call site rather than installed with
 * `configureServiceAuth()`. One reader means the capability answer and the mint
 * can never disagree about what the environment holds — and nothing mutates the
 * shared client out from under a caller that configured it for itself.
 */
export function oxyServiceCredential(): { apiKey: string; apiSecret: string } | null {
  const apiKey = process.env.OXY_SERVICE_API_KEY?.trim();
  const apiSecret = process.env.OXY_SERVICE_API_SECRET?.trim();
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

/**
 * Whether this process can act as Syra against Oxy at all.
 *
 * The question every caller that used to check for a key pair actually meant.
 * There are two ways to answer yes, and a deployment has one of them without
 * anybody configuring it: under oxy ADR 0026 the ECS task role attests — a
 * signed `GetCallerIdentity` Oxy replays to AWS, with no secret anywhere — and
 * elsewhere the pair above does. A local checkout has neither, which is the
 * honest "Syra cannot act as itself here".
 *
 * Read this rather than `env.OXY_SERVICE_API_KEY`. A key check reads a perfectly
 * healthy attesting deployment as unconfigured, and what that looks like from
 * outside is a feature — notifications, here — that has quietly stopped working,
 * blamed on a variable nobody is ever going to put back.
 */
export function canAuthenticateAsOxyService(): boolean {
  return canAttestWorkloadIdentity() || oxyServiceCredential() !== null;
}
