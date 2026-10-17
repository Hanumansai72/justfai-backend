const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    username: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      lowercase: true,
    },
    phonenumber: {
      type: String,
      unique: true,
      sparse: true, // Allows null/undefined without causing duplicate key collisions
      trim: true,
      set: require('../utils/normalizePhone'),
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      minlength: [6, "Password must be at least 6 characters"],
      select: false,
    },
    google_id: {
      type: String,
      unique: true,
      sparse: true,
    },
    avatar: {
      type: String,
    },
    auth_provider: {
      type: String,
      enum: ["local", "google"],
      default: "local",
    },
    role: {
      type: String,
      required: [true, "Role is required"],
      enum: ["ADMIN", "HELPER", "USER"],
      default: "USER",
      immutable: true,
    },
    // Admin-controlled lifecycle state
    status: {
      type: String,
      enum: ["active", "suspended", "banned", "deleted"],
      default: "active",
      index: true,
    },
    status_reason: {
      type: String,
      trim: true,
      default: null,
    },
    deleted_at: { type: Date },
    device_link_version: { type: Number, default: 0, select: false },
    deletion_otp_hash: { type: String, select: false },
    deletion_otp_nonce: { type: String, select: false },
    deletion_otp_expires: { type: Date, select: false },
    deletion_otp_sent_at: { type: Date, select: false },
    deletion_otp_attempts: { type: Number, default: 0, select: false },
    deletion_otp_ready: { type: Boolean, default: false, select: false },
    // Password reset fields
    password_reset_token: {
      type: String,
      select: false,
      index: true,
    },
    password_reset_expires: {
      type: Date,
      select: false,
    },
    // Whitelisted active refresh tokens (SHA-256 hashed for security)
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
  { timestamps: true }
);

// Only the already-provisioned admin may exist. Ordinary registration is USER-only.
userSchema.pre('save', function () {
  if (this.isNew && this.role === 'ADMIN') {
    const error = new Error('Admin account creation is disabled');
    error.statusCode = 403;
    throw error;
  }
});
userSchema.pre('insertMany', async function (documents) {
  if (documents.some(document => document.role === 'ADMIN') || this.modelName === 'Admin') {
    throw new Error('Admin account creation is disabled');
  }
});

userSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'], function () {
  const update = this.getUpdate() || {};
  if (['replaceOne', 'findOneAndReplace'].includes(this.op) ||
      Array.isArray(update) || update.role !== undefined || update.$set?.role !== undefined ||
      update.$setOnInsert?.role !== undefined || update.$unset?.role !== undefined ||
      update.$rename?.role !== undefined || Object.values(update.$rename || {}).includes('role') ||
      (this.getOptions().upsert && (this.model.modelName === 'Admin' || this.getFilter().role === 'ADMIN'))) {
    throw new Error('Account roles are fixed; admin account creation is disabled');
  }
});

userSchema.pre('bulkWrite', async function (operations) {
  // Account provisioning and credential updates use validated document saves.
  // Bulk role changes and replacement writes could bypass those protections.
  if (operations.some(operation => {
    const document = operation.insertOne?.document;
    const update = operation.updateOne || operation.updateMany;
    return operation.replaceOne || operation.deleteOne || operation.deleteMany ||
      (document && (document.role === 'ADMIN' || this.modelName === 'Admin')) ||
      (update && (update.upsert || Array.isArray(update.update) ||
        JSON.stringify(update.update).includes('"role"')));
  })) throw new Error('Bulk admin provisioning, role changes and account deletion are disabled');
});

userSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], function () {
  if (this.model.modelName === 'Admin') throw new Error('The sole admin cannot be deleted');
  this.where({ role: { $ne: 'ADMIN' } });
});

userSchema.index({ role: 1 }, {
  unique: true,
  partialFilterExpression: { role: 'ADMIN' },
  name: 'single_admin',
});

// Encrypt password before saving (only if password exists and is modified)
userSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) {
    return;
  }

  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

// Match user entered password to hashed password in database
userSchema.methods.matchPassword = async function (enteredPassword) {
  if (!this.password) return false;
  return await bcrypt.compare(enteredPassword, this.password);
};

// Generate and hash password reset token (valid for 15 minutes)
userSchema.methods.getResetPasswordToken = function () {
  const crypto = require("crypto");
  // Generate random 32-byte hex string (64 characters)
  const resetToken = crypto.randomBytes(32).toString("hex");

  // Hash token and set to password_reset_token field
  this.password_reset_token = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");

  // Set expiration to 15 minutes from now
  this.password_reset_expires = new Date(Date.now() + 15 * 60 * 1000);

  return resetToken;
};

// Customer lists always filter by role, optionally status, then sort newest first.
userSchema.index({ role: 1, createdAt: -1, _id: -1 });
userSchema.index({ role: 1, status: 1, createdAt: -1, _id: -1 });

userSchema.plugin(require('./plugins/invalidateAdminCache'), { groups: ['users', 'staff', 'devices', 'pairing', 'support', 'firmware', 'releases', 'dashboard'] });

module.exports = mongoose.model("User", userSchema);


