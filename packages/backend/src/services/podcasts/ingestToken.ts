/**
 * The episode ingest ticket — a capability minted while a user's session is
 * live and redeemed later by a process that has none.
 *
 * ## The problem it solves
 *
 * Syra authenticates one thing: a user's Oxy JWT. Alia generates an episode in a
 * background worker minutes after the request, by which time there is no user
 * anywhere in the call — and service-token delegation is dead platform-wide
 * (ADR 0012's JWKS migration was never written), so the worker cannot borrow the
 * user's identity either. A capability closes that gap in the one direction that
 * is safe: the authenticated user asks, in advance, for permission to attach
 * audio to ONE episode they own, and hands that permission to the worker.
 *
 * ## What a leaked ticket buys, and what it does not
 *
 * Everything below is a deliberate narrowing, and each one is enforced at
 * redemption (`controllers/podcastIngest.controller.ts`) rather than merely
 * described here:
 *
 *  - ONE episode. `episodeId` is in the signed claims and is compared against
 *    the id in the URL, so a ticket for episode A cannot attach audio to B.
 *  - ONE use. `jti` is claimed in Postgres with a conditional `UPDATE`; see
 *    `schema/podcasts.ts`'s `episode_ingest_tickets` for why a Redis nonce is
 *    not sufficient.
 *  - AUDIO ONLY. The redemption endpoint's field allowlist is `duration`,
 *    `season`, `episodeNumber`, `description`, `summary` — the things a worker
 *    can know because it made the audio. Title, artwork, `explicit`,
 *    `episodeType`, credits, `status` and every storage field were fixed by the
 *    authenticated user at draft time and are unreachable from here.
 *  - NEVER AN OVERWRITE. Redemption is refused unless the episode is still
 *    `processing` or `failed`, so a ticket cannot replace the audio of an
 *    episode that already went `ready` even inside its 24-hour window.
 *  - NOT A PLAYBACK TOKEN, and not signed by one. `INGEST_TOKEN_SECRET` is its
 *    own secret: a stream token is handed to every player that asks and is
 *    printed inside manifest URLs, so if the two shared a secret then every
 *    playback URL would carry the material for forging a WRITE capability. A
 *    read capability must never be usable as a write capability.
 *  - NOT A SESSION. It authorizes one call on one route. Nothing else in the
 *    API accepts it, because nothing else reads it.
 *
 * ## Ownership is re-checked, not assumed
 *
 * `ownerOxyUserId` is signed into the ticket AND compared against the show's
 * CURRENT owner at redemption. A show can change hands (`claimPodcast`) inside a
 * 24-hour window, and a ticket minted by the previous owner must stop working
 * the moment it does — the claims record who was entitled when it was issued,
 * not who is entitled now.
 *
 * Same shape as `services/stream/streamToken.ts`, with two deliberate
 * differences: the algorithm is pinned on both sides, and `purpose` is verified.
 * Both are cheap here and this is the write side.
 */

import jwt from 'jsonwebtoken';
import { uuidv7 } from '@oxyhq/db';

/**
 * The one value `purpose` may hold.
 *
 * A constant rather than a literal at each site so a second capability type
 * minted under this secret later cannot be redeemed here by forgetting to
 * compare — `verifyIngestTicket` refuses anything else.
 */
export const INGEST_TICKET_PURPOSE = 'episode-ingest';

export interface IngestTicketClaims {
  /** The capability's identity, and the row `episode_ingest_tickets` claims. */
  jti: string;
  episodeId: string;
  podcastId: string;
  /** Who owned the show when this was minted — re-checked at redemption. */
  ownerOxyUserId: string;
  purpose: typeof INGEST_TICKET_PURPOSE;
}

/**
 * 24 hours: long enough for a slow generation plus a retry, short enough that a
 * leaked ticket is not a standing grant. The row's `expires_at` carries the same
 * deadline and is the one that is enforced.
 */
export const INGEST_TICKET_TTL_SEC = 24 * 60 * 60;

/**
 * HS256, pinned on both sides.
 *
 * `jsonwebtoken` already refuses `alg: none`, so this is not the classic
 * vulnerability — it is the narrower one: without `algorithms` on verify, a
 * token signed with ANY algorithm the library accepts for a string secret is
 * admitted, and the set of those is a property of the library version rather
 * than of this code. Naming the one algorithm makes it a property of this code.
 */
const ALGORITHM = 'HS256' as const;

/** Throws on misconfiguration at MINT time, where a person is waiting for the answer. */
function getSecret(): string {
  const secret = process.env.INGEST_TOKEN_SECRET;
  if (!secret) throw new Error('INGEST_TOKEN_SECRET not set');
  return secret;
}

/** Returns null on misconfiguration at VERIFY time — an unverifiable ticket is refused, never admitted. */
function getSecretOrNull(): string | null {
  return process.env.INGEST_TOKEN_SECRET ?? null;
}

/**
 * Mint a ticket for one episode. The `jti` is generated here and returned in the
 * claims so the caller can record it — the row and the token are written
 * together or not at all.
 */
export function mintIngestTicket(
  claims: Omit<IngestTicketClaims, 'jti' | 'purpose'>,
  ttlSec: number = INGEST_TICKET_TTL_SEC
): { token: string; claims: IngestTicketClaims; expiresAt: Date } {
  const secret = getSecret();
  const full: IngestTicketClaims = {
    jti: uuidv7(),
    episodeId: claims.episodeId,
    podcastId: claims.podcastId,
    ownerOxyUserId: claims.ownerOxyUserId,
    purpose: INGEST_TICKET_PURPOSE,
  };

  const token = jwt.sign(
    {
      jti: full.jti,
      episodeId: full.episodeId,
      podcastId: full.podcastId,
      ownerOxyUserId: full.ownerOxyUserId,
      purpose: full.purpose,
    },
    secret,
    { algorithm: ALGORITHM, expiresIn: ttlSec }
  );

  return { token, claims: full, expiresAt: new Date(Date.now() + ttlSec * 1000) };
}

/**
 * Verify a ticket. Returns the claims on success and `null` on EVERY failure —
 * bad signature, wrong algorithm, expired, malformed, missing claim, wrong
 * purpose, or an unset secret. Never throws.
 *
 * Returning one `null` for all of them is deliberate: the caller has no
 * legitimate use for the distinction, and answering with it would tell a holder
 * of a bad ticket which part to fix.
 */
export function verifyIngestTicket(token: string): IngestTicketClaims | null {
  const secret = getSecretOrNull();
  if (!secret) return null;

  try {
    const decoded = jwt.verify(token, secret, { algorithms: [ALGORITHM] });
    if (typeof decoded !== 'object' || decoded === null) return null;

    const { jti, episodeId, podcastId, ownerOxyUserId, purpose } = decoded as Record<
      string,
      unknown
    >;
    if (typeof jti !== 'string' || jti.length === 0) return null;
    if (typeof episodeId !== 'string' || episodeId.length === 0) return null;
    if (typeof podcastId !== 'string' || podcastId.length === 0) return null;
    if (typeof ownerOxyUserId !== 'string' || ownerOxyUserId.length === 0) return null;
    if (purpose !== INGEST_TICKET_PURPOSE) return null;

    return { jti, episodeId, podcastId, ownerOxyUserId, purpose: INGEST_TICKET_PURPOSE };
  } catch {
    return null;
  }
}
