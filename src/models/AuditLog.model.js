const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    category: {
      type: String,
      required: true,
      enum: ["AUTH", "DEVICE", "FIRMWARE", "ADMIN", "SECURITY", "SYSTEM"],
    },
    action:    { type: String, required: true, trim: true },
    status:    { type: String, enum: ["SUCCESS", "FAILURE", "BLOCKED", "WARNING"], default: "SUCCESS" },
    resource_type: {
      type: String,
      enum: ["User", "Helper", "Device", "Firmware", "AppRelease", "Address", "System"],
      default: "System",
    },
    resource_id: { type: String, default: null },
    ip_address:  { type: String },
    user_agent:  { type: String },
    metadata:    { type: mongoose.Schema.Types.Mixed, default: {} },
    message:     { type: String, trim: true },
  },
  {
    timestamps: true,
    // Disable version key — audit logs are append-only, no updates needed
    versionKey: false,
  }
);

/**
 * Index strategy for a WRITE-HEAVY append-only collection:
 *   - Keep only indexes that serve real dashboard/alert queries
 *   - Every index slows down writes; don't add indexes speculatively
 *
 * Compound: (category, status, createdAt) → powers filtered audit dashboards
 * Single:   user_id               → per-user audit trail lookups
 * Single:   ip_address            → abuse / anomaly detection queries
 *
 * No index on `action` alone — it's always queried alongside category.
 */
auditLogSchema.index({ category: 1, status: 1, createdAt: -1 });
auditLogSchema.index({ user_id: 1, createdAt: -1 });
auditLogSchema.index({ resource_type: 1, resource_id: 1, createdAt: -1, _id: -1 });
auditLogSchema.index({ ip_address: 1, createdAt: -1 });
auditLogSchema.index({ 'metadata.source': 1, createdAt: -1 });

// MongoDB expires each record seven days after it was created.
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
