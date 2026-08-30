/**
 * controllers/savedAddressController.js
 *
 * Query optimisation notes:
 *   - getAddressById / updateAddress / deleteAddress: ownership check FUSED into the
 *     findOne query using { _id, user_id } — eliminates a separate JS comparison
 *     and a potential TOCTOU race condition.
 *   - getAllAddresses: .lean() for read-only list + compound index on SavedAddress model
 *   - updateAddress: atomic findOneAndUpdate instead of fetch-then-mutate-save
 */
const SavedAddress = require("../models/Saved_address.model");

/**
 * Normalise coordinate input into a GeoJSON Point.
 * Accepts: GeoJSON object | [lng, lat] array | { lat, lng } object | flat lat/lng fields.
 */
const parseCoordinates = (coords, lat, lng) => {
  if (coords?.type === "Point" && Array.isArray(coords.coordinates)) return coords;

  if (Array.isArray(coords) && coords.length === 2) {
    const [lo, la] = coords.map(Number);
    if (!isNaN(lo) && !isNaN(la)) return { type: "Point", coordinates: [lo, la] };
  }

  if (coords && typeof coords === "object") {
    const la = Number(coords.latitude ?? coords.lat);
    const lo = Number(coords.longitude ?? coords.lng);
    if (!isNaN(la) && !isNaN(lo)) return { type: "Point", coordinates: [lo, la] };
  }

  if (lat !== undefined && lng !== undefined) {
    const la = Number(lat);
    const lo = Number(lng);
    if (!isNaN(la) && !isNaN(lo)) return { type: "Point", coordinates: [lo, la] };
  }

  return null;
};

// ─────────────────────────────────────────────
// @desc    Add a new saved address
// @route   POST /api/addresses
// @access  Private
// ─────────────────────────────────────────────
exports.createAddress = async (req, res, next) => {
  try {
    const { label, address, coords, latitude, longitude, lat, lng } = req.body;

    if (!label) {
      return res.status(400).json({ success: false, message: "Provide a label (e.g. Home, Work)" });
    }

    const parsedCoords = parseCoordinates(coords, latitude ?? lat, longitude ?? lng);
    if (!parsedCoords) {
      return res.status(400).json({
        success: false,
        message: "Provide valid coordinates: [lng, lat] or { latitude, longitude }",
      });
    }

    const newAddress = await SavedAddress.create({
      user_id: req.user._id,
      label,
      address,
      coords: parsedCoords,
    });

    res.status(201).json({ success: true, message: "Address saved successfully", data: newAddress });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get all saved addresses for current user
// @route   GET /api/addresses
// @access  Private
// ─────────────────────────────────────────────
exports.getAllAddresses = async (req, res, next) => {
  try {
    /**
     * OPTIMISATION: .lean() for read-only list — plain JS objects, ~2–3× faster.
     * Hits compound index { user_id: 1, createdAt: -1 } on SavedAddress model.
     */
    const addresses = await SavedAddress.find({ user_id: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({ success: true, count: addresses.length, data: addresses });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get a single saved address by ID
// @route   GET /api/addresses/:id
// @access  Private
// ─────────────────────────────────────────────
exports.getAddressById = async (req, res, next) => {
  try {
    /**
     * OPTIMISATION: single query with { _id, user_id } fuses the findById + ownership
     * check into ONE round-trip. Previously this was findById() then an if() compare.
     * Returns 404 for "not found" AND "not owned" — prevents resource enumeration.
     */
    const address = await SavedAddress.findOne({
      _id:     req.params.id,
      user_id: req.user._id,
    }).lean();

    if (!address) {
      return res.status(404).json({ success: false, message: "Address not found" });
    }

    res.status(200).json({ success: true, data: address });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Update a saved address
// @route   PUT /api/addresses/:id
// @access  Private
// ─────────────────────────────────────────────
exports.updateAddress = async (req, res, next) => {
  try {
    const { label, address: addressText, coords, latitude, longitude, lat, lng } = req.body;

    const updates = {};
    if (label        !== undefined) updates.label   = label;
    if (addressText  !== undefined) updates.address = addressText;

    const hasCoordInput = coords !== undefined || latitude !== undefined ||
                          longitude !== undefined || lat !== undefined || lng !== undefined;

    if (hasCoordInput) {
      const parsedCoords = parseCoordinates(coords, latitude ?? lat, longitude ?? lng);
      if (!parsedCoords) {
        return res.status(400).json({ success: false, message: "Invalid coordinates format" });
      }
      updates.coords = parsedCoords;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: "No updatable fields provided" });
    }

    /**
     * OPTIMISATION: findOneAndUpdate with { _id, user_id } simultaneously checks
     * ownership and performs the update atomically — no fetch + save double trip.
     * Returns null if not found OR not owned (prevents enumeration).
     */
    const updated = await SavedAddress.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user._id },
      { $set: updates },
      { new: true, runValidators: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({ success: false, message: "Address not found" });
    }

    res.status(200).json({ success: true, message: "Address updated successfully", data: updated });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Delete a saved address
// @route   DELETE /api/addresses/:id
// @access  Private
// ─────────────────────────────────────────────
exports.deleteAddress = async (req, res, next) => {
  try {
    /**
     * OPTIMISATION: deleteOne with compound filter { _id, user_id } is a single
     * atomic operation — no find-then-delete pattern needed.
     * If deletedCount === 0, either the doc doesn't exist or the user doesn't own it.
     */
    const result = await SavedAddress.deleteOne({
      _id:     req.params.id,
      user_id: req.user._id,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Address not found" });
    }

    res.status(200).json({ success: true, message: "Address deleted successfully" });
  } catch (error) {
    next(error);
  }
};
