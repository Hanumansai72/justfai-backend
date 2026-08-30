/**
 * security/auditLogger.js
 * Centralised audit logging utility — fire-and-forget, never blocks a request.
 */
const AuditLog = require("../models/AuditLog.model");
const { enqueueAuditLog } = require("../queues/audit.queue");

/** Extracts real client IP (handles proxies / load balancers) */
const getClientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
  req.headers["x-real-ip"] ||
  req.socket?.remoteAddress ||
  "unknown";

/**
 * log(options) — non-blocking message queue audit log dispatch.
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
  const resolvedUserId = user_id ?? req?.user?._id ?? null;

  enqueueAuditLog({
    category,
    action,
    status,
    resource_type,
    resource_id: resource_id ? String(resource_id) : null,
    user_id: resolvedUserId,
    ip_address: req ? getClientIp(req) : null,
    user_agent: req?.headers?.["user-agent"] || null,
    message,
    metadata,
  }).catch(() => {});
};

module.exports = { log, getClientIp };
