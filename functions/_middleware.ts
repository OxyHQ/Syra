import { observeEdgeRequest } from '@oxy.so/telemetry/edge';

type EdgeOptions = Parameters<typeof observeEdgeRequest>[0];
type PagesContext = EdgeOptions['ctx'] & Pick<EdgeOptions, 'request' | 'env' | 'next'>;

// Both Pages deployments run from the repository root, sharing this middleware.
export function onRequest(context: PagesContext) {
  return observeEdgeRequest({ service: 'syra', request: context.request, env: context.env, ctx: context, next: () => context.next() });
}
