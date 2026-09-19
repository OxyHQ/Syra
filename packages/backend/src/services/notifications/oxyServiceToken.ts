import { canAuthenticateAsOxyService, oxy, oxyServiceCredential } from '../../oxyClient';

/**
 * The Oxy service JWT used for server-to-server notification writes.
 *
 * `POST /auth/service-token` returns a `type: 'service'` JWT valid for one hour
 * and carrying the granted scopes — `notifications:write` is the one the
 * notification create route requires. What this module owns is WHEN Syra is
 * entitled to ask for one; the exchange, the cache and the early refresh belong
 * to `@oxy.so/core` and are no longer re-implemented here.
 *
 * ## Syra proves what it IS, and the key pair became the fallback
 *
 * This used to POST the `OXY_SERVICE_API_KEY`/`OXY_SERVICE_API_SECRET` pair with
 * `fetch` and cache the answer in module scope. Under oxy ADR 0026 a first-party
 * service instead signs a `GetCallerIdentity` for its ECS task role, which Oxy
 * replays to AWS; `@oxy.so/core` >= 1.6.1 takes that path inside
 * `getServiceToken()` whenever no credential is supplied. A hand-rolled POST
 * cannot: it has one way to authenticate, and on the day the deployment stops
 * carrying a pair every notification Syra emits would fail with
 * "not configured" — on a deployment that could mint perfectly well.
 *
 * The pair is still passed where there is one, because it is what a developer's
 * laptop has and the SDK prefers it deliberately, so dropping the two variables
 * from the task definition is the whole migration.
 */

/** Thrown when Syra has no Oxy identity at all — neither an attestable task role nor a pair. */
export class MissingOxyServiceCredentialsError extends Error {
  constructor() {
    super(
      'Syra cannot mint an Oxy service token: this process can neither attest a workload identity (oxy ADR 0026) nor present an OXY_SERVICE_API_KEY / OXY_SERVICE_API_SECRET pair',
    );
    this.name = 'MissingOxyServiceCredentialsError';
  }
}

/**
 * Reset the cached token. Exposed for tests, which must not inherit another test's token.
 *
 * The cache is the SDK's now, keyed per credential pair with a constant key for
 * the attested one, so this clears the SDK's rather than a second cache of our
 * own that could disagree with it.
 */
export function resetOxyServiceTokenCache(): void {
  oxy.invalidateServiceToken();
}

/**
 * Return a valid service JWT, minting one if the SDK's cache is empty or near expiry.
 *
 * Throws rather than returning null when Syra has no identity: a notifier that
 * silently no-ops would look identical to one that is working, which is the
 * failure mode worth avoiding here. The capability is checked BEFORE the SDK is
 * asked so the refusal names the two variables a developer can actually set,
 * rather than the SDK's generic "credentials not provided" — which would be
 * misleading advice on infrastructure, where the fix is a task role and not a
 * secret.
 */
export async function getOxyServiceToken(): Promise<string> {
  if (!canAuthenticateAsOxyService()) {
    throw new MissingOxyServiceCredentialsError();
  }

  const credential = oxyServiceCredential();
  return credential === null
    ? oxy.getServiceToken()
    : oxy.getServiceToken(credential.apiKey, credential.apiSecret);
}
