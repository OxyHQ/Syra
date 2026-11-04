import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

/**
 * The one Oxy client this process has, authenticated as Syra's workload.
 *
 * - Workload identity only: temporary role/SSO credentials also work outside
 *   ECS. Construction is lazy with respect to attestation; failures surface when
 *   a call actually needs authority. No customer key can replace Syra's identity.
 * - `serviceIdentity: 'when-anonymous'`: session-less reads (`users.getMany`, …)
 *   carry the service token instead of being charged to the NAT address.
 * - `applicationId`: the application whose roles `requireAppPermission` reads
 *   (`compliance.review`). Unset, the SDK takes it from the workload's service
 *   token, which names the same application.
 */
export const oxy = new OxyServer({
  baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
  applicationId: process.env.OXY_APPLICATION_ID || undefined,
  serviceIdentity: 'when-anonymous',
  workloadCredentials: createAwsWorkloadCredentialProvider(),
});
