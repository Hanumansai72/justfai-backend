/**
 * services/cache.service.js
 * High-performance Cache-Aside Redis Caching Service.
 *
 * Implements:
 *   - Transparent JSON Serialization & Deserialization
 *   - Pattern-based wildcard invalidation (e.g. delPattern("devices:*"))
 *   - Atomic Cache-Aside (getOrSet) pattern
 *   - Seamless bypass if Redis is offline
 */
const { redisClient } = require("../config/redis");

const DEFAULT_TTL_SECONDS = 300; // 5 minutes default

class CacheService {
  constructor() {
    // HTTP caching must not inherit BullMQ's unlimited command retries.
    this.client = redisClient?.duplicate({ maxRetriesPerRequest: 0,
      enableOfflineQueue: false, connectTimeout: 750, commandTimeout: 750 });
    this.pending = new Map();
    this.lastWarning = 0;
    this.client?.on('error', () => this.warn());
  }

  warn() {
    if (Date.now() - this.lastWarning > 30000) {
      console.warn('[Cache] Redis unavailable; bypassing cache.');
      this.lastWarning = Date.now();
    }
  }
  /**
   * Get value by key.
   * @param {string} key
   * @returns {Promise<any|null>}
   */
  async get(key) {
    if (this.client?.status !== 'ready') return null;
    try {
      const data = await this.client.get(key);
      if (!data) return null;
      return JSON.parse(data);
    } catch (err) {
      this.warn();
      return null;
    }
  }

  /**
   * Set value by key with TTL.
   * @param {string} key
   * @param {any} value
   * @param {number} [ttlSeconds]
   */
  async set(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
    if (this.client?.status !== 'ready') return false;
    try {
      const payload = JSON.stringify(value);
      if (ttlSeconds > 0) {
        await this.client.set(key, payload, "EX", ttlSeconds);
      } else {
        await this.client.set(key, payload);
      }
      return true;
    } catch (err) {
      this.warn();
      return false;
    }
  }

  /**
   * Delete key from cache.
   * @param {string} key
   */
  async del(key) {
    if (this.client?.status !== 'ready') return false;
    try {
      await this.client.del(key);
      return true;
    } catch (err) {
      this.warn();
      return false;
    }
  }

  /**
   * Delete all keys matching a wildcard pattern (e.g. "devices:*").
   * Uses SCAN instead of KEYS to prevent blocking the Redis event loop.
   * @param {string} pattern
   */
  async delPattern(pattern) {
    if (this.client?.status !== 'ready') return 0;
    try {
      let cursor = "0";
      let count = 0;
      do {
        const [nextCursor, keys] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await this.client.del(...keys);
          count += keys.length;
        }
      } while (cursor !== "0");
      return count;
    } catch (err) {
      this.warn();
      return 0;
    }
  }

  /**
   * Cache-Aside helper: Returns cached data if present, otherwise calls fetchFn(),
   * caches the result, and returns it.
   * @param {string} key
   * @param {Function} fetchFn
   * @param {number} [ttlSeconds]
   */
  async getOrSet(key, fetchFn, ttlSeconds = DEFAULT_TTL_SECONDS) {
    const cached = await this.get(key);
    if (cached !== null) {
      return cached;
    }

    if (this.pending.has(key)) return this.pending.get(key);
    // Coalesce concurrent cache misses without changing the data or its TTL.
    const pending = Promise.resolve().then(fetchFn).then(async freshData => {
      if (freshData !== null && freshData !== undefined) await this.set(key, freshData, ttlSeconds);
      return freshData;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }
}

module.exports = new CacheService();
