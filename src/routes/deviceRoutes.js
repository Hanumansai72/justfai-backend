const express = require("express");
const router = express.Router();

const { protect, authorize } = require("../middlewares/authMiddleware");
const { pairingLimiter, otpLimiter, unlinkLimiter, firmwareLimiter } = require("../security/rateLimiter");
const validate = require("../security/validate");

// Controllers
const {
  registerDevice,
  getDevice,
  getMyDevice,
  updateDevice,
  deleteDevice,
} = require("../controllers/device/device.controller");

const {
  checkDeviceAccess,
  pairDevice,
  requestUnlinkOtp,
  unlinkDevice,
} = require("../controllers/device/pairing.controller");

const {
  getLatestFirmware,
  checkUpdate,
  checkFirmwareUpdate,
  getFirmwareDownload,
  createFirmwareRelease,
  recordFirmwareUpdate,
  getFirmwareHistory,
  setLatestFirmware,
} = require("../controllers/device/firmware.controller");

// ── All routes require authentication ──────────────────────────
router.use(protect);

// ── Firmware Catalog & Download (Placed before /:id parameter routes) ──
router.get("/firmware/latest",            getLatestFirmware);
router.get("/firmware/download/:version", getFirmwareDownload);
router.post("/firmware/release",          authorize("ADMIN"), createFirmwareRelease);

// ── Pairing domain ─────────────────────────────────────────────
router.post("/check-pairing",          pairingLimiter, checkDeviceAccess);
router.post("/pair",                   pairingLimiter, validate.pairDevice, pairDevice);
router.post("/request-unlink-otp",     otpLimiter,    requestUnlinkOtp);
router.post("/:id/request-unlink-otp", otpLimiter,    requestUnlinkOtp);
router.post("/unlink",                 unlinkLimiter,  validate.unlinkDevice, unlinkDevice);
router.post("/:id/unlink",             unlinkLimiter,  validate.unlinkDevice, unlinkDevice);

// ── My Device ──────────────────────────────────────────────────
router.get("/my-device",  getMyDevice);
router.get("/my-devices", getMyDevice); // alias

// ── Core CRUD ──────────────────────────────────────────────────
router.post("/",   authorize("ADMIN"), validate.registerDevice, registerDevice);
router.get("/:id",                     getDevice);
router.put("/:id",                     updateDevice);
router.delete("/:id", authorize("ADMIN"), deleteDevice);

// ── Device-Specific Firmware domain ────────────────────────────
router.get("/:id/firmware/check",   checkUpdate);
router.get("/:id/check-update",      checkUpdate); // alias
router.get("/:id/firmware/history", getFirmwareHistory);
router.post("/:id/firmware/update", firmwareLimiter, validate.recordFirmwareUpdate, recordFirmwareUpdate);
router.patch("/:id/firmware/set-latest", authorize("ADMIN"), setLatestFirmware);

module.exports = router;
