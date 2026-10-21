import { createHmac } from 'node:crypto';
import express, { type ErrorRequestHandler, type Request } from 'express';
import { ipKeyGenerator, rateLimit, type Store } from 'express-rate-limit';
import { getPublicPodcastCards } from '../controllers/publicPodcastCards.controller';

/**
 * The limiter's bucket for a caller: its address (IPv6 bucketed to /56, so one
 * host cannot rotate through its allocation), HMAC'd the way `@oxy.so/core`'s
 * limiter does — the store is Redis, and a raw client IP never reaches a store
 * at rest. `req.ip` is the real client (`config/trustProxy.ts`).
 */
function clientBucket(req: Request): string {
  const salt = process.env.IP_HASH_SALT || process.env.DEVICE_ID_SALT || '';
  return createHmac('sha256', salt)
    .update(`rl|${ipKeyGenerator(req.ip ?? '')}`)
    .digest('hex')
    .slice(0, 24);
}

/** Public cards never resolve a session or wait for the identity service. */
export function createPublicPodcastCardsRouter(store?: Store, limit = 120) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit,
      store,
      keyGenerator: clientBucket,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) => {
        const retryAfterSeconds = Number(res.getHeader('Retry-After')) || 60;
        res.status(429).json({
          error: {
            code: 'rate_limited',
            message: 'Too many requests',
            details: { retryAfterSeconds },
          },
        });
      },
    }),
  );
  router.post('/', express.json({ limit: '32kb' }), getPublicPodcastCards);
  const invalidJson: ErrorRequestHandler = (_error, _req, res, _next) => {
    res
      .status(400)
      .json({ error: { code: 'bad_request', message: 'Expected a bounded JSON request body' } });
  };
  router.use(invalidJson);
  return router;
}
