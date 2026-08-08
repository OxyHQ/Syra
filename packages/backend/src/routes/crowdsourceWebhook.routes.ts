import { Router, type NextFunction, type Request, type Response } from 'express';
import { getModerationIntegration } from '../moderation/integration';
import { logger } from '../utils/logger';

/**
 * `POST /webhooks/crowdsource` — where decisions come back.
 *
 * The receiver itself is `@oxyhq/crowdsource-app`'s: signature verification,
 * cross-instance deduplication, the three decision-bearing event types, the
 * audit row for every other type including one a newer CrowdSource introduces,
 * and answering 2xx as soon as the work is durably queued. What is left here is
 * a mount guard and the lazy binding below.
 *
 * ## The mount is part of the correctness, and Syra keeps its own guard
 *
 * This router MUST be mounted before `express.json()` in `server.ts`. The
 * signature covers `timestamp + "." + rawBody` — the bytes that arrived — and
 * once a JSON parser has run, those bytes are gone.
 *
 * `@oxyhq/crowdsource-express` looks for a raw Buffer and refuses a parsed body,
 * so the package treats the mount order as self-enforcing. `assertRawBody` is
 * kept anyway, and the reason is worth stating precisely because the comment
 * this file used to carry was WRONG: it claimed Syra's parser keeps a Buffer
 * copy on `req.rawBody` which the SDK would accept, and `server.ts` has no such
 * `verify` hook — `express.json()` there takes no options at all. So the SDK
 * would refuse today. What the guard adds is a refusal that NAMES the
 * misconfiguration, at the route rather than inside a dependency, on the one
 * invariant here that no type can express and no unit test of a single file
 * would notice. Ten lines against a receiver that silently verifies signatures
 * over bytes it reconstructed is a trade worth making twice.
 */

/**
 * Refuses to run if a body parser got here first.
 *
 * Answering 500 rather than falling back is the point: a receiver that verified
 * a signature over reconstructed bytes would be worse than one that plainly
 * refuses, because it would keep accepting deliveries and nobody would ever look.
 */
export function assertRawBody(req: Request, res: Response, next: NextFunction): void {
  if (typeof req.body !== 'undefined') {
    logger.error('[CrowdSource] webhook route is mounted AFTER a body parser; refusing to verify', { bodyType: typeof req.body });
    res.status(500).json({
      error: 'The CrowdSource webhook route is misconfigured on this deployment.',
    });
    return;
  }
  next();
}

export function createCrowdSourceWebhookRoutes(): Router {
  const router = Router();
  router.use(assertRawBody);

  /**
   * Bound on the FIRST request, not at mount time.
   *
   * `server.ts` mounts this at module scope and calls `connectPostgres()` inside
   * `bootServer()`, so building the integration here would reach `getDb()`
   * before a pool exists and throw during import. Deferring to the first request
   * is the smallest fix that keeps the mount where the signature requires it —
   * ahead of `express.json()` — and the router is built once, not per request.
   *
   * An unconfigured deployment still 404s: the package returns an EMPTY router
   * when no webhook secret is set, which is indistinguishable from not having
   * the feature, and is exactly what it is.
   */
  let receiver: Router | null = null;
  router.use((req, res, next) => {
    receiver ??= getModerationIntegration().webhookRouter();
    receiver(req, res, next);
  });

  return router;
}
