import { env } from '../../config/env';

/**
 * Mints and caches the Oxy service JWT used for server-to-server notification writes.
 *
 * Obtained by exchanging Syra's ApplicationCredential (`apiKey`/`apiSecret`) at
 * `POST /auth/service-token`. The returned token is a `type: 'service'` JWT valid for
 * one hour and carrying the granted scopes — `notifications:write` is the one the
 * notification create route requires.
 *
 * Cached in module scope and refreshed early, because minting per notification would
 * add a second network round trip to every emission.
 */

/** Refresh this long before expiry so an in-flight request never uses a just-expired token. */
const REFRESH_MARGIN_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

let cached: CachedToken | null = null;

/** Thrown when Syra has no service credentials configured. */
export class MissingOxyServiceCredentialsError extends Error {
  constructor() {
    super(
      'OXY_SERVICE_API_KEY / OXY_SERVICE_API_SECRET are not configured — Syra cannot mint an Oxy service token',
    );
    this.name = 'MissingOxyServiceCredentialsError';
  }
}

/** Reset the cached token. Exposed for tests, which must not inherit another test's token. */
export function resetOxyServiceTokenCache(): void {
  cached = null;
}

/**
 * Return a valid service JWT, minting one if the cache is empty or near expiry.
 *
 * Throws rather than returning null when credentials are absent: a notifier that
 * silently no-ops would look identical to one that is working, which is the failure
 * mode worth avoiding here.
 */
export async function getOxyServiceToken(now: number = Date.now()): Promise<string> {
  if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > now) {
    return cached.token;
  }

  const apiKey = env.OXY_SERVICE_API_KEY;
  const apiSecret = env.OXY_SERVICE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new MissingOxyServiceCredentialsError();
  }

  const response = await fetch(`${env.OXY_API_URL}/auth/service-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey, apiSecret }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to mint Oxy service token: ${response.status} ${await response.text()}`,
    );
  }

  const body: unknown = await response.json();
  const token = extractToken(body);
  if (!token) {
    throw new Error('Oxy service-token response did not contain a token');
  }

  // The endpoint issues a one-hour token; cache slightly under that rather than trusting
  // an `expiresIn` field that may or may not be present.
  cached = { token, expiresAtMs: now + 60 * 60 * 1000 };
  return token;
}

function extractToken(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const direct = record.accessToken ?? record.token;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  const data = record.data;
  if (typeof data === 'object' && data !== null) {
    const nested = (data as Record<string, unknown>).accessToken ?? (data as Record<string, unknown>).token;
    if (typeof nested === 'string' && nested.length > 0) {
      return nested;
    }
  }
  return null;
}
