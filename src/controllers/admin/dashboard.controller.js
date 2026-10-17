// Dashboard metrics share one aggregation per collection and the existing cache.
const mongoose   = require("mongoose");
const User        = require("../../models/User");
const Device      = require("../../models/device.model");
const SupportTicket = require("../../models/SupportTicket.model");
const cacheService    = require("../../services/cache.service");

// ─────────────────────────────────────────────
// @desc    Admin dashboard statistics (30s cache, invalidated by model writes)
// @route   GET /api/admin/dashboard/stats
// @access  Private (ADMIN or HELPER)
// ─────────────────────────────────────────────
exports.getDashboardStats = async (req, res, next) => {
  try {
    const stats = await cacheService.getOrSet(
      'dashboard',
      "admin:dashboard:stats",
      async () => {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const countWhen = condition => ({ $sum: { $cond: [condition, 1, 0] } });
        const usableDevice = [
          { $eq: ['$is_blocked', false] },
          { $eq: ['$is_retired', false] },
        ];
        const [userRows, deviceRows, ticketRows, recentPairings] = await Promise.all([
          User.aggregate([{ $group: {
            _id: null,
            total: { $sum: 1 },
            active: countWhen({ $eq: ['$status', 'active'] }),
            new_this_month: countWhen({ $gte: ['$createdAt', thirtyDaysAgo] }),
            suspended: countWhen({ $in: ['$status', ['suspended', 'banned']] }),
          } }, { $project: { _id: 0 } }]),
          Device.aggregate([{ $group: {
            _id: null,
            total: { $sum: 1 },
            paired: countWhen({ $and: [...usableDevice, { $eq: ['$is_paired', true] }] }),
            active: countWhen({ $and: [...usableDevice, { $eq: ['$is_paired', true] }, { $eq: ['$is_active', true] }] }),
            available: countWhen({ $and: [...usableDevice, { $eq: ['$is_paired', false] }, { $eq: ['$is_active', true] }] }),
            offline: countWhen({ $and: [...usableDevice, { $eq: ['$is_active', false] }] }),
            blocked: countWhen({ $eq: ['$is_blocked', true] }),
            retired: countWhen({ $eq: ['$is_retired', true] }),
          } }, { $project: { _id: 0 } }]),
          SupportTicket.aggregate([
            { $match: { status: { $in: ['open', 'in_progress'] } } },
            { $group: {
              _id: null,
              open_tickets: { $sum: 1 },
              urgent_tickets: countWhen({ $in: ['$priority', ['high', 'critical']] }),
            } },
            { $project: { _id: 0 } },
          ]),
          // Recent pairings with rich customer & device metadata
          Device.find({ is_paired: true, linked_to: { $ne: null } })
            .select("devicename device_id BLE_ADDRESS device_version firmware_version linked_to linked_date is_active is_blocked")
            .populate("linked_to", "name email avatar")
            .sort({ linked_date: -1 })
            .limit(10)
            .lean(),
        ]);

        const formattedRecentPairings = recentPairings.map((d) => ({
          id:               d._id,
          devicename:       d.devicename || "JustRide Device",
          device_id:        d.device_id || "N/A",
          BLE_ADDRESS:      d.BLE_ADDRESS,
          device_version:   d.device_version || "1.0",
          firmware_version: d.firmware_version || "1.0.0",
          linked_date:      d.linked_date,
          status:           d.is_blocked ? "blocked" : d.is_active ? "active" : "offline",
          user: d.linked_to
            ? {
                id:     d.linked_to._id,
                name:   d.linked_to.name,
                email:  d.linked_to.email,
                avatar: d.linked_to.avatar || null,
              }
            : null,
        }));

        const users = userRows[0] || {
          total: 0, active: 0, new_this_month: 0, suspended: 0,
        };
        const devices = deviceRows[0] || {
          total: 0, paired: 0, active: 0, available: 0, offline: 0, blocked: 0, retired: 0,
        };
        const support = ticketRows[0] || {
          open_tickets: 0, urgent_tickets: 0,
        };
        return {
          overview: {
            total_users: users.total,
            active_users: users.active,
            total_devices: devices.total,
            paired_devices: devices.paired,
            ...support,
          },
          users,
          devices,
          support,
          recent_pairings: formattedRecentPairings,
        };
      },
      30
    );

    res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    System health — DB status + process metrics
// @route   GET /api/admin/dashboard/health
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.getSystemHealth = async (req, res, next) => {
  try {
    const dbStateMap = { 0: "disconnected", 1: "connected", 2: "connecting", 3: "disconnecting" };
    const dbState = mongoose.connection.readyState;
    const mem = process.memoryUsage();

    // Lightweight ping — runs a no-op command against the DB
    let dbPingMs = null;
    try {
      const pingStart = Date.now();
      await mongoose.connection.db.command({ ping: 1 });
      dbPingMs = Date.now() - pingStart;
    } catch (_) { /* DB unreachable */ }

    res.status(200).json({
      success: true,
      data: {
        status: dbState === 1 ? "healthy" : "degraded",
        timestamp: new Date().toISOString(),
        rate_limiting: { ...require('../../security/rateLimiter').metrics },
        database: {
          state: dbStateMap[dbState] || "unknown",
          ping_ms: dbPingMs,
          host: mongoose.connection.host,
          name: mongoose.connection.name,
        },
        process: {
          uptime_seconds: Math.floor(process.uptime()),
          node_version: process.version,
          memory: {
            rss_mb:        (mem.rss / 1024 / 1024).toFixed(2),
            heap_used_mb:  (mem.heapUsed / 1024 / 1024).toFixed(2),
            heap_total_mb: (mem.heapTotal / 1024 / 1024).toFixed(2),
          },
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
