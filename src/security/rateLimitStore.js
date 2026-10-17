const { randomUUID } = require('node:crypto');

// One atomic command, Redis server time, bounded sets, expiry on every write.
const SLIDING_WINDOW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local reset = window
if #oldest > 0 then reset = math.max(1, tonumber(oldest[2]) + window - now) end
if count >= limit then return {0, 0, reset} end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], window)
return {1, limit - count - 1, reset}
`;

class RedisWindowStore {
  constructor(client, rest = false) { this.client = client; this.rest = rest; }
  async consume(key, policy) {
    const args = [policy.windowMs, policy.limit, randomUUID()];
    const result = this.rest
      ? await this.client.eval(SLIDING_WINDOW, [key], args)
      : await this.client.eval(SLIDING_WINDOW, 1, key, ...args);
    return { allowed: Number(result[0]) === 1, remaining: Number(result[1]), resetMs: Number(result[2]) };
  }
}

// Development/tests only. Production never silently substitutes per-process counters.
class MemoryWindowStore {
  constructor(clock = Date.now) { this.clock = clock; this.keys = new Map(); }
  async consume(key, policy) {
    const now = this.clock();
    if (!this.keys.has(key) && this.keys.size >= 10000) {
      for (const [id, entry] of this.keys) if (entry.expires <= now) this.keys.delete(id);
      if (this.keys.size >= 10000) throw new Error('Development limiter capacity reached');
    }
    const entries = (this.keys.get(key)?.times || []).filter(time => time > now - policy.windowMs);
    const allowed = entries.length < policy.limit;
    if (allowed) entries.push(now);
    this.keys.set(key, { times: entries, expires: now + policy.windowMs });
    return { allowed, remaining: Math.max(0, policy.limit - entries.length), resetMs: Math.max(1, entries[0] + policy.windowMs - now) };
  }
}

let store;
function getStore() {
  if (store) return store;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const { Redis } = require('@upstash/redis');
    store = new RedisWindowStore(new Redis({ url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN, retry: false,
      signal: () => AbortSignal.timeout(1500) }), true);
  } else if (process.env.ENABLE_REDIS === 'true' && process.env.REDIS_HOST) {
    const { redisClient } = require('../config/redis');
    store = new RedisWindowStore(redisClient.duplicate({ maxRetriesPerRequest: 0,
      enableOfflineQueue: false, connectTimeout: 1500, commandTimeout: 1500 }));
  } else if (process.env.NODE_ENV !== 'production') {
    console.warn('[rate-limit] Development memory store; counters are not distributed');
    store = new MemoryWindowStore();
  } else {
    throw new Error('Shared rate-limit Redis is not configured');
  }
  return store;
}
module.exports = { RedisWindowStore, MemoryWindowStore, getStore };
