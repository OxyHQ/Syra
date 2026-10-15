import express, { type ErrorRequestHandler } from 'express';
import { rateLimit, type Store } from 'express-rate-limit';
import { getPublicPodcastCards } from '../controllers/publicPodcastCards.controller';

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
