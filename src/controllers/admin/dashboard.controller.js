/**
 * admin/dashboard.controller.js
 *
 * Optimisation notes:
 *   - getDashboardStats: ALL counts run in a single Promise.all() — N parallel
 *     queries instead of N sequential round-trips. This is the single biggest
 *     win for a stats endpoint that might otherwise take 500ms+.
 *   - getSystemHealth: DB ping + process metrics combined — no DB reads needed.
 */
const mongoose   = require("mongoose");
const User        = require("../../models/User");
const Device      = require("../../models/device.model");
const SupportTicket = require("../../models/SupportTicket.model");
const FirmwareHistory = require("../../models/FirmwareHistory.model");
const cacheService    = require("../../services/cache.service");

// ─────────────────────────────────────────────
// @desc    Admin dashboard statistics (Cached 60s in Redis)
// @route   GET /api/admin/dashboard/stats
// @access  Private (ADMIN or HELPER)
// ─────────────────────────────────────────────
exports.getDashboardStats = async (req, res, next) => {
  try {
    const stats = await cacheService.getOrSet(
      "admin:dashboard:stats",
      async () => {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const sevenDaysAgo  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000);

        /**
         * High-Performance Parallel Aggregation:
         * All fleet metrics, ticket counts, user stats, and pairing activity run in 1 round-trip.
         */
        const [
          totalUsers,
          activeUsers,
          newUsersThisMonth,
          suspendedUsers,
          totalDevices,
          pairedDevices,
          activeDevices,
          availableDevices,
          offlineDevices,
          blockedDevices,
          retiredDevices,
          openTickets,
          urgentTickets,
          recentPairings,
        ] = await Promise.all([
          User.countDocuments(),
          User.countDocuments({ status: "active" }),
          User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
          User.countDocuments({ status: { $in: ["suspended", "banned"] } }),
          // Total hardware units
          Device.countDocuments(),
          // Paired devices
          Device.countDocuments({ is_paired: true, is_retired: false, is_blocked: false }),
          // Active (paired & communicating)
          Device.countDocuments({ is_paired: true, is_active: true, is_blocked: false, is_retired: false }),
          // Available (in stock, unpaired, active)
          Device.countDocuments({ is_paired: false, is_active: true, is_blocked: false, is_retired: false }),
          // Offline / Disconnected
          Device.countDocuments({ is_active: false, is_retired: false, is_blocked: false }),
          // Blocked (stolen / blacklisted)
          Device.countDocuments({ is_blocked: true }),
          // Retired (decommissioned)
          Device.countDocuments({ is_retired: true }),
          // Open tickets
          SupportTicket.countDocuments({ status: { $in: ["open", "in_progress"] } }),
          // Urgent / Critical tickets
          SupportTicket.countDocuments({ status: { $in: ["open", "in_progress"] }, priority: { $in: ["high", "critical"] } }),
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

        return {
          overview: {
            total_users:    totalUsers,
            active_users:   activeUsers,
            total_devices:  totalDevices,
            paired_devices: pairedDevices,
            open_tickets:   openTickets,
            urgent_tickets: urgentTickets,
          },
          users: {
            total:          totalUsers,
            active:         activeUsers,
            new_this_month: newUsersThisMonth,
            suspended:      suspendedUsers,
          },
          devices: {
            total:     totalDevices,
            paired:    pairedDevices,
            active:    activeDevices,
            available: availableDevices,
            offline:   offlineDevices,
            blocked:   blockedDevices,
            retired:   retiredDevices,
          },
          support: {
            open_tickets:   openTickets,
            urgent_tickets: urgentTickets,
          },
          recent_pairings: formattedRecentPairings,
        };
      },
      60 // 60 seconds TTL
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
