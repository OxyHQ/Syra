import { env } from './src/config/env';

import express from 'express';
import http from 'http';
import compression from 'compression';
import cors from 'cors';
import { Server as SocketIOServer, Socket, Namespace } from 'socket.io';
import { createOptionalOxyAuth, createOxyRateLimit } from '@oxyhq/core/server';
import { oxy } from './src/oxyClient';

import { connectPostgres, isPostgresConnected } from './src/db/postgres';
import { createRedisPubSub, isRedisConnected, getRedisStats } from './src/utils/redis';
import { ensureRedisConnected, isRedisConnectionError } from './src/utils/redisHelpers';
import { createAdapter } from '@socket.io/redis-adapter';
import { logger } from './src/utils/logger';
import { bruteForceProtection } from './src/middleware/security';
import { performanceMiddleware, getPerformanceStats } from './src/middleware/performance';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { RedisStore } from './src/middleware/rateLimitStore';

import { setupPlayerSocket } from './src/sockets/playerSocket';
import { setupPlaylistSocket } from './src/sockets/playlistSocket';

import searchRoutes from './src/routes/search';
import browseRoutes from './src/routes/browse';
import profileSettingsRoutes from './src/routes/profileSettings';
import tracksRoutes from './src/routes/tracks.routes';
import albumsRoutes from './src/routes/albums.routes';
import artistsRoutes from './src/routes/artists.routes';
import artistsAuthRoutes from './src/routes/artists.auth.routes';
import playlistsRoutes from './src/routes/playlists.routes';
import libraryRoutes from './src/routes/library.routes';
import audioRoutes from './src/routes/audio.routes';
import queueRoutes from './src/routes/queue.routes';
import uploadsRoutes from './src/routes/uploads.routes';
import musicPreferencesRoutes from './src/routes/musicPreferences.routes';
import copyrightRoutes from './src/routes/copyright.routes';
import artistClaimsRoutes from './src/routes/artistClaims.routes';
import imagesPublicRoutes from './src/routes/images.public.routes';
import imagesAuthRoutes from './src/routes/images.auth.routes';
import previewRoutes from './src/routes/preview.routes';
import streamRoutes from './src/routes/stream.routes';
import lyricsRoutes from './src/routes/lyrics.routes';
import radioRoutes from './src/routes/radio.routes';
import recommendationsRoutes from './src/routes/recommendations.routes';
import podcastsRoutes from './src/routes/podcasts.routes';
import episodesRoutes from './src/routes/episodes.routes';
import entityProfileRoutes from './src/routes/entityProfile.routes';
import roomsRoutes from './src/routes/rooms.routes';
import housesRoutes from './src/routes/houses.routes';
import seriesRoutes from './src/routes/series.routes';
import recordingsRoutes from './src/routes/recordings.routes';
import livekitWebhookRoutes from './src/routes/livekitWebhook.routes';
import reportsRoutes from './src/routes/reports.routes';
import { createCrowdSourceWebhookRoutes } from './src/routes/crowdsourceWebhook.routes';
import { assertModerationSchema, getModerationIntegration } from './src/moderation/integration';
import { initializeRoomSocket } from './src/sockets/roomSocket';
import { initializeIO } from './src/utils/socket';
import { startRecommendationScheduler } from './src/services/recommendations/scheduler';
import { startPodcastRefreshScheduler } from './src/services/podcasts/podcastRefreshScheduler';
import { startIngestWorker } from './src/services/ingest/ingestQueue';
import { startExpirySweeper } from './src/services/uploads/expirySweeper';

const app = express();

app.set('trust proxy', true);

const ALLOWED_ORIGINS: string[] = [
  env.FRONTEND_URL,
  'https://syra.fm',
  'https://mention.earth',
  'https://www.mention.earth',
  // Alia (alia.onl) generates podcast episodes into Syra-hosted shows and plays
  // them back from `/api/podcasts/episodes/:id/audio` with the listener's own
  // bearer token. That is a browser fetch carrying `Authorization`, so it is
  // preflighted and needs an exact origin entry here — `Authorization` is
  // already in ALLOWED_HEADERS. Native Alia is unaffected either way: React
  // Native sends no `Origin` header and is not subject to CORS at all.
  //
  // Only the app origin. `console.alia.onl` and the canvas do not play audio,
  // and a first-party app is listed here rather than pushed through
  // ALLOWED_ORIGINS because that variable is absent from the deploy workflow's
  // secret allow-list, where an unnamed secret arrives as an empty string with
  // no error at all.
  'https://alia.onl',
  'http://localhost:8120',
  'http://localhost:8121',
  ...env.ALLOWED_ORIGINS,
];

// One source of truth for the CORS allow-list so the HTTP and Socket.IO
// configs can never drift apart. `X-Syra-Device-Id` lets a guest identify its
// device for radio/session reads (not a security boundary — see radio.controller).
const ALLOWED_HEADERS = ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Requested-With', 'Accept', 'Accept-Version', 'Content-Length', 'Content-MD5', 'Date', 'X-Api-Version', 'X-Syra-Device-Id'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ALLOWED_HEADERS,
}));

// LiveKit webhook — mounted BEFORE the global JSON parser (and the rate limiter)
// because its own raw body parser must own the request bytes for signature
// verification; a JSON re-serialization would invalidate the LiveKit signature.
// The route is machine-to-machine and gated entirely by cryptographic signature
// verification, so it needs no per-request rate limit.
app.use('/livekit', livekitWebhookRoutes);

// The CrowdSource webhook receiver, mounted here for the SAME reason and with the
// same consequence if it moves: its HMAC covers the exact bytes that arrived, and
// it reads the request stream itself. Below the JSON parser it would be verifying
// a signature over a re-serialization. The route refuses outright rather than
// falling back (`assertRawBody`), and a test asserts the refusal, because a mount
// order is not something a type can hold.
app.use('/webhooks', createCrowdSourceWebhookRoutes());

// Create Redis store for distributed rate limiting
const redisStore = new RedisStore({ 
  prefix: 'rate-limit:api:',
  windowMs: 15 * 60 * 1000
});

// Single middleware that resolves session + applies per-user rate limiting
app.use(createOxyRateLimit(oxy, { store: redisStore }));

app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  },
  level: 6,
  threshold: 1024,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Must be registered BEFORE any router: Express runs middleware in registration
// order, so mounting this after the /api routers means every API request is
// terminated by a router before it is ever measured — /health would then report
// stats built from nothing but /health itself and 404s.
app.use(performanceMiddleware);

app.use((req, _res, next) => {
  if (req.query && typeof req.query === 'object') {
    const filters: Record<string, unknown> = {};
    for (const key of Object.keys(req.query)) {
      const match = key.match(/^filters\[(.+)\]$/);
      if (match) {
        const filterKey = match[1];
        if (!filters[filterKey]) {
          filters[filterKey] = req.query[key];
        }
      }
    }
    if (Object.keys(filters).length > 0) {
      (req.query as Record<string, unknown>).filters = filters;
    }
  }
  next();
});

const server = http.createServer(app);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 120_000;

type DisconnectReason =
  | 'server disconnect' | 'client disconnect' | 'transport close' | 'transport error'
  | 'ping timeout' | 'parse error' | 'forced close' | 'forced server close'
  | 'server shutting down' | 'client namespace disconnect' | 'server namespace disconnect'
  | 'unknown transport';

const SOCKET_CONFIG = {
  PING_TIMEOUT: 60000,
  PING_INTERVAL: 20000,
  UPGRADE_TIMEOUT: 30000,
  CONNECT_TIMEOUT: 45000,
  MAX_BUFFER_SIZE: 1e8,
  COMPRESSION_THRESHOLD: 1024,
  CHUNK_SIZE: 10 * 1024,
  WINDOW_BITS: 14,
  COMPRESSION_LEVEL: 6,
} as const;

const io = new SocketIOServer(server, {
  transports: ['websocket', 'polling'],
  path: '/socket.io',
  pingTimeout: SOCKET_CONFIG.PING_TIMEOUT,
  pingInterval: SOCKET_CONFIG.PING_INTERVAL,
  upgradeTimeout: SOCKET_CONFIG.UPGRADE_TIMEOUT,
  maxHttpBufferSize: SOCKET_CONFIG.MAX_BUFFER_SIZE,
  connectTimeout: SOCKET_CONFIG.CONNECT_TIMEOUT,
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ALLOWED_HEADERS,
  },
  perMessageDeflate: {
    threshold: SOCKET_CONFIG.COMPRESSION_THRESHOLD,
    zlibInflateOptions: { chunkSize: SOCKET_CONFIG.CHUNK_SIZE, windowBits: SOCKET_CONFIG.WINDOW_BITS },
    zlibDeflateOptions: { chunkSize: SOCKET_CONFIG.CHUNK_SIZE, windowBits: SOCKET_CONFIG.WINDOW_BITS, level: SOCKET_CONFIG.COMPRESSION_LEVEL },
  },
});

// Register the shared io singleton so main-namespace signal broadcasters
// (e.g. `emitLiveRoomsUpdated`) can reach connected clients.
initializeIO(io);

(async () => {
  try {
    const { publisher, subscriber } = createRedisPubSub();

    await Promise.race([
      Promise.all([publisher.connect(), subscriber.connect()]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Redis connection timeout')), 5000)),
    ]);

    const publisherReady = await ensureRedisConnected(publisher);
    const subscriberReady = await ensureRedisConnected(subscriber);

    if (!publisherReady || !subscriberReady) {
      throw new Error('Redis clients connected but not ready');
    }

    await Promise.all([publisher.ping(), subscriber.ping()]);

    io.adapter(createAdapter(publisher, subscriber));
    logger.info('Socket.IO Redis adapter configured for horizontal scaling');
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (isRedisConnectionError(err) || err.message.includes('timeout') || err.message.includes('not ready')) {
      logger.info('Redis unavailable - Socket.IO running in single-instance mode');
    } else {
      logger.warn('Failed to setup Socket.IO Redis adapter, running in single-instance mode');
    }
  }
})();

const configureNamespaceErrorHandling = (namespace: Namespace) => {
  namespace.on('connection_error', (error: Error) => {
    logger.error('Connection error in namespace', { err: error, namespace: namespace.name });
  });
};

const musicNamespace = io.of('/music');

const playerNamespace = setupPlayerSocket(io);
const playlistNamespace = setupPlaylistSocket(io);
const roomsNamespace = initializeRoomSocket(io);

[musicNamespace, roomsNamespace, io].forEach((ns) => {
  if (ns && typeof ns.use === 'function') {
    ns.use(oxy.authSocket());
  }
});

musicNamespace.on('connection', (socket: Socket) => {
  logger.info('Client connected to music namespace', { ip: socket.handshake.address });

  socket.on('error', (error: Error) => {
    logger.error('Music socket error', { err: error });
  });

  socket.on('disconnect', (reason: DisconnectReason) => {
    logger.debug('Client disconnected from music namespace', { socketId: socket.id, reason });
  });
});

[musicNamespace, playerNamespace, playlistNamespace, roomsNamespace].forEach((namespace) => {
  configureNamespaceErrorHandling(namespace);
});

io.on('connection', (socket: Socket) => {
  logger.info('Client connected', { ip: socket.handshake.address });

  socket.on('error', (error: Error) => {
    logger.error('Socket error', { err: error });
    if (socket.connected) {
      socket.disconnect();
    }
  });

  socket.on('disconnect', (reason: DisconnectReason) => {
    logger.debug('Client disconnected', { socketId: socket.id, reason });
  });
});

app.set('io', io);
(global as Record<string, unknown>).io = io;
app.set('musicNamespace', musicNamespace);

const publicApiRouter = express.Router();
publicApiRouter.use('/tracks', tracksRoutes);
publicApiRouter.use('/albums', albumsRoutes);
publicApiRouter.use('/artists', artistsRoutes);
publicApiRouter.use('/playlists', playlistsRoutes);

publicApiRouter.use('/search', searchRoutes);
publicApiRouter.use('/browse', browseRoutes);
// Copyright: public reporting (a rightsholder need not have a Syra account) plus
// the reviewer-gated queue and resolution, which self-enforce with requireAuth +
// the compliance reviewer allowlist. Mounted ONCE — a second mount on the
// authenticated router below was unreachable, because this one matches first, and
// its only effect was that every report recorded an undefined reporter.
publicApiRouter.use('/copyright', createOptionalOxyAuth(oxy), copyrightRoutes);
publicApiRouter.use('/stream', createOptionalOxyAuth(oxy), streamRoutes);
// Listener uploads: every handler self-enforces (`requireAuth`, plus an owner
// check inside the query that loads the document). Optional auth rather than the
// authenticated router for the same reason `/stream` is here — the HLS
// sub-resources are fetched by media players that carry a `?t=` stream token in
// the URL and cannot set an Authorization header.
publicApiRouter.use('/uploads', createOptionalOxyAuth(oxy), uploadsRoutes);
publicApiRouter.use('/images', imagesPublicRoutes);
publicApiRouter.use('/preview', createOptionalOxyAuth(oxy), previewRoutes);
publicApiRouter.use('/lyrics', lyricsRoutes);

// Radio: public stations for guests (preview-capped) and personalised, unlimited
// ones for a signed-in listener. Optional auth resolves which.
publicApiRouter.use('/radio', createOptionalOxyAuth(oxy), radioRoutes);


// Live rooms: public discovery (optional auth resolves the viewer for
// visibility gating); write routes self-enforce auth internally.
publicApiRouter.use('/rooms', createOptionalOxyAuth(oxy), roomsRoutes);

// Podcasts: public reads + audio/HLS stream; private/creator routes self-enforce
// with requireAuth. Optional auth resolves the session for entitlement + progress.
publicApiRouter.use('/podcasts', createOptionalOxyAuth(oxy), podcastsRoutes);
publicApiRouter.use('/episodes', createOptionalOxyAuth(oxy), episodesRoutes);
publicApiRouter.use('/p', createOptionalOxyAuth(oxy), entityProfileRoutes);

const authenticatedApiRouter = express.Router();
authenticatedApiRouter.use('/profile', profileSettingsRoutes);
authenticatedApiRouter.use('/artists', artistsAuthRoutes);
authenticatedApiRouter.use('/playlists', playlistsRoutes);
authenticatedApiRouter.use('/images', imagesAuthRoutes);
authenticatedApiRouter.use('/library', libraryRoutes);
authenticatedApiRouter.use('/audio', audioRoutes);
authenticatedApiRouter.use('/queue', queueRoutes);
authenticatedApiRouter.use('/music', musicPreferencesRoutes);
authenticatedApiRouter.use('/artist-claims', artistClaimsRoutes);
authenticatedApiRouter.use('/recommendations', recommendationsRoutes);
authenticatedApiRouter.use('/recordings', recordingsRoutes);
authenticatedApiRouter.use('/houses', housesRoutes);
authenticatedApiRouter.use('/series', seriesRoutes);
authenticatedApiRouter.use('/reports', reportsRoutes);

app.use('/api', publicApiRouter);
app.use('/api', oxy.auth(), authenticatedApiRouter);

app.get('', async (_req, res) => {
  res.json({ message: 'Welcome to Syra API', version: '1.0.0' });
});

app.get('/health', async (_req, res) => {
  try {
    const [dbConnected, redisConnected] = await Promise.all([
      Promise.resolve(isPostgresConnected()),
      isRedisConnected(),
    ]);

    // What /health has reported as "database" since the migration finished: the
    // POSTGRES pool, which is now the only one. It reported Mongo's
    // `readyState` until Task 8 removed the last Mongoose model — and a health
    // endpoint answering about a database the service no longer opens is worse
    // than one answering nothing, because it reads as green forever.
    const dbStats = { engine: 'postgres' as const, state: dbConnected ? 'connected' : 'disconnected' };
    const redisStats = getRedisStats();
    const perfStats = getPerformanceStats();

    const health = {
      status: dbConnected ? (redisConnected ? 'healthy' : 'degraded') : 'unhealthy',
      timestamp: new Date().toISOString(),
      services: {
        database: { ...dbStats, connected: dbConnected },
        redis: { ...redisStats, connected: redisConnected },
      },
      performance: perfStats,
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      uptime: Math.round(process.uptime()),
    };

    const statusCode = dbConnected ? 200 : 503;
    res.status(statusCode).json(health);
  } catch (error) {
    logger.error('Health check failed', { err: error });
    res.status(503).json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

app.use((err: Error & { statusCode?: number; status?: number }, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', {
    err,
    path: req.path,
    method: req.method,
  });

  const statusCode = err.statusCode ?? err.status ?? 500;
  const message = err.message || 'Internal Server Error';

  res.status(statusCode).json({
    error: message,
    ...(env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

const bootServer = async () => {
  /**
   * PostgreSQL, and now the only database this service opens.
   *
   * Log-and-continue, which is what every route here expects: `withDb` answers
   * 503 per request when the pool is down, so a boot that failed closed would
   * trade a degraded service for an outage. (It is also what the Mongo
   * connection that used to sit beside this one did, which is why the routes
   * were written against those semantics in the first place.)
   *
   * This is about a database that is UNREACHABLE. An unset or non-`postgres://`
   * `DATABASE_URL` is a different failure and never gets here: `config/env.ts`
   * refuses the boot in production, because a service that starts and then 503s
   * every route is the shape that hides a misconfiguration indefinitely.
   */
  try {
    await connectPostgres();
  } catch (error) {
    logger.warn('PostgreSQL connection unavailable - ported routes will fail until it is reachable', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }

  server.listen(env.PORT, '0.0.0.0', () => {
    logger.info('Server running', { port: env.PORT });
    if (!isPostgresConnected()) {
      logger.warn('Server started without database connection - some features may be unavailable');
    }
  });

  // Background recommendation maintenance (co-occurrence graph + taste decay).
  // Runs on a timer guarded by a Redis distributed lock so it executes on a
  // single instance per tick across the fleet.
  startRecommendationScheduler();

  // Periodic re-crawl of subscribed/popular RSS feeds (same lock-guarded timer
  // pattern; skipped when Redis is unavailable).
  startPodcastRefreshScheduler();

  // Consume durable HLS ingest jobs. Started at boot rather than on first upload
  // so a restart picks up work queued by an instance that is already gone.
  // No-ops when REDIS_URL is unset — ingest then runs in-process on the uploader.
  startIngestWorker();

  // Locker retention: warn at T-14d, hide at T0, delete bytes and document at
  // T+30d. Guarded by a session-scoped Postgres advisory lock (not Redis like
  // the two schedulers above) because this job deletes, and its mutual exclusion
  // must not depend on a second store that can be down while the deletes still
  // run. See `acquireSweepLock` in services/uploads/expirySweeper.ts.
  startExpirySweeper();

  // Drain the moderation outbox. Deliberately NOT lock-guarded like the two
  // schedulers above: every event is claimed under a Postgres lease with an owner
  // check, so N instances share the work and a dead instance's lease is reclaimed
  // rather than stranding a report. No-ops when the integration is disabled — the
  // loop is gated, never the durable record, so reports taken while it is off
  // deliver when it is switched on.
  //
  // Built here rather than at import: the integration reaches getDb(), and the
  // pool is opened by connectPostgres() above.
  // The four moderation tables must resolve before the first report is filed,
  // not at the first delivery hours later. A missing one raises 42P01 and names
  // itself here.
  await assertModerationSchema();
  getModerationIntegration().dispatcher.start();
};

if (require.main === module) {
  void bootServer();
}

export { io, musicNamespace };
export default server;
