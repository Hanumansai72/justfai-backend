/**
 * AppRelease.model.js
 * Manages mobile app APK / bundle releases hosted on Cloudflare R2
 */
const mongoose = require("mongoose");

const appReleaseSchema = new mongoose.Schema(
  {
    version: {
      type: String,
      required: [true, "App version is required"],
      unique: true,
      trim: true,
    },
    build_number: {
      type: Number,
      required: [true, "Build number is required"],
    },
    platform: {
      type: String,
      enum: ["android", "ios"],
      default: "android",
      index: true,
    },
    channel: {
      type: String,
      enum: ["stable", "beta", "alpha"],
      default: "stable",
      index: true,
    },
    min_supported_version: {
      type: String,
      trim: true,
      default: null,
    },
    is_mandatory: {
      type: Boolean,
      default: false,
    },
    release_notes: {
      type: String,
      trim: true,
      default: "",
    },
    file_url: {
      type: String,
      required: [true, "APK download URL is required"],
      trim: true,
    },
    file_size_bytes: {
      type: Number,
      default: 0,
    },
    checksum_sha256: {
      type: String,
      trim: true,
    },
    downloads_count: {
      type: Number,
      default: 0,
    },
    is_active: {
      type: Boolean,
      default: true,
      index: true,
    },
    released_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    release_date: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

appReleaseSchema.index({ platform: 1, channel: 1, is_active: 1, build_number: -1 });

module.exports = mongoose.model("AppRelease", appReleaseSchema);
