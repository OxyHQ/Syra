import { Response, NextFunction } from 'express';
import type { OxyAuthRequest } from '@oxyhq/core/server';

const ADMIN_ENV = 'COPYRIGHT_ADMIN_OXY_USER_IDS';

function getConfiguredAdminIds(): Set<string> {
  return new Set(
    (process.env[ADMIN_ENV] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function isCopyrightAdmin(userId: string | undefined): boolean {
  return Boolean(userId && getConfiguredAdminIds().has(userId));
}

export function requireCopyrightAdmin(req: OxyAuthRequest, res: Response, next: NextFunction) {
  if (!isCopyrightAdmin(req.user?.id)) {
    return res.status(403).json({ error: 'Admin privileges required' });
  }

  return next();
}
