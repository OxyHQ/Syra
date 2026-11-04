import { spyOn } from 'bun:test';
import {
  OxyAppPermissionError,
  type AppPermissionsOptions,
  type OxyAppPermissions,
  type OxyAuthRequest,
} from '@oxy.so/core/server';
import { COMPLIANCE_REVIEW_PERMISSION } from '../config/applicationPermissions';
import { oxy } from '../oxyClient';

export const TEST_APPLICATION_ID = 'app-syra';

/** What Oxy answers for one operator: the permissions they hold on Syra's application. */
export function heldPermissions(operatorId: string, permissions: string[]): OxyAppPermissions {
  return {
    applicationId: TEST_APPLICATION_ID,
    operatorId,
    permissions,
    has: (permission) => permissions.includes(permission),
  };
}

/**
 * Stand in for Oxy's `GET /applications/:appId/roles/me` behind the REAL
 * `oxy.middleware.requireAppPermission`: `holders` hold `compliance.review`,
 * every other signed-in person holds nothing, and a request without a person is
 * refused the way the SDK refuses it. `restore()` it after the test;
 * `optionsSeen()` is what each lookup was asked with.
 */
export function stubComplianceReviewers(holders: readonly string[]): {
  restore(): void;
  optionsSeen(): Array<AppPermissionsOptions | undefined>;
} {
  const spy = spyOn(oxy, 'appPermissionsFor').mockImplementation(
    async (req: OxyAuthRequest, _options?: AppPermissionsOptions) => {
      const userId = req.userId;
      if (!userId || !req.sessionId || !req.accessToken) {
        throw new OxyAppPermissionError('APP_PERMISSION_SESSION_REQUIRED', 'no session');
      }
      return heldPermissions(
        userId,
        holders.includes(userId) ? [COMPLIANCE_REVIEW_PERMISSION] : [],
      );
    },
  );
  return {
    restore: () => spy.mockRestore(),
    optionsSeen: () => spy.mock.calls.map((call) => call[1]),
  };
}

/** A request as `requireComplianceReviewer` leaves it for a holder. */
export function asComplianceReviewer<T extends object>(req: T, operatorId: string): T {
  return Object.assign(req, {
    oxyAppPermissions: heldPermissions(operatorId, [COMPLIANCE_REVIEW_PERMISSION]),
  });
}
