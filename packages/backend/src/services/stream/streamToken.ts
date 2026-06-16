/**
 * Short-TTL stream access token.
 *
 * Tokens are bound to a specific (trackId, userId) pair. Callers that accept
 * a token MUST verify that claims.trackId matches the resource being accessed —
 * a valid token for track A must not grant access to track B.
 *
 * Secret: STREAM_TOKEN_SECRET environment variable (required; no fallback).
 */

import jwt from 'jsonwebtoken';

export interface StreamTokenClaims {
  trackId: string;
  userId: string;
}

/** Default token lifetime: 5 minutes. */
const DEFAULT_TTL_SEC = 300;

/** Centralised secret accessor — throws on misconfiguration at mint time. */
function getSecret(): string {
  const secret = process.env.STREAM_TOKEN_SECRET;
  if (!secret) {
    throw new Error('STREAM_TOKEN_SECRET not set');
  }
  return secret;
}

/** Centralised secret accessor for verify — returns null on misconfiguration. */
function getSecretOrNull(): string | null {
  return process.env.STREAM_TOKEN_SECRET ?? null;
}

/**
 * Mint a signed stream token binding trackId + userId.
 * Throws if STREAM_TOKEN_SECRET is not set.
 */
export function mintStreamToken(
  claims: StreamTokenClaims,
  ttlSec: number = DEFAULT_TTL_SEC,
): string {
  const secret = getSecret();
  return jwt.sign({ trackId: claims.trackId, userId: claims.userId }, secret, {
    expiresIn: ttlSec,
  });
}

/**
 * Verify a stream token. Returns the claims on success, null on any failure
 * (invalid signature, expired, malformed, missing claims, missing secret).
 * Never throws.
 */
export function verifyStreamToken(token: string): StreamTokenClaims | null {
  const secret = getSecretOrNull();
  if (!secret) return null;

  try {
    const decoded = jwt.verify(token, secret);
    if (typeof decoded !== 'object' || decoded === null) return null;

    const { trackId, userId } = decoded as Record<string, unknown>;
    if (typeof trackId !== 'string' || typeof userId !== 'string') return null;

    return { trackId, userId };
  } catch {
    return null;
  }
}
