import { createEcosystemTraffic, type WorkloadCredentialProvider } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

/** Start once per deployed process; local sessions have no infrastructure location. */
export function startPlatformActivity(
  ready: () => boolean,
  service = 'syra',
  workloadCredentials: WorkloadCredentialProvider = createAwsWorkloadCredentialProvider(),
) {
  if (process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED !== 'true') return undefined;
  const traffic = createEcosystemTraffic({
    service,
    ready,
    workloadCredentials,
  });
  traffic.installFetch();
  return traffic;
}
