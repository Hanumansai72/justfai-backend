/**
 * controllers/admin/audit.controller.js
 * Admin & Security Audit Trail Management Suite.
 *
 * Optimisation notes:
 *   - getAuditLogs: Uses compound indexes on (category, status, createdAt) and user_id.
 *   - getAuditStats: Runs aggregated 24h counters in parallel Promise.all().
 *   - getUserAuditLogs: Fetches indexed user-specific audit records with projection.
 */
const AuditLog = require("../../models/AuditLog.model");
const User     = require("../../models/User");
const Helper   = require('../../models/Helper.model');

// Include older admin records as well as the explicit source stored on new records.
const adminScope = () => ({ $or: [
  { 'metadata.source': 'admin' }, { category: 'ADMIN' },
  { category: 'FIRMWARE', action: /^FIRMWARE_RELEASE_/ },
  { category: 'SYSTEM', action: /^APP_RELEASE_/ },
] });

const actorFields = (log) => {
  // Snapshots retain staff identity after account changes/deletion and support Helpers.
  const actor = log.metadata?.actor || log.user_id;
  return {
    actor: actor?.name || actor?.email || 'System / Guest',
    actorEmail: actor?.email || null,
    actorId: String(actor?.id || actor?._id || 'SYS-001'),
    actorRole: actor?.role || 'SYSTEM',
    actorType: actor?.role?.toLowerCase() || 'system',
    employeeId: actor?.employee_id || null,
    sessionId: log.metadata?.session_id || null,
  };
};

// ─────────────────────────────────────────────
// @desc    List audit logs with multi-field search & filters
// @route   GET /api/admin/audit-logs
// @access  Private (ADMIN or HELPER)
// ─────────────────────────────────────────────
exports.getAuditLogs = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
    const skip  = (page - 1) * limit;

    const filter = req.query.scope === 'admin' ? { $and: [adminScope()] } : {};

    // Severity / Status filter (Critical/High maps to FAILURE/BLOCKED/WARNING)
    if (req.query.severity && req.query.severity !== "All Severities") {
      const sev = req.query.severity.toUpperCase();
      if (sev === "CRITICAL" || sev === "BLOCKED") {
        filter.status = "BLOCKED";
      } else if (sev === "HIGH" || sev === "FAILURE") {
        filter.status = "FAILURE";
      } else if (sev === "MEDIUM" || sev === "WARNING") {
        filter.status = "WARNING";
      } else if (sev === "LOW" || sev === "SUCCESS") {
        filter.status = "SUCCESS";
      }
    }

    // Module / Category filter
    if (req.query.module && req.query.module !== "All Modules") {
      const moduleFilters = {
        users: { $or: [{ category: 'AUTH' }, { resource_type: { $in: ['User', 'Helper'] } }] },
        devices: { $or: [{ category: 'DEVICE' }, { resource_type: 'Device' }] },
        firmware: { $or: [{ category: 'FIRMWARE' }, { resource_type: 'Firmware' }] },
        'app-releases': { resource_type: 'AppRelease' },
        support: { action: /^(SUPPORT_|ADMIN_(GET|POST|PATCH)_SUPPORT)/ },
      };
      const module = String(req.query.module).toLowerCase();
      (filter.$and ||= []).push(moduleFilters[module] || { category: module.toUpperCase() });
    }

    // Time window filter
    if (req.query.time_range) {
      const now = new Date();
      if (req.query.time_range === "Last 24 Hours") {
        filter.createdAt = { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) };
      } else if (req.query.time_range === "Last 7 Days") {
        filter.createdAt = { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) };
      } else if (req.query.time_range === "Last 30 Days") {
        filter.createdAt = { $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) };
      }
    }

    // Keyword / Text search across action, message, resource_id, and ip_address
    if (req.query.search) {
      const rx = new RegExp(String(req.query.search).trim().slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), "i");
      filter.$or = [
        { action: rx },
        { message: rx },
        { resource_id: rx },
        { ip_address: rx },
        { 'metadata.actor.name': rx },
        { 'metadata.actor.email': rx },
        { 'metadata.actor.employee_id': rx },
        { 'metadata.session_id': rx },
      ];
    }

    const [total, logs] = await Promise.all([
      AuditLog.countDocuments(filter),
      AuditLog.find(filter)
        .populate("user_id", "name email role")
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    // Format logs with user-friendly severity mapping & actor display
    const formatted = logs.map((l) => {
      let severity = "Low";
      if (l.status === "BLOCKED") severity = "Critical";
      else if (l.status === "FAILURE") severity = "High";
      else if (l.status === "WARNING") severity = "Medium";

      return {
        id: l._id.toString(),
        timestamp: new Date(l.createdAt).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
        utcTimestamp: new Date(l.createdAt).toUTCString(),
        severity,
        status: l.status,
        module: l.category ? (l.category.charAt(0).toUpperCase() + l.category.slice(1).toLowerCase()) : "System",
        ...actorFields(l),
        eventType: l.action,
        actionTitle: l.action.replace(/_/g, " "),
        targetEntity: l.resource_id || l.resource_type || "N/A",
        description: l.message || `Executed ${l.action} on ${l.resource_type}`,
        location: l.ip_address || "Unknown",
        city: l.metadata?.city || "",
        destructive: ["BLOCKED", "FAILURE"].includes(l.status) || l.action.includes("DELETE") || l.action.includes("UNLINK"),
        reasonCode: l.metadata?.reason || l.message || "Standard administrative event.",
        diff: l.metadata?.diff || null,
      };
    });

    res.status(200).json({
      success: true,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      count: formatted.length,
      data: formatted,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get single audit log by ID
// @route   GET /api/admin/audit-logs/:id
// @access  Private (ADMIN or HELPER)
// ─────────────────────────────────────────────
exports.getAuditLogById = async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid audit event ID' });
    const log = await AuditLog.findById(req.params.id)
      .populate("user_id", "name email role status")
      .lean();

    if (!log) {
      return res.status(404).json({ success: false, message: "Audit event record not found" });
    }

    let severity = "Low";
    if (log.status === "BLOCKED") severity = "Critical";
    else if (log.status === "FAILURE") severity = "High";
    else if (log.status === "WARNING") severity = "Medium";

    const formatted = {
      id: log._id.toString(),
      timestamp: new Date(log.createdAt).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
      utcTimestamp: new Date(log.createdAt).toUTCString(),
      severity,
      status: log.status,
      category: log.category,
      module: log.category ? (log.category.charAt(0).toUpperCase() + log.category.slice(1).toLowerCase()) : "System",
      ...actorFields(log),
      eventType: log.action,
      actionTitle: log.action.replace(/_/g, " "),
      targetEntity: log.resource_id || log.resource_type || "N/A",
      resourceType: log.resource_type,
      resourceId: log.resource_id,
      description: log.message || `Executed ${log.action} on ${log.resource_type}`,
      location: log.ip_address || "Unknown",
      city: log.metadata?.city || "",
      userAgent: log.user_agent || null,
      destructive: ["BLOCKED", "FAILURE"].includes(log.status) || log.action.includes("DELETE") || log.action.includes("UNLINK"),
      reasonCode: log.metadata?.reason || log.message || "Standard administrative event.",
      metadata: log.metadata || {},
      diff: log.metadata?.diff || null,
      rawRecord: log,
    };

    res.status(200).json({ success: true, data: formatted });
  } catch (error) {
    next(error);
  }
};


// ─────────────────────────────────────────────
// @desc    Get audit KPIs (24h events, security alerts, admin changes, user actions)
// @route   GET /api/admin/audit-logs/stats
// @access  Private (ADMIN or HELPER)
// ─────────────────────────────────────────────
exports.getAuditStats = async (req, res, next) => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const scope = req.query.scope === 'admin' ? { $and: [adminScope()] } : {};

    const [total24h, securityAlerts, adminChanges, userActions, staffSessions] = await Promise.all([
      AuditLog.countDocuments({ ...scope, createdAt: { $gte: twentyFourHoursAgo } }),
      AuditLog.countDocuments({
        ...scope,
        createdAt: { $gte: twentyFourHoursAgo },
        status: { $in: ["FAILURE", "BLOCKED", "WARNING"] },
      }),
      AuditLog.countDocuments({
        ...scope,
        createdAt: { $gte: twentyFourHoursAgo },
        category: "ADMIN",
      }),
      AuditLog.countDocuments({
        ...scope,
        createdAt: { $gte: twentyFourHoursAgo },
        category: { $in: ["AUTH", "DEVICE"] },
      }),
      AuditLog.countDocuments({ ...scope, createdAt: { $gte: twentyFourHoursAgo },
        action: { $in: ['ADMIN_LOGIN', 'HELPER_LOGIN', 'ADMIN_LOGOUT', 'HELPER_LOGOUT'] } }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        total_24h: total24h,
        security_alerts: securityAlerts,
        admin_changes: adminChanges,
        user_actions: userActions,
        staff_sessions: staffSessions,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get specific user's audit / activity trail
// @route   GET /api/admin/users/:id/activity
// @access  Private (ADMIN or HELPER)
// ─────────────────────────────────────────────
exports.getUserActivityLogs = async (req, res, next) => {
  try {
    const userId = req.params.id;
    const user = await User.findById(userId).select("name email role status").lean() ||
      await Helper.findById(userId).select('name email role status').lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const logs = await AuditLog.find({ user_id: userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    // Group logs by Date label
    const groupedMap = new Map();

    logs.forEach((log) => {
      const dateLabel = new Date(log.createdAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });

      if (!groupedMap.has(dateLabel)) {
        groupedMap.set(dateLabel, []);
      }

      groupedMap.get(dateLabel).push({
        id: log._id.toString(),
        type: log.category || "System",
        title: log.action.replace(/_/g, " "),
        time: new Date(log.createdAt).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        }),
        description: log.message || `Action ${log.action} performed`,
        icon:
          log.category === "DEVICE"
            ? "motorcycle"
            : log.category === "FIRMWARE"
            ? "system_update"
            : log.category === "AUTH"
            ? "person"
            : log.category === "ADMIN"
            ? "manage_accounts"
            : "info",
        badges: log.resource_id ? [{ text: log.resource_id }] : [],
      });
    });

    const timelineGroups = Array.from(groupedMap.entries()).map(([dateLabel, items]) => ({
      dateLabel,
      items,
    }));

    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        status: user.status,
      },
      data: timelineGroups,
    });
  } catch (error) {
    next(error);
  }
};
