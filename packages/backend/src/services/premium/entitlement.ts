/**
 * User entitlement service.
 *
 * In production this will query the Oxy user record for subscription status.
 * The current implementation is a mock backed by the PREMIUM_USER_IDS env var
 * (comma-separated userId allowlist) so the gating logic can be developed and
 * tested without a live Oxy connection.
 *
 * Replace `getUserEntitlement` with a real Oxy user lookup when the integration
 * is ready. The `isPremium` helper and `Entitlement` interface are stable.
 */

export interface Entitlement {
  isPremium: boolean;
}

/**
 * Derive premium status from an Oxy user object.
 * Returns false for null/undefined users or missing premium field.
 */
export function isPremium(
  user: { premium?: { isPremium?: boolean } } | null | undefined,
): boolean {
  return user?.premium?.isPremium === true;
}

/**
 * Fetch the entitlement for a given userId.
 *
 * MOCK — replace with Oxy user lookup:
 *   const oxyUser = await oxyClient.getUser(userId);
 *   return { isPremium: isPremium(oxyUser) };
 *
 * Current behaviour: reads PREMIUM_USER_IDS (comma-separated, whitespace-trimmed).
 * Unset or empty → all users are free.
 */
export async function getUserEntitlement(userId: string): Promise<Entitlement> {
  const raw = process.env.PREMIUM_USER_IDS;
  if (!raw) return { isPremium: false };

  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return { isPremium: ids.includes(userId) };
}
