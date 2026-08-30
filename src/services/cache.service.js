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
const { redisClient, isRedisConnected } = require("../config/redis");

const DEFAULT_TTL_SECONDS = 300; // 5 minutes default

class CacheService {
  /**
   * Get value by key.
   * @param {string} key
   * @returns {Promise<any|null>}
   */
  async get(key) {
    if (!redisClient || !isRedisConnected()) return null;
    try {
      const data = await redisClient.get(key);
      if (!data) return null;
      return JSON.parse(data);
    } catch (err) {
      console.warn(`[Cache] GET error for key "${key}":`, err.message);
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
    if (!redisClient || !isRedisConnected()) return false;
    try {
      const payload = JSON.stringify(value);
      if (ttlSeconds > 0) {
        await redisClient.set(key, payload, "EX", ttlSeconds);
      } else {
        await redisClient.set(key, payload);
      }
      return true;
    } catch (err) {
      console.warn(`[Cache] SET error for key "${key}":`, err.message);
      return false;
    }
  }

  /**
   * Delete key from cache.
   * @param {string} key
   */
  async del(key) {
    if (!redisClient || !isRedisConnected()) return false;
    try {
      await redisClient.del(key);
      return true;
    } catch (err) {
      console.warn(`[Cache] DEL error for key "${key}":`, err.message);
      return false;
    }
  }

  /**
   * Delete all keys matching a wildcard pattern (e.g. "devices:*").
   * Uses SCAN instead of KEYS to prevent blocking the Redis event loop.
   * @param {string} pattern
   */
  async delPattern(pattern) {
    if (!redisClient || !isRedisConnected()) return 0;
    try {
      let cursor = "0";
      let count = 0;
      do {
        const [nextCursor, keys] = await redisClient.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await redisClient.del(...keys);
          count += keys.length;
        }
      } while (cursor !== "0");
      return count;
    } catch (err) {
      console.warn(`[Cache] DEL_PATTERN error for "${pattern}":`, err.message);
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

    // Cache miss: execute fetch
    const freshData = await fetchFn();
    if (freshData !== null && freshData !== undefined) {
      await this.set(key, freshData, ttlSeconds);
    }
    return freshData;
  }
}

module.exports = new CacheService();
