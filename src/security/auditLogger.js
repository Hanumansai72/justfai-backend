/**
 * security/auditLogger.js
 * Persist audit records in the background, including on Vercel without a queue worker.
 */
const AuditLog = require("../models/AuditLog.model");
const { waitUntil } = require('@vercel/functions');
const { createHash } = require('crypto');
const safeRequestPath = require('../utils/safeRequestPath');

/** Extracts real client IP (handles proxies / load balancers) */
const getClientIp = (req) =>
  req.ip ||
  req.socket?.remoteAddress ||
  "unknown";

/**
 * log(options) — return the persistence task so callers can track completion.
 */
const log = ({
  category = "SYSTEM",
  action,
  status = "SUCCESS",
  resource_type = "System",
  resource_id = null,
  req = null,
  user_id = null,
  message = "",
  metadata = {},
} = {}) => {
  const actor = req?.auditActor || req?.user;
  const resolvedUserId = user_id ?? actor?._id ?? null;
  const isStaff = ['ADMIN', 'HELPER'].includes(actor?.role);
  const path = req ? safeRequestPath(req) : null;
  const source = path === '/api/admin' || path?.startsWith('/api/admin/') || isStaff ? 'admin' : 'customer';
  const token = req?.headers?.authorization?.replace(/^Bearer\s+/i, '') || req?.cookies?.accessToken;
  const sessionId = req?.auditSessionId || (isStaff && token ? createHash('sha256').update(token).digest('hex') : null);
  if (req) req.auditLogged = true;

  const task = AuditLog.create({
    category,
    action,
    status,
    resource_type,
    resource_id: resource_id ? String(resource_id) : null,
    user_id: resolvedUserId,
    ip_address: req ? getClientIp(req) : null,
    user_agent: req?.headers?.["user-agent"] || null,
    message,
    metadata: {
      ...metadata,
      ...(req && { source, method: req.method, path }),
      ...(sessionId && { session_id: sessionId }),
      ...(actor && { actor: { id: String(actor._id), name: actor.name, email: actor.email,
        role: actor.role, employee_id: actor.employee_id || null } }),
    },
  }).catch(error => {
    // Never print request bodies, credentials, or database connection strings.
    console.error('[Audit] PERSIST_FAILED', error.name || 'Error');
    return null;
  });
  waitUntil(task);
  return task;
};

module.exports = { log, getClientIp };
