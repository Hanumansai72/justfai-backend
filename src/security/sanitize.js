/**
 * security/sanitize.js
 * Express 5 compatible input sanitization.
 * Operates in-place on req.body, req.query, and req.params while retaining sanitized query values.
 */
const xss = require("xss");
const credentialKeys = new Set(["password", "newPassword", "currentPassword", "oldPassword", "confirmPassword"]);

// Recursive in-place sanitizer to preserve Express 5 request getters
const sanitizeObjectInPlace = (target, options = {}) => {
  if (!target || typeof target !== "object") return target;

  for (const key of Object.keys(target)) {
    // 1. Mongo Operator Injection Check ($ and .)
    if (options.stripMongo && (key.startsWith("$") || key.includes("."))) {
      const cleanKey = key.replace(/^\$|\./g, "_");
      if (!['__proto__', 'constructor', 'prototype'].includes(cleanKey)) target[cleanKey] = sanitizeObjectInPlace(target[key], options);
      delete target[key];
      continue;
    }

    if (['__proto__', 'constructor', 'prototype'].includes(key)) { delete target[key]; continue; }
    const val = target[key];
    if (typeof val === "string") {
      if (options.stripXss && !credentialKeys.has(key)) {
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
      const query = sanitizeObjectInPlace(req.query, { stripMongo: true });
      Object.defineProperty(req, 'query', { value: query, configurable: true, writable: true, enumerable: true });
    }
    if (req.params && typeof req.params === "object") {
      sanitizeObjectInPlace(req.params, { stripMongo: true });
    }
  } catch (err) {
    return next(Object.assign(new Error("Invalid request payload"), { statusCode: 400 }));
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
    return next(Object.assign(new Error("Invalid request payload"), { statusCode: 400 }));
  }
  next();
};

const sanitizeParams = router => {
  const names = new Set(router.stack.flatMap(layer => {
    const paths = Array.isArray(layer.route?.path) ? layer.route.path : [layer.route?.path];
    return paths.filter(path => typeof path === 'string').flatMap(path => [...path.matchAll(/[:*]([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1]));
  }));
  for (const name of names) router.param(name, (req, res, next, value) => {
    const values = { value }; sanitizeObjectInPlace(values, { stripMongo: true, stripXss: true });
    req.params[name] = values.value; next();
  });
};
module.exports = { sanitizeMongo, sanitizeXss, sanitizeParams };
