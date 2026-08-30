/**
 * security/rateLimiter.js
 * Tiered rate limiters keyed by endpoint sensitivity.
 * In a multi-instance deployment, swap the default memory store for a Redis store
 * (e.g. rate-limit-redis) to share counters across pods.
 */
const rateLimit = require("express-rate-limit");
const { log } = require("./auditLogger");

/** Factory: builds a rate-limiter that audit-logs every blocked request */
const createLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      log({
        req,
        category: "SECURITY",
        action: "RATE_LIMIT_HIT",
        status: "BLOCKED",
        message: `Rate limit exceeded: ${req.method} ${req.originalUrl}`,
        metadata: { url: req.originalUrl, method: req.method },
      });
      res.status(429).json({ success: false, message });
    },
  });

// 10 attempts per 15 min — login, register, Google OAuth
const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many authentication attempts. Please try again in 15 minutes.",
});

// 5 attempts per 10 min — device pair + check-pairing
const pairingLimiter = createLimiter({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: "Too many pairing attempts. Please try again in 10 minutes.",
});

// 3 requests per 5 min — OTP generation
const otpLimiter = createLimiter({
  windowMs: 5 * 60 * 1000,
  max: 3,
  message: "Too many OTP requests. Please wait 5 minutes before requesting again.",
});

// 5 attempts per 10 min — device unlink
const unlinkLimiter = createLimiter({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: "Too many unlink attempts. Please try again in 10 minutes.",
});

// 20 per min — firmware update recording
const firmwareLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: "Too many firmware update requests. Please slow down.",
});

// 100 per min — global fallback applied at app level
const generalLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 100,
  message: "Too many requests from this IP. Please slow down.",
});

module.exports = {
  authLimiter,
  pairingLimiter,
  otpLimiter,
  unlinkLimiter,
  firmwareLimiter,
  generalLimiter,
};
