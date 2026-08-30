const mongoose = require("mongoose");

const deviceSchema = new mongoose.Schema(
  {
    devicename: { type: String, trim: true },
    device_version: { type: String, trim: true },
    serialnumber: { type: String, trim: true },

    device_hash: { type: String, unique: true, sparse: true },
    pairing_code: { type: String, select: false },
    device_secret: { type: String, select: false, trim: true },

    BLE_ADDRESS: { type: String, unique: true, sparse: true, trim: true },
    device_id:   { type: String, unique: true, sparse: true, trim: true },

    is_paired:  { type: Boolean, default: false },
    is_active:  { type: Boolean, default: true  },
    // Admin lifecycle controls
    is_blocked:   { type: Boolean, default: false, index: true },
    block_reason: { type: String, trim: true, default: null },
    blocked_at:   { type: Date, default: null },
    blocked_by:   { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    is_retired:   { type: Boolean, default: false },
    retired_at:   { type: Date, default: null },
    retired_by:   { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    linked_to:   { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    linked_date: { type: Date, default: null },

    unlink_date:        { type: Date, default: null },
    unlink_by:          { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    unlink_otp:         { type: String, select: false },
    unlink_otp_expires: { type: Date },

    no_of_connection: { type: Number, default: 0 },

    // Firmware tracking
    firmware_version:          { type: String, trim: true, default: null },
    latest_firmware:           { type: String, trim: true, default: null },
    firmware_update_available: { type: Boolean, default: false },
    last_firmware_check:       { type: Date, default: null },
    last_firmware_update:      { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * Compound index for the most frequent query pattern:
 *   Device.findOne({ linked_to: <userId>, is_paired: true })
 * Used in: getMyDevice, checkDeviceAccess, pairDevice (3 controllers)
 */
deviceSchema.index({ linked_to: 1, is_paired: 1 });

module.exports = mongoose.model("Device", deviceSchema);