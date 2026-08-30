/**
 * utils/deviceCrypto.js
 * Shared crypto helpers + query utilities for device operations.
 *
 * Key design decision:
 *   findDeviceByIdentifier() uses a SINGLE $or query regardless of whether the
 *   identifier looks like an ObjectId or not. This avoids two sequential round-trips
 *   to MongoDB and lets the index planner choose the fastest path.
 */
const crypto = require("crypto");
const mongoose = require("mongoose");

const DEVICE_SECRET = process.env.DEVICE_SECRET || "justride_secure_device_secret_2026";

/** Normalise BLE address to uppercase trimmed string */
const formatBleAddress = (ble) => (ble ? ble.trim().toUpperCase() : null);

/** Alphanumeric random code (hex-based, uppercase) */
const generateRandomCode = (length = 6) =>
  crypto.randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length).toUpperCase();

/** 6-digit numeric OTP */
const generateNumericOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

/** SHA-256 hash — for OTP / pairing code storage */
const hashString = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

/**
 * HMAC-SHA256 device hash.
 * Binds BLE_ADDRESS + random pairing code into a single secret token using the device's secret key.
 */
const generateDeviceHash = (bleAddress, randomCode, customSecret = null) => {
  const secretKey = customSecret || DEVICE_SECRET;
  return crypto
    .createHmac("sha256", secretKey)
    .update(`${formatBleAddress(bleAddress)}:${randomCode}`)
    .digest("hex");
};

/**
 * Constant-time string comparison — prevents timing-based hash oracle attacks.
 */
const safeCompare = (a, b) => {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * findDeviceByIdentifier — SINGLE round-trip query.
 *
 * Builds a single $or predicate covering:
 *   - MongoDB _id (when the string is a valid ObjectId)
 *   - BLE_ADDRESS (normalised)
 *   - device_id
 *   - device_hash
 *
 * @param {mongoose.Model} Model - Mongoose Device model
 * @param {string} identifier   - Any of the above identifiers
 * @param {string} [selectFields] - Additional fields to select (e.g. "+pairing_code")
 * @param {string|Object} [populate] - Optional populate config
 * @returns {Promise<Document|null>}
 */
const findDeviceByIdentifier = (Model, identifier, selectFields = "", populate = null) => {
  if (!identifier) return null;

  const orConditions = [
    { BLE_ADDRESS: formatBleAddress(identifier) },
    { device_id: identifier },
    { device_hash: identifier },
  ];

  // Include _id match only when identifier is a valid ObjectId — avoids a cast error
  if (mongoose.isValidObjectId(identifier)) {
    orConditions.unshift({ _id: identifier });
  }

  let query = Model.findOne({ $or: orConditions });
  if (selectFields) query = query.select(selectFields);
  if (populate) query = query.populate(populate);

  return query.exec();
};

module.exports = {
  DEVICE_SECRET,
  formatBleAddress,
  generateRandomCode,
  generateNumericOtp,
  hashString,
  generateDeviceHash,
  safeCompare,
  findDeviceByIdentifier,
};
