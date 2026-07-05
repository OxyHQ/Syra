import { describe, it, expect, afterEach } from 'bun:test';
import { isCopyrightAdmin, requireCopyrightAdmin } from './copyrightAdmin';
import type { OxyAuthRequest } from '@oxyhq/core/server';
import type { Response, NextFunction } from 'express';

afterEach(() => {
  delete process.env.COPYRIGHT_ADMIN_OXY_USER_IDS;
});

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

describe('copyright admin authorization', () => {
  it('allows only configured Oxy user IDs', () => {
    process.env.COPYRIGHT_ADMIN_OXY_USER_IDS = 'admin-one, admin-two';

    expect(isCopyrightAdmin('admin-one')).toBe(true);
    expect(isCopyrightAdmin('admin-two')).toBe(true);
    expect(isCopyrightAdmin('ordinary-user')).toBe(false);
    expect(isCopyrightAdmin(undefined)).toBe(false);
  });

  it('rejects non-admin users before admin copyright handlers run', () => {
    process.env.COPYRIGHT_ADMIN_OXY_USER_IDS = 'admin-one';
    const req = { user: { id: 'ordinary-user' } } as unknown as OxyAuthRequest;
    const res = makeRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    requireCopyrightAdmin(req, res as unknown as Response, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Admin privileges required' });
    expect(nextCalled).toBe(false);
  });

  it('passes configured admins to the next handler', () => {
    process.env.COPYRIGHT_ADMIN_OXY_USER_IDS = 'admin-one';
    const req = { user: { id: 'admin-one' } } as unknown as OxyAuthRequest;
    const res = makeRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    requireCopyrightAdmin(req, res as unknown as Response, next);

    expect(res.statusCode).toBe(200);
    expect(nextCalled).toBe(true);
  });
});
