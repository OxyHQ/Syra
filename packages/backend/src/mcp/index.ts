/**
 * Syra's public MCP endpoint, `https://api.syra.fm/mcp` (docs/mcp.md).
 *
 * Sign-in is Oxy's MCP OAuth: a client discovers Oxy from the 401 challenge
 * and `/.well-known/oauth-protected-resource/mcp`, registers itself
 * dynamically with Oxy, and the person approves the connection on
 * auth.oxy.so. Every request carries a short-lived token Oxy issued for this
 * resource and is introspected live, so the transport is stateless and any
 * task can answer any request. Oxy only issues tokens for a resource a
 * registered catalogue declares, so the catalogue is registered at boot.
 */

import type express from 'express';
import {
  capabilityCatalogDigest,
  createCatalogMcpHttpService,
  OxyMcpRequestError,
  registerCapabilityCatalog,
} from '@oxy.so/mcp';
import { env } from '../config/env';
import { oxy } from '../oxyClient';
import { describeErrorSafely } from '../utils/error';
import { logger } from '../utils/logger';
import { authorize, handlers, SYRA_MCP_CATALOG } from './catalog';

/** Browser clients that may call the endpoint directly; server-side connectors send no Origin. */
const CLAUDE_ORIGINS = ['https://claude.ai', 'https://www.claude.ai'];

const oxyTransport = oxy.createServiceClient({ baseURL: env.OXY_API_URL, audience: 'oxy-api' });

const service = createCatalogMcpHttpService({
  catalog: SYRA_MCP_CATALOG,
  handlers,
  authorize,
  authorizationServer: env.OXY_API_URL,
  transport: oxyTransport,
  allowedOrigins: CLAUDE_ORIGINS,
  serverName: 'syra',
  logger: {
    error: (message, error) =>
      logger.error(`[mcp] ${message}`, { err: describeErrorSafely(error) }),
  },
});

/**
 * Mounted before the JSON parser, CORS and the API rate limiter: the transport
 * reads the raw body, answers its own CORS and authenticates every request.
 */
export function mountMcp(app: express.Express): void {
  app.all('/mcp', (req, res) => {
    void service.handleMcp(req, res);
  });
  // RFC 9728 puts a path-bearing resource's metadata under its path; the bare
  // well-known path is served too, for clients that look there first.
  app.all(
    [service.protectedResourceMetadataPath, '/.well-known/oauth-protected-resource'],
    (req, res) => {
      service.handleProtectedResourceMetadata(req, res);
    },
  );
}

const RETRY_FLOOR_MS = 5_000;
const RETRY_CEILING_MS = 10 * 60_000;

/** A 4xx other than these is a configuration refusal that no retry fixes. */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof OxyMcpRequestError)) return true;
  return error.status >= 500 || [401, 408, 429].includes(error.status);
}

/**
 * Register the catalogue until Oxy accepts it, with capped, jittered backoff;
 * stop on a configuration refusal. Never throws: an Oxy outage delays MCP
 * sign-in, it does not take the API down.
 */
export async function registerMcpCatalog(): Promise<void> {
  const digest = capabilityCatalogDigest(SYRA_MCP_CATALOG);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await registerCapabilityCatalog(SYRA_MCP_CATALOG, {
        oxyApiUrl: env.OXY_API_URL,
        transport: oxyTransport,
      });
      logger.info('[mcp] catalogue registered', { version: SYRA_MCP_CATALOG.version, digest });
      return;
    } catch (error) {
      if (!isRetryable(error)) {
        logger.error('[mcp] Oxy refused the catalogue; MCP sign-in stays off until it is fixed', {
          err: describeErrorSafely(error),
        });
        return;
      }
      const ceiling = Math.min(RETRY_CEILING_MS, RETRY_FLOOR_MS * 2 ** Math.min(attempt, 10));
      const delay = RETRY_FLOOR_MS + Math.random() * (ceiling - RETRY_FLOOR_MS);
      logger.warn('[mcp] catalogue registration failed; retrying', {
        attempt,
        retryInMs: Math.round(delay),
        err: describeErrorSafely(error),
      });
      await new Promise<void>((resolve) => setTimeout(resolve, delay).unref());
    }
  }
}
