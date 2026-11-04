/**
 * Syra's application permissions — who operates Syra is decided in Oxy
 * (`~/Oxy/docs/application-roles.md`), not by a list of user ids here.
 *
 * Declare each key on Syra's Oxy application (Console → application →
 * Settings → Roles, or `PUT /applications/:appId/roles/permissions`); the
 * owning account's owners and admins grant it to people. Until a key is
 * declared and granted, its gate refuses everyone.
 */
export const APPLICATION_PERMISSIONS = [
  {
    key: 'compliance.review',
    description:
      'Resolve copyright reports and artist claims: takedowns, strikes and handing over contributed artist profiles.',
  },
] as const;

/** Resolving a compliance decision (`middleware/complianceReviewer.ts`). */
export const COMPLIANCE_REVIEW_PERMISSION = APPLICATION_PERMISSIONS[0].key;
