const { createHash } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { ipKeyGenerator } = require('express-rate-limit');
const policies = require('./rateLimitPolicies');
const { getStore } = require('./rateLimitStore');
const metrics = { allowed: 0, blocked: 0, degraded: 0, unavailable: 0 };
let lastWarning = 0;
const hash = value => createHash('sha256').update(value).digest('hex');
function identity(req, scope) {
  const ip = ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown');
  if (scope === 'ip') return ip;
  if (scope === 'accountIp') {
    const fields = req.path === '/login' && req.baseUrl === '/api/admin'
      ? ['username', 'email', 'employee_id', 'identifier'] : ['email', 'username', 'employee_id', 'identifier'];
    const raw = fields.map(field => req.body?.[field]).find(Boolean);
    return ip + ':' + (typeof raw === 'string' ? raw.trim().toLowerCase() : 'unknown');
  }
  if (scope === 'session') {
    const token = req.cookies?.refreshToken || req.body?.refreshToken;
    try {
      const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
      // Rotation changes jti; keep the quota stable across refreshes for this account.
      if (decoded.id && decoded.jti) return 'session-user:' + decoded.id;
    } catch { /* Invalid refresh credentials share the IP quota, never an arbitrary token key. */ }
    return ip;
  }
  if (!req.user?._id) throw new Error('Authenticated rate limiter must follow protect');
  return 'user:' + req.user._id;
}
function createLimiter(name, options = {}) {
  const policy = policies[name];
  if (!policy) throw new Error('Unknown rate-limit policy: ' + name);
  return async (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    let key;
    try { key = 'rl:v1:' + name + ':' + hash(identity(req, policy.scope)); }
    catch (error) { return next(error); }
    try {
      const result = await (options.store || getStore()).consume(key, policy);
      const retryAfter = Math.max(1, Math.ceil(result.resetMs / 1000));
      res.setHeader('RateLimit-Limit', policy.limit);
      res.setHeader('RateLimit-Remaining', result.remaining);
      res.setHeader('RateLimit-Reset', retryAfter);
      res.setHeader('RateLimit-Policy', policy.limit + ';w=' + policy.windowMs / 1000);
      if (result.allowed) { metrics.allowed++; return next(); }
      metrics.blocked++;
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({ success: false, code: 'RATE_LIMITED',
        message: 'Too many requests. Please try again in ' + retryAfter + ' seconds.', retryAfter });
    } catch {
      if (Date.now() - lastWarning > 30000) {
        console.warn('[rate-limit] Shared store unavailable'); lastWarning = Date.now();
      }
      if (policy.outage === 'open') { metrics.degraded++; return next(); }
      metrics.unavailable++;
      res.setHeader('Retry-After', 5);
      return res.status(503).json({ success: false, code: 'RATE_LIMIT_UNAVAILABLE',
        message: 'Please try again in a few seconds.', retryAfter: 5 });
    }
  };
}
const middleware = Object.fromEntries(Object.keys(policies).map(name => [name + 'Limiter', createLimiter(name)]));
const choose = (read, write) => (req, res, next) => (req.method === 'GET' ? middleware[read] : middleware[write])(req, res, next);
module.exports = { ...middleware, createLimiter, identity, metrics,
  staffLimiter: choose('adminReadLimiter', 'adminWriteLimiter'),
  userLimiter: choose('userReadLimiter', 'userWriteLimiter'),
  generalLimiter: middleware.globalLimiter,
  // Existing names retained for integrations that import these middleware functions.
  authLimiter: middleware.loginLimiter, otpLimiter: middleware.otpSendLimiter,
  unlinkLimiter: middleware.otpVerifyLimiter, firmwareLimiter: middleware.firmwareRecordLimiter,
};
