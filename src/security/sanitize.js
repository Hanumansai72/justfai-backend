/**
 * security/sanitize.js
 * Two-layer input sanitisation applied globally before route handlers:
 *   1. express-mongo-sanitize  → strips MongoDB operator injection ($ and .)
 *   2. xss                     → recursively strips HTML/script from all strings
 */
const mongoSanitize = require("express-mongo-sanitize");
const xss = require("xss");

// Layer 1: MongoDB operator injection prevention
const sanitizeMongo = mongoSanitize({
  replaceWith: "_",
  onSanitize: ({ req, key }) => {
    console.warn(`[Security] Mongo injection blocked. Key: "${key}" from IP: ${req.ip}`);
  },
});

// Layer 2: Recursive XSS stripping on body and query strings
const sanitizeValue = (value) => {
  if (typeof value === "string") return xss(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = sanitizeValue(value[k]);
    return out;
  }
  return value;
};

const sanitizeXss = (req, res, next) => {
  if (req.body) req.body = sanitizeValue(req.body);
  if (req.query) req.query = sanitizeValue(req.query);
  next();
};

module.exports = { sanitizeMongo, sanitizeXss };
