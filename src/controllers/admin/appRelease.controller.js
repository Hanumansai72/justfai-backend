const { waitUntil } = require('@vercel/functions');
/**
 * ============================================================================
 * CONTROLLER: appRelease.controller.js
 * ============================================================================
 * Directory: Backend/src/controllers/admin/appRelease.controller.js
 *
 * PURPOSE FOR BEGINNERS:
 * This controller manages Android APK releases for the JustRide mobile app.
 * It handles:
 *  1. Direct uploads to Cloudflare R2 via Presigned URLs (bypassing server upload limits).
 *  2. Registering new app releases in MongoDB with version validation.
 *  3. Listing releases with pagination and filtering.
 *  4. Updating release notes, mandatory flags, and active states.
 *  5. Deleting releases with security audit logs.
 *  6. Setting a "Featured" release (the official recommended version).
 *  7. Checking for newer APK updates when the mobile app opens on a rider's phone.
 *
 * KEY CONCEPTS USED:
 *  - Cloudflare R2: S3-compatible cloud storage with $0 egress (download) fees.
 *  - Presigned URL: A temporary authorized link allowing the browser to upload
 *    directly to cloud storage without sending the 50MB file through this backend.
 *  - Vercel 4.5MB limit: Serverless hosting restricts payload sizes to 4.5MB.
 *  - SHA-256: A cryptographic fingerprint to ensure the downloaded APK is not corrupted.
 *  - Mongoose .lean(): Returns raw JS objects instead of heavy Mongoose documents for speed.
 *  - Mongoose .populate(): Replaces an ObjectId with the actual referenced user document.
 * ============================================================================
 */

// Model representing the 'appreleases' collection in MongoDB
const AppRelease      = require("../../models/AppRelease.model");

// Security audit logger: keeps an immutable history of who did what and when
const audit           = require("../../security/auditLogger");

// Storage service: interacts with Cloudflare R2 (S3-compatible) using AWS SDK v3
const cloudflareR2    = require("../../services/cloudflareR2.service");

// Notification service: dispatches push alerts to riders when an update is published
const releaseNotifier = require("../../services/releaseNotification.service");

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 1: getUploadUrl
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @desc    Generate a Presigned URL for direct-to-cloud APK file upload
 * @route   POST /api/admin/app-releases/upload-url
 * @access  Private (Admin only)
 *
 * WHY THIS EXISTS:
 * Vercel and serverless hosts limit request bodies to 4.5MB. Mobile APKs are 30-100MB.
 * If an admin uploads a 50MB APK through our server, it crashes with HTTP 413.
 * Solution: We create a Presigned URL. The admin's browser uploads the file DIRECTLY
 * to Cloudflare R2. Our server never touches the heavy 50MB file!
 *
 * @param {Object} req.body
 * @param {string} req.body.filename - Original file name (e.g. "justride-v1.0.apk")
 * @param {string} [req.body.content_type] - MIME type of the file
 */
exports.getUploadUrl = async (req, res, next) => {
  try {
    // 1. Extract filename and content_type from the JSON request body
    const { filename, content_type } = req.body;

    // 2. Validation: We cannot generate a destination key without a filename
    if (!filename) {
      // 400 Bad Request: Tell the client they forgot a required field
      return res.status(400).json({ success: false, message: "filename is required" });
    }

    // 3. Sanitization (Regex): Replace all spaces and illegal characters with underscores
    //    /[^a-zA-Z0-9._-]/g matches any character that is NOT a letter, number, dot, or hyphen
    const cleanFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");

    // 4. Collision Prevention: Prefix the path with Date.now() (current millisecond timestamp)
    //    Example result: "apk/1726508900123-justride_v1.0.apk"
    //    This guarantees two files uploaded with the same name will never overwrite each other
    const r2Key = `apk/${Date.now()}-${cleanFilename}`;

    // 5. MIME Type: Standard Android package MIME type required for OS package installer
    const contentType = content_type || "application/vnd.android.package-archive";

    // 6. Request Cloudflare R2 to generate a temporary upload URL valid for 15 minutes
    const presigned = await cloudflareR2.getUploadPresignedUrl(r2Key, contentType);

    // 7. Send the upload URL back to the admin frontend
    res.status(200).json({
      success: true,
      data: presigned, // Contains: uploadUrl (PUT link), publicUrl (download link), fileName
    });
  } catch (error) {
    // Pass any unexpected runtime errors to Express global error handling middleware
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 2: createAppRelease
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @desc    Upload APK and publish a new mobile app release in the database
 * @route   POST /api/admin/app-releases
 * @access  Private (Admin only)
 *
 * WHAT THIS DOES:
 *  1. Validates version and build number.
 *  2. Checks MongoDB to ensure this version doesn't already exist for this platform.
 *  3. If a file was uploaded in this request, uploads it to Cloudflare R2.
 *  4. Creates the AppRelease document in MongoDB.
 *  5. Logs the action in the security audit database.
 *  6. Asynchronously notifies all mobile app riders that an update is available.
 *
 * @param {Object} req.body - Release metadata (version, build_number, platform, etc.)
 * @param {Object} [req.file] - Optional binary file uploaded via Multer memory buffer
 */
exports.createAppRelease = async (req, res, next) => {
  try {
    // 1. Destructure release configuration fields from request body with safe defaults
    const {
      version,
      build_number,
      platform = "android",          // Defaults to "android" if not specified
      channel = "stable",            // Release channel: "stable", "beta", or "alpha"
      min_supported_version,         // Minimum old version allowed to still run
      is_mandatory = false,          // If true, app forces user to update before use
      release_notes = "",            // Changelog / what's new description
    } = req.body;

    // 2. Mutable variables for file attributes (can be filled via req.file OR req.body)
    let { file_url, checksum_sha256, file_size_bytes } = req.body;

    // 3. Validation: version and build_number are mandatory
    if (!version || !build_number) {
      return res.status(400).json({
        success: false,
        message: "Version and build_number are required",
      });
    }

    // 4. Version Normalization: Remove accidental whitespace and leading "v" or "V"
    //    Example: " v1.2.0 " -> "1.2.0"
    const cleanVersion = version.trim().replace(/^v/i, "");

    // 5. Duplicate Check: Prevent accidental duplicate version releases for the same platform
    //    AppRelease.exists() is faster than findOne() because it only reads the index
    const duplicate = await AppRelease.exists({
      version: cleanVersion,
      platform,
    });
    if (duplicate) {
      // 409 Conflict: Resource already exists
      return res.status(409).json({
        success: false,
        message: `App release v${cleanVersion} for ${platform} already exists`,
      });
    }

    // 6. Direct File Upload Support: If admin attached the file directly (multipart/form-data)
    if (req.file) {
      const fileName = `apk/justride-v${cleanVersion}-b${build_number}-${channel}.apk`;
      // Upload the memory buffer to Cloudflare R2
      const uploadRes = await cloudflareR2.uploadApk(req.file.buffer, fileName);
      file_url = uploadRes.url;
      checksum_sha256 = uploadRes.sha256;
      file_size_bytes = uploadRes.size;
    }

    // 7. Guard: An APK download URL is strictly required to publish a release
    if (!file_url) {
      return res.status(400).json({
        success: false,
        message: "An APK file or direct file_url is required",
      });
    }

    // 8. Insert the new release document into MongoDB
    const release = await AppRelease.create({
      version: cleanVersion,
      build_number: Number(build_number), // Safely cast string "42" to integer 42
      platform,
      channel,
      min_supported_version,
      // Boolean coercion: handles both boolean true/false and form-data strings "true"/"false"
      is_mandatory: is_mandatory === true || is_mandatory === "true",
      release_notes,
      file_url,
      file_size_bytes: file_size_bytes || 0,
      checksum_sha256,
      released_by: req.user._id, // Injected by authMiddleware (logged-in admin ID)
      release_date: new Date(),
      is_active: true,           // Immediately available
    });

    // 9. Security Audit Logging: Record who created this release for forensic compliance
    audit.log({
      req,
      category: "SYSTEM",
      action: "APP_RELEASE_CREATE",
      status: "SUCCESS",
      resource_type: "AppRelease",
      resource_id: release._id,
      message: `App APK release created: v${cleanVersion} (b${build_number}) -> Cloudflare R2`,
    });

    // 10. Fire-and-Forget Notification: Alert riders asynchronously without blocking HTTP response
    //     Notice: We do not use 'await' so the admin does not wait 10 seconds for pushes to send
    waitUntil(releaseNotifier.notifyAppRelease(release).catch((err) => {
      console.warn("[AppRelease] Notification dispatch error:", err.message);
    }));

    // 11. Send HTTP 201 Created with the saved release data
    res.status(201).json({
      success: true,
      message: "App release published successfully to Cloudflare R2",
      data: release,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 3: getAppReleases
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @desc    List all app releases with pagination & filtering
 * @route   GET /api/admin/app-releases
 * @access  Private (Admin or Helper role)
 *
 * WHAT THIS DOES:
 *  1. Reads filtering query parameters (?platform=android&channel=stable&is_active=true).
 *  2. Calculates pagination offset (skip).
 *  3. Executes count query and find query concurrently via Promise.all.
 *  4. Populates the admin's name and email who published the release.
 *  5. Returns paginated list with total page count.
 */
exports.getAppReleases = async (req, res, next) => {
  try {
    // 1. Extract query parameters with default pagination (page 1, 10 items per page)
    const { platform, channel, is_active } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(10, parseInt(req.query.limit, 10) || 10));
    const filter = {};

    // 2. Build dynamic MongoDB filter based on which query params were provided
    if (platform) filter.platform = platform;
    if (channel) filter.channel = channel;
    if (is_active !== undefined) filter.is_active = is_active === "true";

    // 3. Pagination Math: Calculate how many documents to skip
    //    Example: Page 1 -> skip 0; Page 2 -> skip 10
    //    Math.max(1, ...) ensures user cannot pass negative page numbers
    const skip = (page - 1) * limit;

    // 4. Performance Optimization: Run count and find queries IN PARALLEL with Promise.all
    const [total, releases] = await Promise.all([
      // Count total matching documents to calculate total pages
      AppRelease.countDocuments(filter),

      // Fetch the actual documents for this page
      AppRelease.find(filter)
        // Populate author information (like an SQL JOIN on the User model)
        .populate("released_by", "full_name email")
        // Show the newest uploaded releases first in the admin list.
        .sort({ createdAt: -1, _id: -1 })
        // Skip previous pages
        .skip(skip)
        // Limit to requested page size
        .limit(limit)
        // .lean() returns plain JS objects (3-5x faster, less memory)
        .lean(),
    ]);

    // 5. Send HTTP 200 OK with data and pagination metadata
    res.status(200).json({
      success: true,
      total,
      page,
      limit,
      // Math.ceil rounds up (e.g. 21 items / 20 per page = 2 pages)
      totalPages: Math.ceil(total / limit),
      data: releases,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 4: updateAppRelease
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @desc    Update an existing app release (toggle active / mandatory / notes)
 * @route   PUT /api/admin/app-releases/:id
 * @access  Private (Admin only)
 *
 * WHAT THIS DOES:
 *  Uses MongoDB's findByIdAndUpdate with conditional spread properties to only
 *  modify fields that were actually passed in req.body, preserving everything else.
 */
exports.updateAppRelease = async (req, res, next) => {
  try {
    // 1. Destructure updatable properties
    const { is_active, is_mandatory, release_notes, min_supported_version, channel } = req.body;

    // 2. Perform atomic update in MongoDB
    const release = await AppRelease.findByIdAndUpdate(
      req.params.id, // Release ID from URL path (:id)
      {
        $set: {
          // Conditional Spread Pattern:
          // If 'is_active' is undefined, (false && { is_active }) is false, spreading nothing.
          // If 'is_active' is provided, it adds { is_active: value } to the $set update!
          ...(is_active !== undefined && { is_active }),
          ...(is_mandatory !== undefined && { is_mandatory }),
          ...(release_notes !== undefined && { release_notes }),
          ...(min_supported_version !== undefined && { min_supported_version }),
          ...(channel !== undefined && { channel }),
        },
      },
      // Options:
      //  new: true -> Return the updated document instead of the old version
      //  runValidators: true -> Run schema validations (e.g. enum checks) on update
      { new: true, runValidators: true }
    );

    // 3. Handle document not found
    if (!release) {
      return res.status(404).json({ success: false, message: "App release not found" });
    }

    // 4. Return updated release
    res.status(200).json({
      success: true,
      message: "App release updated",
      data: release,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 5: deleteAppRelease
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @desc    Delete an app release from the database
 * @route   DELETE /api/admin/app-releases/:id
 * @access  Private (Admin only)
 *
 * WHAT THIS DOES:
 *  1. Checks if the release exists.
 *  2. Deletes the release document from MongoDB.
 *  3. Writes an entry to the audit log for accountability.
 */
exports.deleteAppRelease = async (req, res, next) => {
  try {
    // 1. Find the release by ID
    const release = await AppRelease.findById(req.params.id);
    if (!release) {
      return res.status(404).json({ success: false, message: "App release not found" });
    }

    // 2. Delete the document
    await AppRelease.deleteOne({ _id: release._id });

    // 3. Security Audit Trail: Record who deleted the release and its details
    audit.log({
      req,
      category: "SYSTEM",
      action: "APP_RELEASE_DELETE",
      status: "SUCCESS",
      resource_type: "AppRelease",
      resource_id: release._id,
      message: `App release v${release.version} (b${release.build_number}) deleted`,
    });

    // 4. Return success response
    res.status(200).json({ success: true, message: "App release deleted" });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 6: selectFeaturedRelease
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @desc    Set an app release as the Featured release shown on website and app
 * @route   PATCH /api/admin/app-releases/:id/feature
 * @access  Private (Admin only)
 *
 * WHAT THIS DOES:
 *  Business Rule: Only ONE release per platform can be 'is_featured' at any time.
 *  1. Unsets 'is_featured' on all OTHER releases for this platform ($ne = Not Equal).
 *  2. Sets 'is_featured = true' and 'is_active = true' on the chosen release.
 *  3. Broadcasts push notification to all riders about the new featured release.
 */
exports.selectFeaturedRelease = async (req, res, next) => {
  try {
    // 1. Find the target release by ID
    const release = await AppRelease.findById(req.params.id);
    if (!release) {
      return res.status(404).json({ success: false, message: "App release not found" });
    }

    // 2. Reset other releases: Unset any existing featured release for this platform
    //    $ne: release._id means "where ID is Not Equal to this release's ID"
    await AppRelease.updateMany(
      { platform: release.platform, _id: { $ne: release._id } },
      { $set: { is_featured: false } }
    );

    // 3. Promote this release to featured and ensure it is active
    release.is_featured = true;
    release.is_active = true;
    await release.save();

    // 4. Asynchronous Push Notification: Alert active mobile app users
    waitUntil(releaseNotifier.notifyAppRelease(release).catch((err) => {
      console.warn("[AppRelease] Notification dispatch error:", err.message);
    }));

    // 5. Send HTTP 200 OK
    res.status(200).json({
      success: true,
      message: `App release v${release.version} (Build #${release.build_number}) is now set as the Featured release for ${release.platform}!`,
      data: release,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 7: getLatestAppUpdate
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @desc    Public endpoint for mobile apps to check for latest APK updates
 * @route   GET /api/app-releases/latest?platform=android&current_build=12
 * @access  Public (Called by the mobile app on startup)
 *
 * HOW THE MOBILE APP USES THIS:
 *  1. Mobile app launches and calls: GET /api/app-releases/latest?current_build=12
 *  2. Server checks if an 'is_featured' release exists; if not, falls back to highest build_number.
 *  3. Server compares: is latest.build_number > current_build?
 *  4. Server responds with:
 *     - update_available: true / false
 *     - is_mandatory: true / false (if true, app locks until updated)
 *     - download_url: Direct Cloudflare R2 download link
 *     - checksum_sha256: File hash for download integrity verification
 */
exports.getLatestAppUpdate = async (req, res, next) => {
  try {
    // 1. Extract query parameters sent by the mobile app
    const { platform = "android", channel, current_build } = req.query;

    // 2. Step 1: Check if admin explicitly marked a release as 'is_featured'
    let latest = await AppRelease.findOne({
      platform,
      is_featured: true,
      is_active: true,
    }).lean();

    // 3. Step 2: Fallback — If no featured release is selected, pick the highest build_number
    if (!latest) {
      const filter = { platform, is_active: true };
      if (channel) filter.channel = channel;

      latest = await AppRelease.findOne(filter)
        .sort({ build_number: -1 }) // -1 = Descending order (highest build first)
        .lean();
    }

    // 4. Handle edge case: No active releases exist in the database
    if (!latest) {
      return res.status(200).json({
        success: true,
        update_available: false,
        message: "No active release found",
      });
    }

    // 5. Core Comparison Logic: Compare server build number with installed phone build number
    const currentB = Number(current_build) || 0;
    // Example: If server has build 15 and phone has build 12 -> 15 > 12 -> true
    const updateAvailable = latest.build_number > currentB;

    // 6. Return Public DTO (Data Transfer Object)
    //    We explicitly pick safe public fields and exclude sensitive server fields
    res.status(200).json({
      success: true,
      update_available: updateAvailable,
      data: {
        id: latest._id,
        version: latest.version,
        build_number: latest.build_number,
        platform: latest.platform,
        channel: latest.channel,
        is_mandatory: latest.is_mandatory,
        is_featured: !!latest.is_featured,
        release_notes: latest.release_notes,
        download_url: latest.file_url,
        file_size_bytes: latest.file_size_bytes,
        checksum_sha256: latest.checksum_sha256,
        release_date: latest.release_date,
      },
    });
  } catch (error) {
    next(error);
  }
};
