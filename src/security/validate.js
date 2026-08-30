/**
 * security/validate.js
 * Request body validators for every route using the `validator` library.
 * Returns structured 400 errors before any controller logic runs.
 *
 * Usage: router.post("/register", validate.register, register)
 */
const validator = require("validator");

const rejectWith = (res, errors) =>
  res.status(400).json({ success: false, message: "Validation failed", errors });

// ── Auth ───────────────────────────────────────────────────────

exports.register = (req, res, next) => {
  const { name, email, password, phonenumber } = req.body;
  const errors = [];

  if (!name || String(name).trim().length < 2)
    errors.push({ field: "name", message: "Name must be at least 2 characters" });

  if (!email || !validator.isEmail(String(email)))
    errors.push({ field: "email", message: "Please provide a valid email address" });

  if (!password || String(password).length < 6)
    errors.push({ field: "password", message: "Password must be at least 6 characters" });

  if (!phonenumber || !validator.isMobilePhone(String(phonenumber), "any"))
    errors.push({ field: "phonenumber", message: "Please provide a valid phone number" });

  if (errors.length) return rejectWith(res, errors);
  next();
};

exports.login = (req, res, next) => {
  const { email, password } = req.body;
  const errors = [];

  if (!email || !validator.isEmail(String(email)))
    errors.push({ field: "email", message: "Please provide a valid email address" });

  if (!password || String(password).length < 1)
    errors.push({ field: "password", message: "Password is required" });

  if (errors.length) return rejectWith(res, errors);
  next();
};

exports.forgotPassword = (req, res, next) => {
  const { email } = req.body;
  const errors = [];

  if (!email || !validator.isEmail(String(email)))
    errors.push({ field: "email", message: "Please provide a valid email address" });

  if (errors.length) return rejectWith(res, errors);
  next();
};

exports.resetPassword = (req, res, next) => {
  const { password, token } = req.body;
  const resetToken = req.params.token || token;
  const errors = [];

  if (!resetToken)
    errors.push({ field: "token", message: "Reset token is required" });

  if (!password || String(password).length < 6)
    errors.push({ field: "password", message: "Password must be at least 6 characters" });

  if (errors.length) return rejectWith(res, errors);
  next();
};

exports.changePassword = (req, res, next) => {
  const { currentPassword, newPassword } = req.body;
  const errors = [];

  if (!currentPassword)
    errors.push({ field: "currentPassword", message: "Current password is required" });

  if (!newPassword || String(newPassword).length < 6)
    errors.push({ field: "newPassword", message: "New password must be at least 6 characters" });

  if (currentPassword && newPassword && currentPassword === newPassword)
    errors.push({ field: "newPassword", message: "New password must be different from current password" });

  if (errors.length) return rejectWith(res, errors);
  next();
};

exports.updateProfile = (req, res, next) => {
  const { email, phonenumber } = req.body;
  const errors = [];

  if (email && !validator.isEmail(String(email)))
    errors.push({ field: "email", message: "Please provide a valid email address" });

  if (phonenumber && !validator.isMobilePhone(String(phonenumber), "any"))
    errors.push({ field: "phonenumber", message: "Please provide a valid phone number" });

  if (errors.length) return rejectWith(res, errors);
  next();
};

exports.updateUserRole = (req, res, next) => {
  const { role } = req.body;
  const errors = [];

  if (!role || !["ADMIN", "USER"].includes(String(role).toUpperCase()))
    errors.push({ field: "role", message: "role must be 'ADMIN' or 'USER'" });

  if (errors.length) return rejectWith(res, errors);
  next();
};

// ── Device ─────────────────────────────────────────────────────

const BLE_REGEX = /^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/;

exports.registerDevice = (req, res, next) => {
  const { BLE_ADDRESS, device_id, serialnumber } = req.body;
  const errors = [];

  if (!BLE_ADDRESS && !device_id && !serialnumber)
    errors.push({ field: "identifier", message: "Provide at least one of: BLE_ADDRESS, device_id, or serialnumber" });

  if (BLE_ADDRESS && !BLE_REGEX.test(String(BLE_ADDRESS).trim()))
    errors.push({ field: "BLE_ADDRESS", message: "BLE_ADDRESS must be a valid MAC address (AA:BB:CC:DD:EE:FF)" });

  if (errors.length) return rejectWith(res, errors);
  next();
};

exports.pairDevice = (req, res, next) => {
  const { BLE_ADDRESS } = req.body;
  const errors = [];

  if (!BLE_ADDRESS)
    errors.push({ field: "BLE_ADDRESS", message: "BLE_ADDRESS is required for pairing" });

  if (BLE_ADDRESS && !BLE_REGEX.test(String(BLE_ADDRESS).trim()))
    errors.push({ field: "BLE_ADDRESS", message: "BLE_ADDRESS must be a valid MAC address" });

  if (errors.length) return rejectWith(res, errors);
  next();
};

exports.unlinkDevice = (req, res, next) => {
  const { device_hash, pairing_code, otp_code, BLE_ADDRESS, device_id } = req.body;
  const errors = [];

  if (!req.params.id && !BLE_ADDRESS && !device_id)
    errors.push({ field: "identifier", message: "Provide a device _id, BLE_ADDRESS, or device_id" });

  if (!device_hash && !pairing_code && !otp_code)
    errors.push({ field: "verification", message: "Provide at least one of: device_hash, pairing_code, or otp_code" });

  if (otp_code && !/^\d{6}$/.test(String(otp_code)))
    errors.push({ field: "otp_code", message: "OTP must be exactly 6 digits" });

  if (errors.length) return rejectWith(res, errors);
  next();
};

// ── Firmware ───────────────────────────────────────────────────

exports.recordFirmwareUpdate = (req, res, next) => {
  const { to_version, status } = req.body;
  const errors = [];
  const validStatuses = ["pending", "success", "failed", "rollback"];

  if (!to_version || String(to_version).trim().length === 0)
    errors.push({ field: "to_version", message: "to_version is required" });

  if (status && !validStatuses.includes(status))
    errors.push({ field: "status", message: `status must be one of: ${validStatuses.join(", ")}` });

  if (errors.length) return rejectWith(res, errors);
  next();
};
