import { createOxyCors, createOxySocketCors } from '@oxy.so/core/server';
import { env } from '../config/env';

/**
 * The browser origins Syra's API admits, besides the HTTPS Oxy apex family
 * (`https://oxy.so`, `https://<one-label>.oxy.so`) that `@oxy.so/core` admits
 * on its own. ONE list for HTTP and Socket.IO, so the two can never drift.
 */
export const APP_ORIGINS: string[] = [
  env.FRONTEND_URL,
  'https://syra.fm',
  'https://mention.earth',
  'https://www.mention.earth',
  'http://localhost:8120',
  'http://localhost:8121',
  ...env.ALLOWED_ORIGINS,
];

/** HTTP CORS: echoes an admitted origin exactly, never a wildcard, never reflection. */
export const apiCors = createOxyCors({ appOrigins: APP_ORIGINS });

/**
 * Socket.IO's `{ cors, allowRequest }` for the same origins: `cors` answers the
 * polling transport, `allowRequest` refuses a WebSocket handshake from any other
 * browser origin (browsers apply no CORS to an upgrade).
 */
export const socketCors = createOxySocketCors({ appOrigins: APP_ORIGINS });
