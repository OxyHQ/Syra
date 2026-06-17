import { Request, Response, NextFunction } from 'express';
import { isDatabaseConnected } from './database';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export function withDb(handler: AsyncHandler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database unavailable' });
    }
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}
