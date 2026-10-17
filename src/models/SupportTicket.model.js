/**
 * SupportTicket.model.js
 * Customer support ticket raised by a user, optionally linked to a device.
 * Messages are embedded sub-documents (no separate collection — avoids extra joins).
 */
const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    sender_id:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sender_role: { type: String, enum: ["USER", "ADMIN"], required: true },
    body:        { type: String, required: true, trim: true },
    attachments: [{ type: String }], // URLs
  },
  { timestamps: true, _id: true }
);

const supportTicketSchema = new mongoose.Schema(
  {
    // Auto-generated readable ticket reference; existing references stay valid.
    ticket_number: {
      type: String,
      unique: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    device_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Device",
      default: null,
    },
    category: {
      type: String,
      enum: ["device_problem", "connection_issue", "navigation_issue", "firmware_problem", "account_problem", "contact_support", "feedback", "general"],
      default: "general",
      index: true,
    },
    subject: {
      type: String,
      required: [true, "Subject is required"],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    help_article_id: { type: String },
    diagnostics: {
      type: new mongoose.Schema({
        app_version: { type: String, maxlength: 80 },
        firmware_version: { type: String, maxlength: 80 },
        phone_model: { type: String, maxlength: 160 },
        platform: { type: String, maxlength: 80 },
        os_version: { type: String, maxlength: 80 },
        error_code: { type: String, maxlength: 160 },
        consented_at: { type: Date, required: true },
      }, { _id: false }),
      default: undefined,
    },
    status: {
      type: String,
      enum: ["open", "in_progress", "resolved", "closed"],
      default: "open",
      index: true,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
      index: true,
    },
    assigned_to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",  // Admin user
      default: null,
    },
    // Embedded messages — no separate collection needed for a support chat
    messages: [messageSchema],
    resolved_at: { type: Date, default: null },
    closed_at:   { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Auto-generate ticket_number before first save
supportTicketSchema.pre("save", async function () {
  if (!this.ticket_number) {
    // Independent requests must not derive the same number from a row count.
    this.ticket_number = `TKT-${require('node:crypto').randomBytes(8).toString('hex').toUpperCase()}`;
  }
});

// Dashboard query: open tickets by priority, newest first
supportTicketSchema.index({ status: 1, priority: -1, createdAt: -1 });
// Per-user ticket history
supportTicketSchema.index({ user_id: 1, createdAt: -1 });
// Admin assignment view
supportTicketSchema.index({ assigned_to: 1, status: 1 });

supportTicketSchema.plugin(require('./plugins/invalidateAdminCache'), { groups: ['support', 'dashboard'] });

module.exports = mongoose.model("SupportTicket", supportTicketSchema);
