import { env } from './src/config/env';

import express from 'express';
import http from 'http';
import mongoose from 'mongoose';
import compression from 'compression';
import cors from 'cors';
import { Server as SocketIOServer, Socket, Namespace } from 'socket.io';
import { createOptionalOxyAuth, createOxyRateLimit } from '@oxyhq/core/server';
import { oxy } from './src/oxyClient';

import { connectToDatabase, isDatabaseConnected, getDatabaseStats } from './src/utils/database';
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
import musicPreferencesRoutes from './src/routes/musicPreferences.routes';
import copyrightRoutes from './src/routes/copyright.routes';
import imagesPublicRoutes from './src/routes/images.public.routes';
import imagesAuthRoutes from './src/routes/images.auth.routes';
import streamRoutes from './src/routes/stream.routes';
import lyricsRoutes from './src/routes/lyrics.routes';
import sourcesRoutes from './src/routes/sources.routes';
import recommendationsRoutes from './src/routes/recommendations.routes';
import podcastsRoutes from './src/routes/podcasts.routes';
import episodesRoutes from './src/routes/episodes.routes';
import entityProfileRoutes from './src/routes/entityProfile.routes';
import { startRecommendationScheduler } from './src/services/recommendations/scheduler';
import { startPodcastRefreshScheduler } from './src/services/podcasts/podcastRefreshScheduler';

const app = express();

app.set('trust proxy', true);

const ALLOWED_ORIGINS: string[] = [
  env.FRONTEND_URL,
  'https://syra.fm',
  'http://localhost:8081',
  'http://localhost:8082',
  ...env.ALLOWED_ORIGINS,
];

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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Requested-With', 'Accept', 'Accept-Version', 'Content-Length', 'Content-MD5', 'Date', 'X-Api-Version'],
}));

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

app.use(async (_req, _res, next) => {
  try {
    await connectToDatabase();
  } catch {
    logger.debug('MongoDB connection unavailable for request');
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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Requested-With', 'Accept', 'Accept-Version', 'Content-Length', 'Content-MD5', 'Date', 'X-Api-Version'],
  },
  perMessageDeflate: {
    threshold: SOCKET_CONFIG.COMPRESSION_THRESHOLD,
    zlibInflateOptions: { chunkSize: SOCKET_CONFIG.CHUNK_SIZE, windowBits: SOCKET_CONFIG.WINDOW_BITS },
    zlibDeflateOptions: { chunkSize: SOCKET_CONFIG.CHUNK_SIZE, windowBits: SOCKET_CONFIG.WINDOW_BITS, level: SOCKET_CONFIG.COMPRESSION_LEVEL },
  },
});

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

[musicNamespace, io].forEach((ns) => {
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

[musicNamespace, playerNamespace, playlistNamespace].forEach((namespace) => {
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
publicApiRouter.use('/copyright', copyrightRoutes);
publicApiRouter.use('/stream', createOptionalOxyAuth(oxy), streamRoutes);
publicApiRouter.use('/images', imagesPublicRoutes);

publicApiRouter.use('/sources', sourcesRoutes);

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
authenticatedApiRouter.use('/copyright', copyrightRoutes);
authenticatedApiRouter.use('/recommendations', recommendationsRoutes);

app.use('/api', publicApiRouter);
app.use('/api', oxy.auth(), authenticatedApiRouter);

app.use(performanceMiddleware);

app.get('', async (_req, res) => {
  res.json({ message: 'Welcome to Syra API', version: '1.0.0' });
});

app.get('/health', async (_req, res) => {
  try {
    const [dbConnected, redisConnected] = await Promise.all([
      isDatabaseConnected(),
      isRedisConnected(),
    ]);

    const dbStats = getDatabaseStats();
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

const db = mongoose.connection;
let hasLoggedMongoError = false;
db.on('error', (error: Error & { code?: string; syscall?: string }) => {
  if (error.code === 'ECONNREFUSED' || error.syscall === 'querySrv') {
    if (!hasLoggedMongoError) {
      hasLoggedMongoError = true;
      logger.debug('MongoDB connection error', { err: error });
    }
  } else {
    logger.error('MongoDB connection error', { err: error });
  }
});

db.once('open', () => {
  hasLoggedMongoError = false;
  logger.info('Connected to MongoDB successfully');
});

const bootServer = async () => {
  try {
    await connectToDatabase();
  } catch {
    logger.warn('MongoDB connection unavailable - server will start but database operations will fail');
  }

  server.listen(env.PORT, '0.0.0.0', () => {
    logger.info('Server running', { port: env.PORT });
    if (!isDatabaseConnected()) {
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
};

if (require.main === module) {
  void bootServer();
}

export { io, musicNamespace };
export default server;
