/**
 * security/securityLogger.js
 * Express middleware that auto-logs security-relevant HTTP events after response.
 * Attaches a 'finish' listener so it never slows down the response path.
 *
 * Logs:
 *   - All admin API requests and staff reads of interested users
 *   - All responses on sensitive paths (login, pair, unlink, etc.)
 *   - All 4xx / 5xx responses
 *   - Everything when AUDIT_ALL_REQUESTS=true (dev/debug)
 */
const { log } = require("./auditLogger");
const { waitUntil } = require('@vercel/functions');
const safeRequestPath = require('../utils/safeRequestPath');

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

  // Register before responding so serverless keeps the completion task alive.
  const task = new Promise(resolve => {
    res.once('finish', resolve);
    res.once('close', resolve);
  }).then(() => {
    // Controllers may already record a more specific event for this request.
    if (req.auditLogged) return;
    const { statusCode } = res;
    const path = safeRequestPath(req);
    const duration = Date.now() - startedAt;
    const logAll = process.env.AUDIT_ALL_REQUESTS === "true";
    const adminRequest = path === '/api/admin' || path.startsWith('/api/admin/') ||
      (path === '/api/early-interest' && ['ADMIN', 'HELPER'].includes(req.user?.role));

    if (adminRequest || statusCode >= 400 || isSensitive(path) || logAll) {
      const category =
        adminRequest              ? "ADMIN"
        : statusCode === 429         ? "SECURITY"
        : path.includes("/devices") ? "DEVICE"
        : path.includes("/users")   ? "AUTH"
        : "SYSTEM";

      const status =
        !res.writableFinished ? 'WARNING'
        : statusCode >= 500 ? "FAILURE"
        : statusCode === 403 ? 'BLOCKED'
        : statusCode === 429 ? "BLOCKED"
        : statusCode >= 400 ? "FAILURE"
        : "SUCCESS";

      const route = path === '/api/early-interest' ? 'INTERESTED_USERS' :
        String(req.route?.path || path.replace(/^\/api\/admin\/?/, '')).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase();
      const section = path.split('/')[3];
      const resourceType = { users: 'User', helpers: 'Helper', devices: 'Device',
        firmware: 'Firmware', 'app-releases': 'AppRelease' }[section] || 'System';
      return log({
        req,
        category,
        action: adminRequest ? `ADMIN_${req.method}_${route || 'ROOT'}` : `HTTP_${req.method}_${statusCode}`,
        status,
        resource_type: adminRequest ? resourceType : 'System',
        resource_id: req.params?.id || null,
        message: `${req.method} ${path} → ${statusCode} (${duration}ms)`,
        metadata: { method: req.method, path, statusCode, duration_ms: duration, completed: Boolean(res.writableFinished) },
      });
    }
  }).catch(error => console.error('[Audit] REQUEST_LOG_FAILED', error.name || 'Error'));
  waitUntil(task);

  next();
};

module.exports = securityLogger;
