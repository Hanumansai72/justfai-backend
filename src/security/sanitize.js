/**
 * security/sanitize.js
 * Express 5 compatible input sanitization.
 * Operates in-place on req.body, req.query, and req.params without replacing property getters.
 */
const xss = require("xss");

// Recursive in-place sanitizer to preserve Express 5 request getters
const sanitizeObjectInPlace = (target, options = {}) => {
  if (!target || typeof target !== "object") return target;

  for (const key of Object.keys(target)) {
    // 1. Mongo Operator Injection Check ($ and .)
    if (options.stripMongo && (key.startsWith("$") || key.includes("."))) {
      const cleanKey = key.replace(/^\$|\./g, "_");
      target[cleanKey] = sanitizeObjectInPlace(target[key], options);
      delete target[key];
      continue;
    }

    const val = target[key];
    if (typeof val === "string") {
      if (options.stripXss) {
        target[key] = xss(val);
      }
    } else if (Array.isArray(val)) {
      target[key] = val.map((item) =>
        typeof item === "object"
          ? sanitizeObjectInPlace(item, options)
          : (typeof item === "string" && options.stripXss ? xss(item) : item)
      );
    } else if (val !== null && typeof val === "object") {
      sanitizeObjectInPlace(val, options);
    }
  }
  return target;
};

// Layer 1: MongoDB operator injection prevention (in-place)
const sanitizeMongo = (req, res, next) => {
  try {
    if (req.body && typeof req.body === "object") {
      sanitizeObjectInPlace(req.body, { stripMongo: true });
    }
    if (req.query && typeof req.query === "object") {
      sanitizeObjectInPlace(req.query, { stripMongo: true });
    }
    if (req.params && typeof req.params === "object") {
      sanitizeObjectInPlace(req.params, { stripMongo: true });
    }
  } catch (err) {
    console.warn("[Sanitize:Mongo] Error during sanitization:", err.message);
  }
  next();
};

// Layer 2: XSS prevention (in-place)
const sanitizeXss = (req, res, next) => {
  try {
    if (req.body && typeof req.body === "object") {
      sanitizeObjectInPlace(req.body, { stripXss: true });
    }
    if (req.query && typeof req.query === "object") {
      sanitizeObjectInPlace(req.query, { stripXss: true });
    }
    if (req.params && typeof req.params === "object") {
      sanitizeObjectInPlace(req.params, { stripXss: true });
    }
  } catch (err) {
    console.warn("[Sanitize:XSS] Error during sanitization:", err.message);
  }
  next();
};

module.exports = { sanitizeMongo, sanitizeXss };
