import { Request, Response, NextFunction } from 'express';
import { isDatabaseConnected } from './database';

type AsyncHandler<R extends Request = Request> = (
  req: R,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

/**
 * Wraps a route handler with the two guards every DB-backed controller repeats:
 * a 503 short-circuit when Mongo is not connected, and a try/catch that forwards
 * thrown errors to the Express error middleware. Generic over the request type so
 * handlers typed with `OxyAuthRequest` (and other `Request` subtypes) compose
 * without casts.
 */
export function withDb<R extends Request = Request>(handler: AsyncHandler<R>) {
  return async (req: R, res: Response, next: NextFunction) => {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}
