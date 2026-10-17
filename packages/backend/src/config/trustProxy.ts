import type { Express } from 'express';

/**
 * How many proxies stand between a client and this process: exactly one.
 *
 * `api.syra.fm` resolves straight to the shared `oxy-alb` (no CDN in front of
 * it), and that ALB forwards to the ECS task with
 * `routing.http.xff_header_processing.mode = append`: it APPENDS the address
 * of the peer it accepted the connection from to whatever `X-Forwarded-For`
 * the client sent. So the right-most entry is the only one written by
 * infrastructure; every entry to its left is whatever the client chose to send.
 *
 * `trust proxy` = 1 tells Express to trust that one hop and take `req.ip` from
 * the right-most entry. `true` (what this used to be) trusts the LEFT-most entry
 * instead — a value the client controls — and every per-IP limiter keyed on
 * `req.ip` (the Oxy limiter's anonymous bucket, the public-cards limiter, the
 * slow-down) became one header away from a fresh bucket per request.
 *
 * If a hop is ever added in front of the ALB (a CDN, Global Accelerator with
 * XFF, another proxy), this number grows by one with it, or `req.ip` becomes
 * that proxy's address and every anonymous client shares one bucket.
 */
export const TRUSTED_PROXY_HOPS = 1;

export function trustLoadBalancer(app: Express): void {
  app.set('trust proxy', TRUSTED_PROXY_HOPS);
}
