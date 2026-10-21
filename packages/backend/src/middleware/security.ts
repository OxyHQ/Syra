import slowDown from 'express-slow-down';
import type { RequestHandler } from 'express';
import { Request, Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';

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

export { bruteForceProtection };
