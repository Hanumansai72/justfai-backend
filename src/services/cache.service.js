const { redisClient } = require('../config/redis');
const { createHash, randomUUID } = require('crypto');

const DEFAULT_TTL_SECONDS = 30;
// The revision check and cache access are atomic. Keys share a Redis Cluster slot.
const READ = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return nil end
return redis.call('GET', KEYS[2])`;
const WRITE = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3]); return 1`;

class CacheService {
  constructor() {
    // Cache requests must not inherit BullMQ's unlimited retries.
    this.client = redisClient?.duplicate({ maxRetriesPerRequest: 0,
      enableOfflineQueue: false, connectTimeout: 750, commandTimeout: 750 });
    this.pending = new Map();
    this.dirty = new Map();
    this.lastWarning = 0;
    this.client?.on('error', () => this.warn());
  }

  warn() {
    if (Date.now() - this.lastWarning > 30000) {
      console.warn('[Cache] Redis unavailable; using MongoDB directly.');
      this.lastWarning = Date.now();
    }
  }

  prefix(group) { return `justride:cache:v2:{${group}}`; }

  async readyForInvalidation() {
    if (this.client?.status === 'ready') return true;
    if (!['connecting', 'connect'].includes(this.client?.status)) return false;
    // A cold-start write gives the cache connection a bounded chance to become ready.
    return new Promise(resolve => {
      const finish = ready => {
        clearTimeout(timer);
        this.client.off('ready', connected);
        this.client.off('error', failed);
        resolve(ready);
      };
      const connected = () => finish(true);
      const failed = () => finish(false);
      const timer = setTimeout(failed, 750);
      this.client.once('ready', connected);
      this.client.once('error', failed);
    });
  }

  async read(group, key) {
    if (this.client?.status !== 'ready') return null;
    // Retry a failed invalidation before using cached values on this instance.
    if (this.dirty.has(group) && !await this.invalidate([group])) return null;
    try {
      const revisionKey = `${this.prefix(group)}:revision`;
      let revision = await this.client.get(revisionKey);
      if (!revision) {
        // A random revision prevents old entries becoming visible after eviction.
        await this.client.set(revisionKey, randomUUID(), 'NX');
        revision = await this.client.get(revisionKey);
        if (!revision) return null;
      }
      const hash = createHash('sha256').update(key).digest('hex');
      const cacheKey = `${this.prefix(group)}:${revision}:${hash}`;
      const raw = await this.client.eval(READ, 2, revisionKey, cacheKey, revision);
      return { group, revisionKey, cacheKey, revision, value: raw === null ? null : JSON.parse(raw) };
    } catch {
      this.warn();
      return null;
    }
  }

  async write(snapshot, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
    if (!snapshot || this.dirty.has(snapshot.group) || this.client?.status !== 'ready') return false;
    try {
      // An older in-flight database read cannot repopulate an invalidated cache.
      return await this.client.eval(WRITE, 2, snapshot.revisionKey, snapshot.cacheKey,
        snapshot.revision, JSON.stringify(value), ttlSeconds) === 1;
    } catch {
      this.warn();
      return false;
    }
  }

  async invalidate(groups) {
    const revisions = [...new Set(groups)].map(group => [group, randomUUID()]);
    for (const [group, revision] of revisions) this.dirty.set(group, revision);
    if (!await this.readyForInvalidation()) return false;
    try {
      await Promise.all(revisions.map(async ([group, revision]) => {
        await this.client.set(`${this.prefix(group)}:revision`, revision);
        if (this.dirty.get(group) === revision) this.dirty.delete(group);
      }));
      return true;
    } catch {
      this.warn();
      return false;
    }
  }

  async getOrSet(group, key, fetchFn, ttlSeconds = DEFAULT_TTL_SECONDS) {
    const snapshot = await this.read(group, key);
    if (snapshot?.value !== null && snapshot?.value !== undefined) return snapshot.value;
    if (!snapshot) return fetchFn();
    if (this.pending.has(snapshot.cacheKey)) return this.pending.get(snapshot.cacheKey);
    const pending = Promise.resolve().then(fetchFn).then(async value => {
      if (value !== null && value !== undefined) await this.write(snapshot, value, ttlSeconds);
      return value;
    }).finally(() => this.pending.delete(snapshot.cacheKey));
    this.pending.set(snapshot.cacheKey, pending);
    return pending;
  }
}

module.exports = new CacheService();
