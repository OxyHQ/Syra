import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { updateUserSettings } from '../db/user/settings';
import profileSettingsRoutes from './profileSettings';

/**
 * Route-level guards against serving one account's mute and block list to
 * another.
 *
 * `GET /api/profile/settings/:userId` sits behind `requireAuth` and takes the
 * account id from the URL, so before the fix it returned ANY account's whole
 * settings document to ANY authenticated caller — `privacy.hiddenWords` (the
 * mute list) and `privacy.restrictedUsers` (the block list) included.
 *
 * ## Why these are ROUTE tests and not unit tests on the projection
 *
 * Because the projection was never the weak part. `db/user/__tests__/settings.ts`
 * already covers `ensureViewerVisiblePrivacy` thoroughly, and the review found
 * that **mutating the route's call site back to the full read restored the entire
 * leak with 134 tests passing and none failing**. One line in one handler was the
 * only thing choosing the safe read, and nothing exercised it.
 *
 * PR #85 — the parallel fix on `main` — has the same shape: `viewerVisiblePrivacy`
 * is well tested, and nothing asserted the route calls it. So both fixes were
 * defended at the function and neither at the wire, which is precisely the class
 * of defect this migration keeps finding: a guard that exists, is correct, and is
 * not reached.
 *
 * Only a request through the real router catches that, so these go through one.
 *
 * ## The fixtures carry the secrets
 *
 * The defect is a PRESENCE, not an absence. A test whose fixture never stores a
 * mute list passes identically whether the projection works or not, so every
 * account below is seeded with values that must not come back — and the
 * assertions look for those VALUES anywhere in the response text, not merely for
 * the absence of a key, because a renamed key would leak exactly as well.
 */

const OWNER = 'oxy-owner-being-viewed';
const VIEWER = 'oxy-some-other-account';

/** Values that must never reach a caller who is not the subject. */
const MUTED_WORD = 'MUTEDWORDcanary';
const RESTRICTED_ACCOUNT = 'oxy-RESTRICTEDcanary';
/** Fields outside `privacy` the wider shape also served, which no caller reads. */
const DISPLAY_NAME = 'DISPLAYNAMEcanary';
const INTEREST_TAG = 'INTERESTcanary';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

/**
 * Serve the router with `callerId` attached as the authenticated user, run
 * `exercise`, then close. Oxy auth is stubbed because these tests are about what
 * the handler SERIALIZES, not about authentication — the same reasoning
 * `streamCredentialExposure.test.ts` states for the same substitution.
 */
async function withRouter(
  callerId: string,
  exercise: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthRequest).user = { id: callerId };
    next();
  });
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

/** An account whose settings carry everything a viewer must not see. */
async function seedOwner(): Promise<void> {
  const stored = await updateUserSettings(OWNER, {
    privacyHiddenWords: [MUTED_WORD],
    privacyRestrictedUsers: [RESTRICTED_ACCOUNT],
    privacyProfileVisibility: 'followers_only',
    privacyHideLikeCounts: true,
    profileCustomizationDisplayName: DISPLAY_NAME,
    interestsTags: [INTEREST_TAG],
  });

  // Without this the fixture could silently fail to store the secrets and every
  // assertion below would pass for the wrong reason — the same guard
  // `streamCredentialExposure.test.ts` puts on its RTMP key.
  if (
    !stored.privacy.hiddenWords?.includes(MUTED_WORD) ||
    !stored.privacy.restrictedUsers?.includes(RESTRICTED_ACCOUNT)
  ) {
    throw new Error('fixture failed to store the mute/block lists; the tests below would be vacuous');
  }
}

/** Assert a response body carries none of the owner-only values, under any key. */
function expectNoOwnerSecrets(body: string): void {
  expect(body).not.toContain(MUTED_WORD);
  expect(body).not.toContain(RESTRICTED_ACCOUNT);
  expect(body).not.toContain(DISPLAY_NAME);
  expect(body).not.toContain(INTEREST_TAG);
  expect(body).not.toContain('hiddenWords');
  expect(body).not.toContain('restrictedUsers');
}

describe('GET /api/profile/settings/:userId', () => {
  it('does not serve another account s mute list, block list, or anything else', async () => {
    await seedOwner();

    await withRouter(VIEWER, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/profile/settings/${OWNER}`);
      const body = await response.text();

      expect(response.status).toBe(200);
      // The response really is about that account — otherwise a handler that
      // returned `{}` would satisfy every absence assertion below.
      expect(body).toContain('followers_only');
      expect(body).toContain('hideLikeCounts');
      expectNoOwnerSecrets(body);
    });
  });

  /**
   * The same route asked for the CALLER'S OWN id still withholds. `/settings/me`
   * is the one route that returns the full document, and keeping that true of
   * every id — not just other people's — is what makes the rule checkable by
   * reading one handler instead of reasoning about who is asking.
   */
  it('withholds even when the id is the caller s own', async () => {
    await seedOwner();

    await withRouter(OWNER, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/profile/settings/${OWNER}`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expectNoOwnerSecrets(body);
    });
  });
});

describe('GET /api/profile/settings/me', () => {
  /**
   * The other half of the distinction, and the reason the fix is two reads
   * rather than one narrowed one: a route pair that withheld everywhere would
   * pass every assertion above while silently removing the owner's ability to
   * read back what they themselves muted.
   */
  it('returns the caller s own mute and block lists', async () => {
    await seedOwner();

    await withRouter(OWNER, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/profile/settings/me`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain(MUTED_WORD);
      expect(body).toContain(RESTRICTED_ACCOUNT);
      expect(body).toContain(DISPLAY_NAME);
    });
  });
});
