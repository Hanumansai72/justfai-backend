/**
 * Helper.model.js
 * Dedicated model for Customer Care, Technical Support, and Field Operations Staff.
 *
 * Tracks:
 *   - Corporate Employee ID (e.g. EMP-10042)
 *   - Department & Technical Specialization (BLE, Hardware, Account Recovery)
 *   - Ticket Resolution & Assignment Metrics
 *   - Independent Security Credentials & Audit Session Tokens
 */
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const helperSchema = new mongoose.Schema(
  {
    employee_id: {
      type: String,
      required: [true, "Employee ID is required"],
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, "Employee name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Corporate email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    username: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [6, "Password must be at least 6 characters"],
      select: false,
    },
    phonenumber: {
      type: String,
      trim: true,
      default: null,
    },


    role: {
      type: String,
      enum: ["HELPER", "SENIOR_HELPER", "LEAD_SUPPORT"],
      default: "HELPER",
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "on_leave", "suspended", "terminated"],
      default: "active",
      index: true,
    },
    status_reason: {
      type: String,
      trim: true,
      default: null,
    },
    assigned_tickets_count: {
      type: Number,
      default: 0,
    },
    resolved_tickets_count: {
      type: Number,
      default: 0,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // Super Admin who provisioned this staff account
      default: null,
    },
    last_login_at: {
      type: Date,
      default: null,
    },
    last_login_ip: {
      type: String,
      default: null,
    },
    refresh_tokens: {
      type: [
        {
          token: { type: String, required: true },
          created_at: { type: Date, default: Date.now },
        },
      ],
      select: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Encrypt password before saving
helperSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) {
    return;
  }
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

// Match password helper
helperSchema.methods.matchPassword = async function (enteredPassword) {
  if (!this.password) return false;
  return await bcrypt.compare(enteredPassword, this.password);
};

// Compound index for active staff by role & status
helperSchema.index({ role: 1, status: 1 });

module.exports = mongoose.model("Helper", helperSchema);
