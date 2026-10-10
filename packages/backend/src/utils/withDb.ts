import { Request, Response, NextFunction } from 'express';
import { isPostgresConnected } from '../db/postgres';

type AsyncHandler<R extends Request = Request> = (
  req: R,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

/**
 * Wraps a route handler with the two guards every DB-backed controller repeats:
 * a 503 short-circuit when the database is not connected, and a try/catch that
 * forwards thrown errors to the Express error middleware. Generic over the
 * request type so handlers typed with `OxyAuthRequest` (and other `Request`
 * subtypes) compose without casts.
 *
 * ## The gate asks POSTGRES
 *
 * This wrapper's only consumer is `routes/playlists.routes.ts`, whose handlers
 * read Postgres. A readiness check for any other store would be invisible to
 * `tsc` and to every test, and would 503 every playlist route for everyone the
 * moment that store went away.
 */
export function withDb<R extends Request = Request>(handler: AsyncHandler<R>) {
  return async (req: R, res: Response, next: NextFunction) => {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}
