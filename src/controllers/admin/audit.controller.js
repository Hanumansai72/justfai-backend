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

// ─────────────────────────────────────────────
// @desc    List audit logs with multi-field search & filters
// @route   GET /api/admin/audit-logs
// @access  Private (ADMIN or HELPER)
// ─────────────────────────────────────────────
exports.getAuditLogs = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const skip  = (page - 1) * limit;

    const filter = {};

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
      const modMap = {
        users: "AUTH",
        devices: "DEVICE",
        firmware: "FIRMWARE",
        support: "ADMIN",
        security: "SECURITY",
        system: "SYSTEM",
      };
      const cat = modMap[req.query.module.toLowerCase()] || req.query.module.toUpperCase();
      filter.category = cat;
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
      const rx = new RegExp(req.query.search.trim(), "i");
      filter.$or = [
        { action: rx },
        { message: rx },
        { resource_id: rx },
        { ip_address: rx },
      ];
    }

    const [total, logs] = await Promise.all([
      AuditLog.countDocuments(filter),
      AuditLog.find(filter)
        .populate("user_id", "name email role")
        .sort({ createdAt: -1 })
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
        module: l.category ? (l.category.charAt(0).toUpperCase() + l.category.slice(1).toLowerCase()) : "System",
        actor: l.user_id ? l.user_id.name : "System / Guest",
        actorId: l.user_id ? l.user_id._id.toString() : "SYS-001",
        actorType: l.user_id?.role ? l.user_id.role.toLowerCase() : "system",
        eventType: l.action,
        actionTitle: l.action.replace(/_/g, " "),
        targetEntity: l.resource_id || l.resource_type || "N/A",
        description: l.message || `Executed ${l.action} on ${l.resource_type}`,
        location: l.ip_address || "127.0.0.1",
        city: l.metadata?.city || "Internal Network",
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
// @desc    Get audit KPIs (24h events, security alerts, admin changes, user actions)
// @route   GET /api/admin/audit-logs/stats
// @access  Private (ADMIN or HELPER)
// ─────────────────────────────────────────────
exports.getAuditStats = async (req, res, next) => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [total24h, securityAlerts, adminChanges, userActions] = await Promise.all([
      AuditLog.countDocuments({ createdAt: { $gte: twentyFourHoursAgo } }),
      AuditLog.countDocuments({
        createdAt: { $gte: twentyFourHoursAgo },
        status: { $in: ["FAILURE", "BLOCKED", "WARNING"] },
      }),
      AuditLog.countDocuments({
        createdAt: { $gte: twentyFourHoursAgo },
        category: "ADMIN",
      }),
      AuditLog.countDocuments({
        createdAt: { $gte: twentyFourHoursAgo },
        category: { $in: ["AUTH", "DEVICE"] },
      }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        total_24h: total24h,
        security_alerts: securityAlerts,
        admin_changes: adminChanges,
        user_actions: userActions,
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
    const user = await User.findById(userId).select("name email role status").lean();
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
