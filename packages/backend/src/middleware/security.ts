import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import slowDown from "express-slow-down";
import type { RequestHandler } from "express";
import { Request, Response } from "express";
import { AuthRequest } from "./auth";
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

/**
 * Generate a rate limit key based on user authentication status
 * Uses user ID for authenticated users, IP address for unauthenticated users
 */
function generateRateLimitKey(req: Request, prefix: string): string {
  const authReq = req as AuthRequest;
  if (authReq.user?.id) {
    return `${prefix}:user:${authReq.user.id}`;
  }
  // Extract IP and use ipKeyGenerator helper for proper IPv6 handling
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  // ipKeyGenerator takes the IP string and properly handles IPv6 subnets
  const ipKey = ipKeyGenerator(ip);
  return `${prefix}:${ipKey}`;
}

/**
 * Get rate limit max value based on authentication status
 */
function getRateLimitMax(req: Request, authenticatedLimit: number, unauthenticatedLimit: number): number {
  const authReq = req as AuthRequest;
  return authReq.user?.id ? authenticatedLimit : unauthenticatedLimit;
}

// Rate limiter for link refresh operations (stricter limits)
// Link refresh is expensive (fetching HTML, downloading images, processing)
const linkRefreshStore = new RedisStore({ 
  prefix: 'rate-limit:link-refresh:',
  windowMs: 60 * 60 * 1000 // 1 hour
});
export const linkRefreshRateLimiter = rateLimit({
  store: linkRefreshStore,
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req: Request) => getRateLimitMax(req, 50, 20),
  keyGenerator: (req: Request) => generateRateLimitKey(req, 'link-refresh'),
  message: "Too many link refresh requests. Please wait before refreshing more links.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for clearing cache (very strict - should be rare)
const linkCacheClearStore = new RedisStore({ 
  prefix: 'rate-limit:link-cache-clear:',
  windowMs: 60 * 60 * 1000 // 1 hour
});
export const linkCacheClearRateLimiter = rateLimit({
  store: linkCacheClearStore,
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req: Request) => getRateLimitMax(req, 10, 5),
  keyGenerator: (req: Request) => generateRateLimitKey(req, 'link-cache-clear'),
  message: "Too many cache clear requests. Please wait before clearing cache again.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for feed endpoints (per user: 100 requests/minute)
const feedStore = new RedisStore({ 
  prefix: 'rate-limit:feed:',
  windowMs: 60 * 1000 // 1 minute
});
export const feedRateLimiter = rateLimit({
  store: feedStore,
  windowMs: 60 * 1000, // 1 minute
  max: (req: Request) => {
    const authReq = req as AuthRequest;
    // Authenticated users: 100 requests per minute
    // Unauthenticated users: 50 requests per minute
    return authReq.user?.id ? 100 : 50;
  },
  keyGenerator: (req: Request) => {
    const authReq = req as AuthRequest;
    if (authReq.user?.id) {
      return `user:${authReq.user.id}`;
    }
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    return ipKeyGenerator(ip);
  },
  message: "Too many feed requests. Please slow down.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for feed endpoints (per IP: 10 requests/second)
const feedIPStore = new RedisStore({ 
  prefix: 'rate-limit:feed-ip:',
  windowMs: 1000 // 1 second
});
export const feedIPRateLimiter = rateLimit({
  store: feedIPStore,
  windowMs: 1000, // 1 second
  max: 10, // 10 requests per second per IP
  keyGenerator: (req: Request) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    return ipKeyGenerator(ip);
  },
  message: "Too many requests from this IP. Please slow down.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Request throttling for expensive feed operations (For You feed with ranking)
const feedThrottleStore = new RedisStore({ 
  prefix: 'rate-limit:feed-throttle:',
  windowMs: 60 * 1000 // 1 minute
});
export const feedThrottle: RequestHandler = slowDown({
  store: feedThrottleStore,
  windowMs: 60 * 1000, // 1 minute
  delayAfter: (req: Request) => {
    // Throttle expensive operations (For You feed, Explore feed)
    const feedType = (req.query.type as string) || '';
    if (feedType === 'for_you' || feedType === 'explore') {
      const authReq = req as AuthRequest;
      return authReq.user?.id ? 20 : 10; // Lower limit for expensive operations
    }
    return 100; // Higher limit for simple operations
  },
  delayMs: () => 1000, // Add 1 second delay per request above limit
  keyGenerator: (req: Request) => {
    const authReq = req as AuthRequest;
    const feedType = (req.query.type as string) || 'mixed';
    if (authReq.user?.id) {
      return `user:${authReq.user.id}:${feedType}`;
    }
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    return `${ipKeyGenerator(ip)}:${feedType}`;
  },
  skip: (req: Request) => {
    // Don't throttle simple feed types
    const feedType = (req.query.type as string) || '';
    return !['for_you', 'explore'].includes(feedType);
  }
});

export { rateLimiter, bruteForceProtection };
