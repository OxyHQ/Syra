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
 * ## The gate asks POSTGRES, and used to ask Mongo
 *
 * This wrapper's only consumer is `routes/playlists.routes.ts`, whose handlers
 * Task 11 moved to Postgres — verified transitively, not by grepping the routes
 * file: walking all 27 files it reaches finds no `models/` import, and
 * `db/__tests__/connectivityGates.test.ts` keeps checking that.
 *
 * The gate it used to make was `isDatabaseConnected()`, which is
 * `mongoose.connection.readyState`.
 *
 * So the gate was asking about a database these routes do not use. That cost two
 * things, and the second is the one worth stating: Mongo down with Postgres up
 * answered 503 for playlist routes that would have worked, and once Mongo is
 * removed (Task 19) `readyState` never reaches 1 again — so **every playlist
 * route would 503 for everyone, permanently, with no error anywhere**.
 *
 * This wrapper is Task 11's and the fix is a one-line change; Task 15 took it
 * because the sweep it was doing for its own two jobs is only meaningful if it
 * is complete. A Mongo-readiness check guarding Postgres work is invisible to
 * `tsc`, to every test, and to the reviewer of the commit that removes Mongo.
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
