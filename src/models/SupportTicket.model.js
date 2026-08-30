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
    // Auto-generated readable ticket number e.g. TKT-000042
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
      enum: ["device_problem", "connection_issue", "contact_support", "feedback", "general"],
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
supportTicketSchema.pre("save", async function (next) {
  if (!this.ticket_number) {
    const count = await mongoose.model("SupportTicket").countDocuments();
    this.ticket_number = `TKT-${String(count + 1).padStart(6, "0")}`;
  }
  next();
});

// Dashboard query: open tickets by priority, newest first
supportTicketSchema.index({ status: 1, priority: -1, createdAt: -1 });
// Per-user ticket history
supportTicketSchema.index({ user_id: 1, createdAt: -1 });
// Admin assignment view
supportTicketSchema.index({ assigned_to: 1, status: 1 });

module.exports = mongoose.model("SupportTicket", supportTicketSchema);
