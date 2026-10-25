import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

/** Shared workload identity. Temporary role/SSO credentials also work outside ECS.
 * Construction is lazy with respect to attestation; failures surface when a call
 * actually needs authority. No customer key can replace Syra's identity.
 */
export const oxy = new OxyServer({
  baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
  workloadCredentials: createAwsWorkloadCredentialProvider(),
});

/** Shared protocol-2 transport for Oxy endpoints without a product facade. */
export const oxyTransport = oxy.createServiceClient({
  baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
  audience: 'oxy-api',
});
