import { OxyServices } from '@oxyhq/core';

/**
 * Shared OxyServices client singleton.
 *
 * Lives in its own side-effect-free module (NOT `server.ts`) so controllers,
 * sockets, and services can import the client without pulling in the server
 * bootstrap (express/socket.io/redis) — keeping unit tests that import those
 * modules cheap and isolated. Reads `OXY_API_URL` directly (matching the
 * `env.ts` default) rather than importing the full env schema, so importing this
 * module never forces the env validation (e.g. the required `MONGODB_URI`).
 */
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';

export const oxy = new OxyServices({ baseURL: OXY_API_URL });
