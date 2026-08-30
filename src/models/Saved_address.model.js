const mongoose = require("mongoose");

const savedAddressSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User ID is required"],
    },
    label: {
      type: String,
      required: [true, "Label is required (e.g., Home, Work, Other)"],
      trim: true,
    },
    address: {
      type: String,
      trim: true,
    },
    coords: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
        required: true,
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: [true, "Coordinates [longitude, latitude] are required"],
      },
    },
  },
  { timestamps: true }
);

// Geospatial index for nearest-neighbor / within-radius queries
savedAddressSchema.index({ coords: "2dsphere" });

/**
 * Compound index for the primary list query:
 *   SavedAddress.find({ user_id }).sort({ createdAt: -1 })
 * Covers both the filter and the sort in a single index scan.
 */
savedAddressSchema.index({ user_id: 1, createdAt: -1 });

module.exports = mongoose.model("Saved_address", savedAddressSchema);
