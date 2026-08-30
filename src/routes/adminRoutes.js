/**
 * routes/adminRoutes.js
 * Admin & Helper Administrative Routing Suite.
 *
 * Role hierarchy:
 *   - ADMIN: Full access (Users, Firmware, Hardware, Staff provisioning, System Stats)
 *   - HELPER: Support Staff (Customer support tickets, device troubleshooting, block/force-unlink from tickets)
 */
const express = require("express");
const router  = express.Router();

const { protect, authorize } = require("../middlewares/authMiddleware");
const { authLimiter }        = require("../security/rateLimiter");

// Auth & Staff Controllers
const {
  adminLogin,
  getAdminProfile,
  updateAdminCredentials,
  createHelperUser,
  getHelperUsers,
  getHelperById,
  updateHelperStatus,
  deleteHelperUser,
} = require("../controllers/admin/auth.controller");

// Domain Controllers
const { getDashboardStats, getSystemHealth }                  = require("../controllers/admin/dashboard.controller");
const { getUsers, getUserById, updateUserStatus, deleteUser } = require("../controllers/admin/users.controller");
const {
  registerDevice, getDevices, getDeviceById, updateDevice,
  blockDevice, unblockDevice, forceUnlinkDevice, retireDevice,
} = require("../controllers/admin/devices.controller");
const { getPairingRequests, forceUnpairDevice }               = require("../controllers/admin/pairing.controller");
const {
  createFirmwareRelease, getFirmwareReleases,
  updateFirmwareRelease, deleteFirmwareRelease,
} = require("../controllers/admin/firmware.controller");
const {
  getSupportTickets,
  getSupportTicket,
  updateSupportTicket,
  blockDeviceFromTicket,
  forceUnlinkDeviceFromTicket,
} = require("../controllers/admin/support.controller");

// ── Public Admin Login Route ────────────────────────────────────
router.post("/login", authLimiter, adminLogin);

// ── Protected Staff Routes (ADMIN & HELPER) ─────────────────────
router.use(protect);

// Profile & Self Credential Updates
router.get("/me",              authorize("ADMIN", "HELPER"), getAdminProfile);
router.put("/credentials",     authorize("ADMIN", "HELPER"), updateAdminCredentials);

// Dashboard (Admins & Helpers can view stats)
router.get("/dashboard/stats",  authorize("ADMIN", "HELPER"), getDashboardStats);
router.get("/dashboard/health", authorize("ADMIN"),           getSystemHealth);

// Helper / Customer Care Staff Management (Admin only)
router.post("/helpers",               authorize("ADMIN"), createHelperUser);
router.get("/helpers",                authorize("ADMIN"), getHelperUsers);
router.get("/helpers/:id",            authorize("ADMIN"), getHelperById);
router.patch("/helpers/:id/status",   authorize("ADMIN"), updateHelperStatus);
router.delete("/helpers/:id",         authorize("ADMIN"), deleteHelperUser);

// User Management (Admin only)
router.get("/users",              authorize("ADMIN"), getUsers);
router.get("/users/:id",          authorize("ADMIN"), getUserById);
router.patch("/users/:id/status", authorize("ADMIN"), updateUserStatus);
router.delete("/users/:id",       authorize("ADMIN"), deleteUser);

// Device Management & Control
router.post("/devices",                   authorize("ADMIN"),           registerDevice);
router.get("/devices",                    authorize("ADMIN", "HELPER"), getDevices);
router.get("/devices/:id",                authorize("ADMIN", "HELPER"), getDeviceById);
router.put("/devices/:id",                authorize("ADMIN"),           updateDevice);
router.patch("/devices/:id/block",        authorize("ADMIN", "HELPER"), blockDevice);
router.patch("/devices/:id/unblock",      authorize("ADMIN", "HELPER"), unblockDevice);
router.patch("/devices/:id/force-unlink", authorize("ADMIN", "HELPER"), forceUnlinkDevice);
router.patch("/devices/:id/retire",       authorize("ADMIN"),           retireDevice);

// Pairing Logs & Remote Actions
router.get("/pairing",                    authorize("ADMIN", "HELPER"), getPairingRequests);
router.patch("/pairing/:id/force-unpair", authorize("ADMIN", "HELPER"), forceUnpairDevice);

// Firmware Releases (Admin only)
router.post("/firmware",       authorize("ADMIN"), createFirmwareRelease);
router.get("/firmware",        authorize("ADMIN", "HELPER"), getFirmwareReleases);
router.put("/firmware/:id",    authorize("ADMIN"), updateFirmwareRelease);
router.delete("/firmware/:id", authorize("ADMIN"), deleteFirmwareRelease);

// Staff Notifications & Real-Time Alerts
const {
  getStaffNotifications,
  getStaffUnreadCount,
  markStaffNotificationRead,
  markAllStaffNotificationsRead,
} = require("../controllers/admin/notification.controller");

// Audit Trail & Activity Logs
const {
  getAuditLogs,
  getAuditStats,
  getUserActivityLogs,
} = require("../controllers/admin/audit.controller");

// User Activity Trail
router.get("/users/:id/activity",                   authorize("ADMIN", "HELPER"), getUserActivityLogs);

// Customer Support & Troubleshooting
router.get("/support",                              authorize("ADMIN", "HELPER"), getSupportTickets);
router.get("/support/:id",                          authorize("ADMIN", "HELPER"), getSupportTicket);
router.patch("/support/:id",                        authorize("ADMIN", "HELPER"), updateSupportTicket);
router.post("/support/:id/block-device",            authorize("ADMIN", "HELPER"), blockDeviceFromTicket);
router.post("/support/:id/force-unlink-device",     authorize("ADMIN", "HELPER"), forceUnlinkDeviceFromTicket);

// Staff Notification Inbox & Alerts (For ADMIN & HELPER)
router.get("/notifications",                        authorize("ADMIN", "HELPER"), getStaffNotifications);
router.get("/notifications/unread-count",           authorize("ADMIN", "HELPER"), getStaffUnreadCount);
router.patch("/notifications/:id/read",             authorize("ADMIN", "HELPER"), markStaffNotificationRead);
router.patch("/notifications/mark-all-read",        authorize("ADMIN", "HELPER"), markAllStaffNotificationsRead);

// Audit Logs & System Activity (For ADMIN & HELPER)
router.get("/audit-logs",                            authorize("ADMIN", "HELPER"), getAuditLogs);
router.get("/audit-logs/stats",                      authorize("ADMIN", "HELPER"), getAuditStats);

module.exports = router;
