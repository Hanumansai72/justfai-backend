/**
 * security/securityLogger.js
 * Express middleware that auto-logs security-relevant HTTP events after response.
 * Attaches a 'finish' listener so it never slows down the response path.
 *
 * Logs:
 *   - All responses on sensitive paths (login, pair, unlink, etc.)
 *   - All 4xx / 5xx responses
 *   - Everything when AUDIT_ALL_REQUESTS=true (dev/debug)
 */
const { log } = require("./auditLogger");

const SENSITIVE_PATHS = [
  "/api/users/login",
  "/api/users/register",
  "/api/users/google",
  "/api/users/refresh-token",
  "/api/users/logout",
  "/api/users/forgot-password",
  "/api/users/reset-password",
  "/api/devices/pair",
  "/api/devices/unlink",
  "/api/devices/request-unlink-otp",
  "/api/devices/check-pairing",
];

const isSensitive = (path) =>
  SENSITIVE_PATHS.some((s) => path.startsWith(s));

const securityLogger = (req, res, next) => {
  const startedAt = Date.now();

  res.on("finish", () => {
    const { statusCode } = res;
    const path = req.originalUrl;
    const duration = Date.now() - startedAt;
    const logAll = process.env.AUDIT_ALL_REQUESTS === "true";

    if (statusCode >= 400 || isSensitive(path) || logAll) {
      const category =
        statusCode === 429         ? "SECURITY"
        : path.includes("/devices") ? "DEVICE"
        : path.includes("/users")   ? "AUTH"
        : "SYSTEM";

      const status =
        statusCode >= 500 ? "FAILURE"
        : statusCode === 429 ? "BLOCKED"
        : statusCode >= 400 ? "FAILURE"
        : "SUCCESS";

      log({
        req,
        category,
        action: `HTTP_${req.method}_${statusCode}`,
        status,
        message: `${req.method} ${path} → ${statusCode} (${duration}ms)`,
        metadata: { method: req.method, path, statusCode, duration_ms: duration },
      });
    }
  });

  next();
};

module.exports = securityLogger;
