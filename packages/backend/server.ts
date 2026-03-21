// --- Config ---
// CRITICAL: Load environment variables FIRST, before any other imports
// Use require() so it executes immediately, before ES6 imports are processed
// This ensures REDIS_URL and other env vars are available when modules are imported
require('dotenv').config();

// --- Imports ---
import express from "express";
import http from "http";
import mongoose from "mongoose";
import compression from "compression";
import { connectToDatabase, isDatabaseConnected } from "./src/utils/database";
import { Server as SocketIOServer, Socket, Namespace } from "socket.io";
import { logger } from "./src/utils/logger";

// Routers
import searchRoutes from "./src/routes/search";
import browseRoutes from "./src/routes/browse";
import { OxyServices } from '@oxyhq/core';
import testRoutes from "./src/routes/test";
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
import imagesRoutes from './src/routes/images.routes';

// Middleware
import { rateLimiter, bruteForceProtection } from "./src/middleware/security";

const app = express();

// Enable trust proxy for proper IP handling (required for rate limiting with IPv6)
// This ensures req.ip is properly set when behind a proxy/load balancer
app.set('trust proxy', true);

export const oxy = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });


// --- Middleware ---
// Response compression - compress responses > 1KB
app.use(compression({
  filter: (req, res) => {
    // Don't compress if client doesn't support it
    if (req.headers['x-no-compression']) {
      return false;
    }
    // Use compression filter function
    return compression.filter(req, res);
  },
  level: 6, // Compression level (0-9, 6 is a good balance)
  threshold: 1024, // Only compress responses > 1KB
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware to parse nested query parameters (e.g., filters[authors]=user1,user2)
app.use((req, res, next) => {
  if (req.query && typeof req.query === 'object') {
    const filters: any = {};
    Object.keys(req.query).forEach(key => {
      const match = key.match(/^filters\[(.+)\]$/);
      if (match) {
        const filterKey = match[1];
        if (!filters[filterKey]) {
          filters[filterKey] = req.query[key];
        }
      }
    });
    if (Object.keys(filters).length > 0) {
      (req.query as any).filters = filters;
    }
  }
  next();
});

app.use(async (req, res, next) => {
  // Try to ensure database connection, but don't block requests if it fails
  try {
    await connectToDatabase();
  } catch (error) {
    // Database unavailable - log once but allow request to continue
    // Individual operations will handle database errors gracefully
    logger.debug("MongoDB connection unavailable for request");
  }
  next();
});

// CORS and security headers
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || "https://syra.oxy.so",
  "https://syra.oxy.so",
  "http://localhost:8081",
  "http://localhost:8082",
  "http://192.168.86.44:8081",
] as const;

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin as typeof ALLOWED_ORIGINS[number])) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_URL || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

// --- Sockets ---
const server = http.createServer(app);

interface AuthenticatedSocket extends Socket {
  user?: { id: string; [key: string]: any };
}

type DisconnectReason =
  | "server disconnect" | "client disconnect" | "transport close" | "transport error" | "ping timeout" | "parse error" | "forced close" | "forced server close" | "server shutting down" | "client namespace disconnect" | "server namespace disconnect" | "unknown transport";

interface SocketError extends Error { description?: string; context?: any; }

const SOCKET_CONFIG = {
  PING_TIMEOUT: 60000,
  PING_INTERVAL: 20000, // Reduced from 25s to 20s for better connection management
  UPGRADE_TIMEOUT: 30000,
  CONNECT_TIMEOUT: 45000,
  MAX_BUFFER_SIZE: 1e8,
  COMPRESSION_THRESHOLD: 1024,
  CHUNK_SIZE: 10 * 1024,
  WINDOW_BITS: 14,
  COMPRESSION_LEVEL: 6,
} as const;

const io = new SocketIOServer(server, {
  transports: ["websocket", "polling"],
  path: "/socket.io",
  pingTimeout: SOCKET_CONFIG.PING_TIMEOUT,
  pingInterval: SOCKET_CONFIG.PING_INTERVAL,
  upgradeTimeout: SOCKET_CONFIG.UPGRADE_TIMEOUT,
  maxHttpBufferSize: SOCKET_CONFIG.MAX_BUFFER_SIZE,
  connectTimeout: SOCKET_CONFIG.CONNECT_TIMEOUT,
  cors: {
    origin: [process.env.FRONTEND_URL || "https://syra.oxy.so", "https://syra.oxy.so", "http://localhost:8081", "http://localhost:8082"],
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "X-Requested-With", "Accept", "Accept-Version", "Content-Length", "Content-MD5", "Date", "X-Api-Version"]
  },
  perMessageDeflate: {
    threshold: SOCKET_CONFIG.COMPRESSION_THRESHOLD,
    zlibInflateOptions: { chunkSize: SOCKET_CONFIG.CHUNK_SIZE, windowBits: SOCKET_CONFIG.WINDOW_BITS },
    zlibDeflateOptions: { chunkSize: SOCKET_CONFIG.CHUNK_SIZE, windowBits: SOCKET_CONFIG.WINDOW_BITS, level: SOCKET_CONFIG.COMPRESSION_LEVEL },
  },
});

// Setup Redis adapter for Socket.IO horizontal scaling
// Note: @socket.io/redis-adapter v8+ supports node-redis
(async () => {
  try {
    const { createRedisPubSub } = require('./src/utils/redis');
    const { createAdapter } = require('@socket.io/redis-adapter');
    const { ensureRedisConnected } = require('./src/utils/redisHelpers');
    const { publisher, subscriber } = createRedisPubSub();
    
    // Connect both clients with timeout to avoid hanging
    await Promise.race([
      Promise.all([
        publisher.connect(),
        subscriber.connect()
      ]),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Redis connection timeout')), 5000)
      )
    ]);
    
    // Verify both clients are actually ready before proceeding
    const publisherReady = await ensureRedisConnected(publisher);
    const subscriberReady = await ensureRedisConnected(subscriber);
    
    if (!publisherReady || !subscriberReady) {
      throw new Error('Redis clients connected but not ready');
    }
    
    // Verify with ping to ensure connection is actually working
    await Promise.all([
      publisher.ping(),
      subscriber.ping()
    ]);
    
    io.adapter(createAdapter(publisher, subscriber));
    logger.info('Socket.IO Redis adapter configured for horizontal scaling');
  } catch (error: any) {
    // If Redis is unavailable, continue without adapter (single-instance mode)
    const { isRedisConnectionError } = require('./src/utils/redisHelpers');
    if (isRedisConnectionError(error) || error.message?.includes('timeout') || error.message?.includes('not ready')) {
      logger.info('Redis unavailable - Socket.IO running in single-instance mode (no horizontal scaling)');
    } else {
      logger.warn('Failed to setup Socket.IO Redis adapter, running in single-instance mode:', error);
    }
  }
})();

const configureNamespaceErrorHandling = (namespace: Namespace) => {
  namespace.on("connection_error", (error: Error) => {
    logger.error(`Connection error in namespace ${namespace.name}`, error);
  });
  namespace.on("connect_error", (error: Error) => {
    logger.error(`Connect error in namespace ${namespace.name}`, error);
  });
  namespace.on("connect_timeout", () => {
    logger.warn(`Connection timeout in namespace ${namespace.name}`);
  });
};

// Music namespaces (for future real-time features)
const musicNamespace = io.of("/music");

// Player namespace for real-time playback sync
import { setupPlayerSocket } from './src/sockets/playerSocket';
const playerNamespace = setupPlayerSocket(io);

// Playlist namespace for real-time collaborative editing
import { setupPlaylistSocket } from './src/sockets/playlistSocket';
const playlistNamespace = setupPlaylistSocket(io);

// --- Socket Auth Middleware ---
// Lightweight auth: accept userId from client handshake and attach to socket
[musicNamespace, io].forEach((namespaceOrServer: any) => {
  // For namespaces we have .use; for main io server we also have .use
  if (namespaceOrServer && typeof namespaceOrServer.use === "function") {
    namespaceOrServer.use((socket: AuthenticatedSocket, next: (err?: any) => void) => {
      try {
        const auth = socket.handshake?.auth as any;
        const userId = auth?.userId || auth?.id || auth?.user?.id;
        if (userId && typeof userId === "string") {
          socket.user = { id: userId };
        }
      } catch (_) {
        // ignore – will be handled by connection handlers if user missing
      }
      return next();
    });
  }
});

// --- Socket Namespace Config ---

// Configure music namespace (for future real-time features like collaborative playlists)
musicNamespace.on("connection", (socket: AuthenticatedSocket) => {
  logger.info(`Client connected to music namespace from ip: ${socket.handshake.address}`);

  socket.on("error", (error: Error) => {
    logger.error("Music socket error", error);
  });

  socket.on("disconnect", (reason: DisconnectReason) => {
    logger.debug(`Client ${socket.id} disconnected from music namespace: ${reason}`);
  });
});

// Apply verification middleware to all namespaces
[
  musicNamespace,
  playerNamespace,
  playlistNamespace,
].forEach((namespace) => {
  configureNamespaceErrorHandling(namespace);
});

// Configure main namespace with enhanced error handling
io.on("connection", (socket: AuthenticatedSocket) => {
  logger.info(`Client connected from ip: ${socket.handshake.address}`);

  // Enhanced error handling
  socket.on("error", (error: Error) => {
    logger.error("Socket error", error);
    // Attempt to reconnect on error
    if (socket.connected) {
      socket.disconnect();
    }
  });

  socket.on("disconnect", (reason: DisconnectReason, description?: any) => {
    logger.debug(`Client disconnected: ${reason}${description ? ` - ${description}` : ""}`);
    // Handle specific disconnect reasons
    if (reason === "server disconnect") {
      // Reconnect if server initiated the disconnect
      socket.disconnect();
    }
    if (reason === "transport close" || reason === "transport error") {
      logger.debug("Transport issue detected, attempting reconnection...");
    }
  });

  socket.on("connect_error", (error: Error) => {
    logger.error("Connection error", error);
  });

  socket.on("reconnect_attempt", (attemptNumber: number) => {
    logger.debug(`Reconnection attempt ${attemptNumber}`);
  });

  socket.on("reconnect_error", (error: Error) => {
    logger.error("Reconnection error", error);
  });

  socket.on("reconnect_failed", () => {
    logger.error("Failed to reconnect");
  });

});

// Enhanced error handling for namespaces
[musicNamespace].forEach(
  (namespace: Namespace) => {
    namespace.on("connection_error", (error: Error) => {
      logger.error(`Namespace ${namespace.name} connection error`, error);
    });

    namespace.on("connect_error", (error: SocketError) => {
      logger.error(`${namespace.name}: Connect error`, error);
      // Log detailed error info
      if (error.description) {
        logger.error("Error description", error.description);
      }
      if (error.context) {
        logger.error("Error context", error.context);
      }
    });

    namespace.on("connect_timeout", () => {
      logger.warn(`${namespace.name}: Connect timeout`);
    });
  }
);

// --- Expose namespaces for use in routes ---
app.set("io", io);
// Expose io globally for utility modules that emit without direct access to req/app
// Using any-cast to avoid augmenting global types across the project
(global as any).io = io;
app.set("musicNamespace", musicNamespace);

// --- Optional Auth Middleware ---
// Tries to authenticate but doesn't fail if no token is provided
const optionalAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Check if Authorization header exists
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    // No auth header, continue as unauthenticated
    logger.debug("Optional auth: No authorization header, continuing as unauthenticated");
    return next();
  }
  
  // Try to authenticate if header exists
  const authMiddleware = oxy.auth();
  authMiddleware(req, res, (err?: any) => {
    if (err) {
      // Auth failed (invalid token, expired, etc.), but continue anyway
      logger.debug(`Optional auth: Authentication failed, continuing as unauthenticated: ${err?.message || "Unknown error"}`);
      // Clear any partial user data that might have been set
      (req as any).user = undefined;
    }
    // Always continue the request chain
    next();
  });
};

// --- API ROUTES ---
// Public API routes (no authentication required)
// Note: Viewing artists, songs, and albums is public. Streaming (audio) requires authentication.
// Using optionalAuth to allow requests with or without tokens - backend handles gracefully
const publicApiRouter = express.Router();
publicApiRouter.use("/tracks", optionalAuth, tracksRoutes); // GET routes - public viewing
publicApiRouter.use("/albums", optionalAuth, albumsRoutes); // GET routes - public viewing
publicApiRouter.use("/artists", optionalAuth, artistsRoutes); // GET routes - public viewing
publicApiRouter.use("/playlists", optionalAuth, playlistsRoutes); // GET /playlists/:id is public
publicApiRouter.use("/images", imagesRoutes); // GET /images/:id is public
publicApiRouter.use("/search", optionalAuth, searchRoutes);
publicApiRouter.use("/browse", optionalAuth, browseRoutes); // Browse/explore endpoints - public
publicApiRouter.use("/copyright", optionalAuth, copyrightRoutes); // Public copyright reporting

// Authenticated API routes (require authentication)
const authenticatedApiRouter = express.Router();
authenticatedApiRouter.use("/test", testRoutes);
authenticatedApiRouter.use("/profile", profileSettingsRoutes);
authenticatedApiRouter.use("/artists", artistsAuthRoutes); // Authenticated routes (GET /me, POST /register, POST /:id/follow, etc.)
authenticatedApiRouter.use("/playlists", playlistsRoutes); // POST routes (create)
authenticatedApiRouter.use("/images", imagesRoutes); // POST /images/upload requires authentication
authenticatedApiRouter.use("/library", libraryRoutes);
authenticatedApiRouter.use("/audio", audioRoutes); // Audio streaming requires authentication
authenticatedApiRouter.use("/queue", queueRoutes); // Queue management requires authentication
authenticatedApiRouter.use("/music", musicPreferencesRoutes); // Music preferences requires authentication
authenticatedApiRouter.use("/copyright", copyrightRoutes); // Admin copyright management

// Mount public and authenticated API routers
app.use("/api", publicApiRouter);
app.use("/api", oxy.auth(), authenticatedApiRouter);

// Performance monitoring middleware
import { performanceMiddleware } from "./src/middleware/performance";
app.use(performanceMiddleware);

// --- Root API Welcome Route ---
app.get("", async (req, res) => {
  res.json({ message: "Welcome to Syra API", version: "1.0.0" });
});

// --- Health Check Endpoint ---
app.get("/health", async (req, res) => {
  try {
    const { isDatabaseConnected, getDatabaseStats } = require("./src/utils/database");
    const { isRedisConnected, getRedisStats } = require("./src/utils/redis");
    const { getPerformanceStats } = require("./src/middleware/performance");

    const [dbConnected, redisConnected] = await Promise.all([
      isDatabaseConnected(),
      isRedisConnected(),
    ]);

    const dbStats = getDatabaseStats();
    const redisStats = getRedisStats();
    const perfStats = getPerformanceStats();

    const health = {
      status: dbConnected && redisConnected ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      services: {
        database: {
          connected: dbConnected,
          ...dbStats,
        },
        redis: {
          connected: redisConnected,
          ...redisStats,
        },
      },
      performance: perfStats,
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      uptime: Math.round(process.uptime()),
    };

    const statusCode = health.status === "healthy" ? 200 : 503;
    res.status(statusCode).json(health);
  } catch (error) {
    logger.error("Health check failed:", error);
    res.status(503).json({
      status: "unhealthy",
      error: error instanceof Error ? error.message : "Unknown error",
      timestamp: new Date().toISOString(),
    });
  }
});

// --- Error Handler Middleware ---
// This must be last, after all routes
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('[ErrorHandler] Unhandled error:', {
    message: err.message,
    stack: err.stack,
    statusCode: err.statusCode || err.status,
    path: req.path,
    method: req.method,
  });

  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || 'Internal Server Error';

  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// --- MongoDB Connection ---
const db = mongoose.connection;
let hasLoggedMongoError = false;
db.on("error", (error: any) => {
  // Only log connection errors once to reduce spam
  if (error.code === 'ECONNREFUSED' || error.syscall === 'querySrv') {
    // Connection errors are already logged by connectToDatabase retry logic
    // Don't log them again here to avoid duplicate messages
    if (!hasLoggedMongoError) {
      hasLoggedMongoError = true;
      logger.debug("MongoDB connection error:", error.message);
    }
  } else {
    logger.error("MongoDB connection error", error);
  }
});

// Reset error flag on successful connection
db.once("open", () => {
  hasLoggedMongoError = false;
  logger.info("Connected to MongoDB successfully");
  // Music models will be loaded here when created
});

// --- Server Listen ---
const PORT = parseInt(String(process.env.PORT || 3000), 10);
const bootServer = async () => {
  // Try to connect to database, but don't crash if it fails
  try {
    await connectToDatabase();
  } catch (error: any) {
    // Database connection failed, but allow server to start anyway
    // Operations will fail gracefully when database is unavailable
    logger.warn("MongoDB connection unavailable - server will start but database operations will fail");
  }
  
  // Start server regardless of database connection status
  server.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running on port ${PORT}`);
    if (!isDatabaseConnected()) {
      logger.warn("⚠️  Server started without database connection - some features may be unavailable");
    }
  });
};

if (require.main === module) {
  void bootServer();
}

export { io, musicNamespace };
export default server;
