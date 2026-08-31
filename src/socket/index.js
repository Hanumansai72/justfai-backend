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
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Helper = require("../models/Helper.model");
const { redisConfig } = require("../config/redis");
const registerChatHandlers = require("./chat.socket");

let io = null;

/**
 * Initialize Socket.IO Server attached to Express HTTP Server.
 * @param {import('http').Server} httpServer
 */
const initSocket = (httpServer) => {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : ["http://localhost:3000", "http://localhost:5173", "http://localhost:8080"];

  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (
          process.env.NODE_ENV !== "production" &&
          /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
        ) {
          return callback(null, true);
        }
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error(`Socket CORS: Origin '${origin}' is not allowed`));
      },
      methods: ["GET", "POST"],
      credentials: true,
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
        socket.handshake.headers?.authorization ||
        socket.handshake.query?.token;

      if (token && token.toLowerCase().startsWith("bearer ")) {
        token = token.split(" ")[1];
      }

      if (!token) {
        return next(new Error("Authentication error: No token provided"));
      }

      // Verify JWT
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (!decoded || !decoded.id) {
        return next(new Error("Authentication error: Invalid token"));
      }

      // Fetch user from DB
      let user = await User.findById(decoded.id).select("name email role status avatar").lean();
      if (!user) {
        user = await Helper.findById(decoded.id).select("name email role status avatar").lean();
      }

      if (!user) {
        return next(new Error("Authentication error: User account not found"));
      }

      if (user.status && user.status !== "active") {
        return next(new Error(`Authentication error: Account is ${user.status}`));
      }

      // Attach user payload to socket
      socket.user = user;
      next();
    } catch (err) {
      return next(new Error(`Authentication error: ${err.message}`));
    }
  });

  // ─────────────────────────────────────────────
  // Connection Handler
  // ─────────────────────────────────────────────
  io.on("connection", (socket) => {
    // Register chat event listeners
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
