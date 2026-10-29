const { authenticateAccessToken } = require('../security/session');
const presenceService = require('../services/presence.service');
/**
 * socket/index.js
 * Scalable Socket.IO Server initialization with Redis Pub/Sub adapter.
 *
 * Architecture Highlights:
 *   - Redis Adapter enables multi-node clustering (horizontal scale).
 *   - JWT Authentication during handshake rejects unauthorized sockets early.
 *   - Clean room abstraction for private and ticket-based messaging.
 */
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const Redis = require("ioredis");
const { redisConfig } = require("../config/redis");
const registerChatHandlers = require("./chat.socket");

let io = null;

/**
 * Initialize Socket.IO Server attached to Express HTTP Server.
 * @param {import('http').Server} httpServer
 */
const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      ...require('../config/cors'),
      methods: ["GET", "POST"],
    },
    transports: ["websocket", "polling"],
    pingTimeout: 20000,
    pingInterval: 25000,
  });

  // ─────────────────────────────────────────────
  // Scalable Redis Adapter (for horizontal multi-server scaling)
  // ─────────────────────────────────────────────
  if (process.env.ENABLE_REDIS === "true") {
    try {
      const pubClient = new Redis(redisConfig);
      const subClient = pubClient.duplicate();

      pubClient.on("error", (err) => console.warn("[Socket.IO Redis Pub] Warning:", err.message));
      subClient.on("error", (err) => console.warn("[Socket.IO Redis Sub] Warning:", err.message));

      io.adapter(createAdapter(pubClient, subClient));
      console.log("[Socket.IO] Redis Pub/Sub adapter connected 🚀");
    } catch (err) {
      console.warn("[Socket.IO] Redis adapter init failed, falling back to in-memory adapter:", err.message);
    }
  }

  // ─────────────────────────────────────────────
  // Handshake JWT Authentication Middleware
  // ─────────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      let token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization;

      if (typeof token === 'string' && token.toLowerCase().startsWith("bearer ")) {
        token = token.split(" ")[1];
      }

      if (!token) {
        return next(new Error("Authentication error: No token provided"));
      }

      socket.user = await authenticateAccessToken(token);
      socket.accessToken = token;
      next();
    } catch (err) {
      return next(new Error(`Authentication error: ${err.message}`));
    }
  });

  // ─────────────────────────────────────────────
  // Connection Handler
  // ─────────────────────────────────────────────
  io.on("connection", (socket) => {
    if (socket.user.role === 'ADMIN') socket.join(`admin-session:${socket.user.admin_session_id}`);
    socket.use(async (packet, next) => {
      try {
        Object.assign(socket.user, await authenticateAccessToken(socket.accessToken));
        await presenceService.refreshHeartbeat(String(socket.user._id));
        next();
      } catch { next(new Error('Session expired or revoked.')); socket.disconnect(true); }
    });
    const heartbeat = setInterval(async () => {
      try { await authenticateAccessToken(socket.accessToken); await presenceService.setUserOnline(String(socket.user._id), socket.id); }
      catch { socket.disconnect(true); }
    }, 60000);
    heartbeat.unref?.();
    socket.on('disconnect', () => clearInterval(heartbeat));
    registerChatHandlers(io, socket);
  });

  return io;
};

/**
 * Get active Socket.IO instance.
 * @returns {import('socket.io').Server}
 */
const getIO = () => {
  if (!io) {
    throw new Error("Socket.IO has not been initialized!");
  }
  return io;
};

module.exports = { initSocket, getIO };
