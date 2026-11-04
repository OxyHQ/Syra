/**
 * Syra's application permissions — who operates Syra is decided in Oxy
 * (`~/Oxy/docs/application-roles.md`), not by a list of user ids here.
 *
 * Syra is one of Oxy's own applications, so each key, and the roles of the
 * organization that owns Syra that hold it (today its owners and admins), is
 * declared in code in oxy's first-party registry (`operatorPermissions` on
 * Syra's entry in `packages/api/src/scripts/seedOxyApplicationsSpecs.ts`) and
 * applied by oxy's "Seed Oxy applications" workflow (oxy ADR 0056). Nobody
 * grants it per person: the Oxy Console shows it read-only and the API refuses
 * a grant with `409 FIRST_PARTY_ROLES_IN_CODE`. To make someone a reviewer,
 * give them that role in the organization.
 *
 * Every key here must match the registry exactly: a key renamed on one side
 * only, or not yet seeded, makes its gate refuse everyone.
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
