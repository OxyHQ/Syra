import type { Express } from 'express';
import { oxyTrustProxy } from '@oxy.so/core/server';

/**
 * Which proxies `req.ip` may be read through: the Oxy rule, `oxyTrustProxy`
 * from `@oxy.so/core`, and no hop count.
 *
 * `api.syra.fm` is served by the shared `oxy-alb`, which APPENDS the address of
 * the peer it accepted the connection from to `X-Forwarded-For`
 * (`xff_header_processing.mode = append`), and is moving behind the Cloudflare
 * proxy. So the chain is either `client → ALB → task` (DNS-only) or
 * `client → Cloudflare edge → ALB → task` (proxied). A fixed `trust proxy = 1`
 * answered the right-most entry, which in the second shape is Cloudflare's edge:
 * every per-IP limiter keyed on `req.ip` (the Oxy limiter's anonymous bucket,
 * the public-cards limiter, the slow-down) would have collapsed onto a handful
 * of edge addresses. `true` was worse still — the LEFT-most entry, which the
 * client writes.
 *
 * `oxyTrustProxy` trusts the socket peer only when it is private (the ALB), the
 * next hop only when it is a published Cloudflare address, and nothing further
 * out — so `req.ip` is the real client in both shapes, before and after the
 * hostname is proxied, and a forged entry is never believed.
 */
export function trustLoadBalancer(app: Express): void {
  app.set('trust proxy', oxyTrustProxy);
}
