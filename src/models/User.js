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
    },
    // Admin-controlled lifecycle state
    status: {
      type: String,
      enum: ["active", "suspended", "banned"],
      default: "active",
      index: true,
    },
    status_reason: {
      type: String,
      trim: true,
      default: null,
    },
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

// Encrypt password before saving (only if password exists and is modified)
userSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) {
    return next();
  }

  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
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

module.exports = mongoose.model("User", userSchema);


