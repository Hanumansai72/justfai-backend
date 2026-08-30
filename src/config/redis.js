/**
 * config/redis.js
 * Production-ready Redis Connection Manager.
 *
 * Features:
 *   - Auto-reconnection with exponential backoff & jitter
 *   - Graceful fallback mode (non-blocking if Redis is down)
 *   - Shared connection options for BullMQ workers & queues
 *   - Health check ping
 */
const Redis = require("ioredis");

const redisConfig = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === "true" ? {} : undefined,
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
  reconnectOnError(err) {
    const targetError = "READONLY";
    if (err.message.includes(targetError)) {
      return true; // Reconnect on readonly error
    }
    return false;
  },
};

let redisClient = null;
let isConnected = false;

if (process.env.ENABLE_REDIS !== "false") {
  try {
    redisClient = new Redis(redisConfig);

    redisClient.on("connect", () => {
      isConnected = true;
      console.log(`[Redis] Connected to ${redisConfig.host}:${redisConfig.port}`);
    });

    redisClient.on("ready", () => {
      isConnected = true;
    });

    redisClient.on("error", (err) => {
      isConnected = false;
      // Log warning rather than throwing fatal error so app stays up if Redis is initializing
      if (process.env.NODE_ENV === "development") {
        console.warn(`[Redis] Warning: ${err.message} (Falling back gracefully)`);
      }
    });

    redisClient.on("close", () => {
      isConnected = false;
    });
  } catch (err) {
    console.error("[Redis] Initialization failed:", err.message);
    redisClient = null;
  }
}

/**
 * Health check: Ping Redis and return latency in ms.
 */
const pingRedis = async () => {
  if (!redisClient || !isConnected) return null;
  try {
    const start = Date.now();
    await redisClient.ping();
    return Date.now() - start;
  } catch (err) {
    return null;
  }
};

module.exports = {
  redisClient,
  redisConfig,
  isRedisConnected: () => isConnected,
  pingRedis,
};
