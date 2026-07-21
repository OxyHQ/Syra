import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import slowDown from "express-slow-down";
import type { RequestHandler } from "express";
import { Request, Response } from "express";
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { RedisStore } from "./rateLimitStore";

// Create Redis store for distributed rate limiting
const redisStore = new RedisStore({ 
  prefix: 'rate-limit:api:',
  windowMs: 15 * 60 * 1000 // 15 minutes
});

/**
 * Paths exempt from the global API rate limiter.
 *
 * A music app fans out into MANY small GETs per screen (cover art, artist
 * images, HLS manifest/key/segment sub-requests). Counting every image and
 * every streaming sub-request against the same bucket exhausts it almost
 * instantly. These are cheap, cacheable, and individually authorised, so they
 * are excluded from the coarse global limiter (streaming has its own token
 * guard; images are served from S3/cache).
 */
function isRateLimitExempt(req: Request): boolean {
  const path = req.path;
  return (
    path.startsWith('/files/upload') ||
    // Image proxy: a single screen can request dozens of covers/avatars.
    path.startsWith('/api/images/') ||
    path.includes('/images/') ||
    // HLS streaming sub-requests (master/variant playlists, key, segments).
    path.startsWith('/api/stream/') ||
    // Liveness/readiness probes from the ALB/ECS must never be limited.
    path === '/health'
  );
}

// Rate limiting middleware with Redis store for distributed rate limiting.
// Realistic limits for a media app: authenticated users fan out into many small
// requests per screen, so the per-user budget is generous. The limiter runs
// AFTER user resolution (see server.ts), so authenticated traffic is keyed per
// user — not per shared egress IP behind the ALB.
const rateLimiter = rateLimit({
  store: redisStore,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: (req: Request) => {
    const authReq = req as AuthRequest;
    // Authenticated users: 5000 requests per 15 minutes (~5.5/sec sustained).
    // Unauthenticated users: 600 per 15 minutes (~0.66/sec) — enough to browse
    // public pages while still bounding anonymous abuse.
    return authReq.user?.id ? 5000 : 600;
  },
  keyGenerator: (req: Request) => {
    const authReq = req as AuthRequest;
    if (authReq.user?.id) {
      return `user:${authReq.user.id}`;
    }
    // Extract IP and use ipKeyGenerator helper for proper IPv6 handling
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    // ipKeyGenerator takes the IP string and properly handles IPv6 subnets
    return ipKeyGenerator(ip);
  },
  message: "Too many requests, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  skip: isRateLimitExempt,
});

// Brute force protection middleware (exclude uploads, images, streaming, health)
const bruteForceProtection: RequestHandler = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: (req: Request) => {
    const authReq = req as AuthRequest;
    return authReq.user?.id ? 5000 : 600;
  },
  delayMs: () => 500, // add 500ms delay per request above limit
  skip: isRateLimitExempt,
});

export { rateLimiter, bruteForceProtection };
