import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { clear, connect, disconnect } from '../test/mongo';

/**
 * Route-level guard against serving one account's mute and block list to another.
 *
 * `GET /api/profile/settings/:userId` sits behind `requireAuth` but takes the account
 * id from the URL, so before the projection it returned ANY account's whole settings
 * document to ANY authenticated caller — `privacy.hiddenWords` (the mute list) and
 * `privacy.restrictedUsers` (the block list) included.
 *
 * ## Why this is a route test and not a unit test on the projection
 *
 * Because the projection was never the weak part. `viewerVisiblePrivacy` is covered
 * thoroughly by `profileSettings.privacyProjection.test.ts`, and a review of the
 * PostgreSQL port found that **mutating the route's call site back to the full read
 * restored the entire leak with every test still passing**. One line in one handler
 * was the only thing choosing the safe read, and nothing exercised it.
 *
 * That is the same shape as `streamCredentialExposure.test.ts`, which exists because
 * a sanitizer was correct and simply never called. A guard that exists, is correct,
 * and is not reached is indistinguishable from no guard at all — and only a request
 * through the real router tells them apart.
 *
 * ## The fixtures carry the secrets
 *
 * This defect was a PRESENCE, not an absence, so the stored document must hold real
 * mute and block entries. A test whose fixture lacks them passes whether or not the
 * projection works. The assertions then search for those VALUES anywhere in the body
 * rather than for a missing key, because a renamed key leaks exactly as well.
 */

const VIEWER_ID = 'oxy-viewer-not-the-owner';
const OWNER_ID = 'oxy-owner-being-viewed';

/** Values that must never reach another account. */
const MUTED_WORD = 'MUTEDWORDCANARY';
const BLOCKED_USER = 'BLOCKEDUSERCANARY';

// `requireOxyAuth` reaches the Oxy IdP; these tests are about what the handler
// SERIALIZES, not about authentication, so it is replaced by a stub that marks the
// caller as an ordinary authenticated user who is NOT the owner.
mock.module('@oxyhq/core/server', () => ({
  requireOxyAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string } }).user = { id: VIEWER_ID };
    next();
  },
  getRequiredOxyUserId: (req: express.Request) =>
    (req as express.Request & { user?: { id: string } }).user?.id ?? VIEWER_ID,
}));

// Loaded with `require` rather than a static import so the stub above is in place
// first — a static import is hoisted above `mock.module` and would bind the real
// middleware. This package is CommonJS, so top-level `await import` is not an option.
/* eslint-disable @typescript-eslint/no-var-requires */
const UserSettings = require('../models/UserSettings').default as typeof import('../models/UserSettings').default;
const profileSettingsRoutes = require('./profileSettings').default as express.Router;
/* eslint-enable @typescript-eslint/no-var-requires */

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

/** A settings document in the exact state where the sensitive lists are populated. */
async function seedOwnerSettings(): Promise<void> {
  await UserSettings.create({
    oxyUserId: OWNER_ID,
    privacy: {
      profileVisibility: 'followers_only',
      showContactInfo: false,
      hideLikeCounts: true,
      hiddenWords: [MUTED_WORD],
      restrictedUsers: [BLOCKED_USER],
    },
  });
}

/**
 * Serve the router on an ephemeral port, run `exercise` against it, then close.
 */
async function withRouter(exercise: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/profile', profileSettingsRoutes);

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });

  try {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected the test server to bind a TCP port');
    }
    await exercise(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('GET /api/profile/settings/:userId', () => {
  it('does not serve another account’s mute list or block list', async () => {
    await seedOwnerSettings();

    await withRouter(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/profile/settings/${OWNER_ID}`);
      expect(response.status).toBe(200);
      const body = await response.text();

      // Values, not keys — a renamed field leaks just as well.
      expect(body).not.toContain(MUTED_WORD);
      expect(body).not.toContain(BLOCKED_USER);
      expect(body).not.toContain('hiddenWords');
      expect(body).not.toContain('restrictedUsers');
    });
  });

  it('still serves the viewer-visible flags, so profile rendering keeps working', async () => {
    await seedOwnerSettings();

    await withRouter(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/profile/settings/${OWNER_ID}`);
      // `sendSuccessResponse` wraps the payload in `{ data }`, which is the shape
      // `usePrivacySettings` reads through its axios `response.data`.
      const parsed = (await response.json()) as {
        data?: { privacy?: Record<string, unknown> };
      };

      // The reason this route was not simply restricted to the caller's own id:
      // its only consumer reads another account's flags to render their profile.
      expect(parsed.data?.privacy?.profileVisibility).toBe('followers_only');
      expect(parsed.data?.privacy?.hideLikeCounts).toBe(true);
      expect(parsed.data?.privacy?.showContactInfo).toBe(false);
    });
  });

  it('projects the caller their own id through the same narrow path', async () => {
    // Asking this route for your OWN settings must not widen it — `/settings/me`
    // is the route that returns the full document.
    await UserSettings.create({
      oxyUserId: VIEWER_ID,
      privacy: { hiddenWords: [MUTED_WORD], restrictedUsers: [BLOCKED_USER] },
    });

    await withRouter(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/profile/settings/${VIEWER_ID}`);
      const body = await response.text();

      expect(body).not.toContain(MUTED_WORD);
      expect(body).not.toContain(BLOCKED_USER);
    });
  });
});

describe('GET /api/profile/settings/me', () => {
  it('still returns the caller their own lists', async () => {
    // The fix must not take away the owner's access to their own settings —
    // otherwise the mute-word editor has nothing to load.
    await UserSettings.create({
      oxyUserId: VIEWER_ID,
      privacy: { hiddenWords: [MUTED_WORD], restrictedUsers: [BLOCKED_USER] },
    });

    await withRouter(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/profile/settings/me`);
      expect(response.status).toBe(200);
      const body = await response.text();

      expect(body).toContain(MUTED_WORD);
      expect(body).toContain(BLOCKED_USER);
    });
  });
});
