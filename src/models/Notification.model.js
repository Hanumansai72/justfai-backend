/**
 * Notification.model.js
 * Unified High-Performance Notification Model for End-Users, Admins, and Support Staff.
 *
 * Types:
 *   - Customer: FIRMWARE_UPDATE, DEVICE_DISCONNECTED, DEVICE_PAIRING, SECURITY_ALERT, ACCOUNT_NOTIFICATION
 *   - Staff/Admin: NEW_SUPPORT_TICKET, TICKET_ASSIGNED, TICKET_CUSTOMER_REPLY, DEVICE_CRITICAL_ALERT, SYSTEM_ALERT
 */
const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    // Target Recipient (optional if target_audience is broadcast like ALL_STAFF)
    recipient_id: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "recipient_model",
      index: true,
      default: null,
    },
    recipient_model: {
      type: String,
      enum: ["User", "Helper"],
      default: "User",
    },
    // Backwards compatibility alias for user_id
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      default: null,
    },
    // Audience routing
    target_audience: {
      type: String,
      enum: ["USER", "ALL_STAFF", "ADMIN_ONLY", "HELPER_ONLY", "INDIVIDUAL"],
      default: "INDIVIDUAL",
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: [
        // User notification types
        "FIRMWARE_UPDATE",
        "DEVICE_DISCONNECTED",
        "DEVICE_PAIRING",
        "SECURITY_ALERT",
        "ACCOUNT_NOTIFICATION",
        // Staff & Admin notification types
        "NEW_SUPPORT_TICKET",
        "TICKET_ASSIGNED",
        "TICKET_CUSTOMER_REPLY",
        "DEVICE_CRITICAL_ALERT",
        "SYSTEM_ALERT",
      ],
      index: true,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    is_read: {
      type: Boolean,
      default: false,
      index: true,
    },
    read_at: {
      type: Date,
      default: null,
    },
    // Track reads for broadcast notifications by multiple staff
    read_by: [
      {
        staff_id:   { type: mongoose.Schema.Types.ObjectId, refPath: "recipient_model" },
        read_at:    { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Pre-save hook to keep user_id and recipient_id synced for backwards compatibility
notificationSchema.pre("save", function (next) {
  if (this.recipient_id && !this.user_id && this.recipient_model === "User") {
    this.user_id = this.recipient_id;
  } else if (this.user_id && !this.recipient_id) {
    this.recipient_id = this.user_id;
    this.recipient_model = "User";
  }
  next();
});

// High-speed compound indexes for queries
notificationSchema.index({ recipient_id: 1, is_read: 1, createdAt: -1 });
notificationSchema.index({ user_id: 1, is_read: 1, createdAt: -1 });
notificationSchema.index({ target_audience: 1, createdAt: -1 });
notificationSchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
