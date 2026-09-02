/**
 * releaseNotification.service.js
 * High-Performance Notification Dispatcher for Firmware & Mobile App APK Releases.
 *
 * Capabilities:
 *   - Batch / Bulk notification creation (insertMany) for low database overhead
 *   - Target filtering:
 *       • Firmware: Broadcasts to all users who own a paired IoT device
 *       • Mobile APK: Broadcasts to all active app users (role: 'USER')
 *   - Automatic device tracking flag updates (firmware_update_available: true)
 *   - Push Notification Hooks (FCM / APNs payload structure ready)
 */
const User         = require("../models/User");
const Device       = require("../models/device.model");
const Notification = require("../models/Notification.model");

/**
 * Dispatch firmware release notifications to all device owners
 *
 * @param {Object} release - The created/featured FirmwareRelease document
 */
exports.notifyFirmwareRelease = async (release) => {
  try {
    const versionStr = `v${release.version.replace(/^v/i, "")}`;
    const channelTag = release.channel ? ` (${release.channel.toUpperCase()})` : "";

    // 1. Find all distinct users who have an active paired device
    const pairedUserIds = await Device.distinct("linked_to", {
      is_paired: true,
      linked_to: { $ne: null },
    });

    if (!pairedUserIds || pairedUserIds.length === 0) {
      console.log("[ReleaseNotifier] No paired device users found to notify for firmware release.");
      return { sent: 0 };
    }

    const title = `New Firmware Update Available: ${versionStr}${channelTag}`;
    const message = release.release_notes
      ? `Firmware ${versionStr} is now ready for your JustRide device: ${release.release_notes}`
      : `Firmware ${versionStr} is ready. Connect your device via Bluetooth in the mobile app to update.`;

    // 2. Prepare bulk notification documents
    const notifications = pairedUserIds.map((userId) => ({
      recipient_id: userId,
      user_id: userId,
      recipient_model: "User",
      target_audience: "INDIVIDUAL",
      type: "FIRMWARE_UPDATE",
      priority: release.channel === "stable" ? "high" : "medium",
      title,
      message,
      data: {
        firmware_id: release._id,
        version: release.version,
        channel: release.channel,
        file_url: release.file_url,
        checksum: release.checksum,
        is_mandatory: !!release.min_supported_version,
      },
      is_read: false,
    }));

    // 3. Perform atomic bulk insert
    const result = await Notification.insertMany(notifications, { ordered: false });

    // 4. Mark active devices as having a firmware update available
    await Device.updateMany(
      { is_paired: true, linked_to: { $ne: null } },
      {
        $set: {
          latest_firmware: release.version,
          firmware_update_available: true,
          last_firmware_check: new Date(),
        },
      }
    );

    console.log(`[ReleaseNotifier] Successfully dispatched firmware notification for ${versionStr} to ${result.length} device owners.`);
    return { sent: result.length };
  } catch (err) {
    console.error("[ReleaseNotifier] Error broadcasting firmware release notification:", err.message);
    return { error: err.message };
  }
};

/**
 * Dispatch mobile app APK release notifications to all active users
 *
 * @param {Object} release - The created/featured AppRelease document
 */
exports.notifyAppRelease = async (release) => {
  try {
    const versionStr = `v${release.version.replace(/^v/i, "")}`;
    const buildTag = release.build_number ? ` (Build #${release.build_number})` : "";

    // 1. Find all active end-users
    const users = await User.find({ role: "USER", status: "active" })
      .select("_id name email")
      .lean();

    if (!users || users.length === 0) {
      console.log("[ReleaseNotifier] No active users found to notify for app release.");
      return { sent: 0 };
    }

    const title = `New JustRide App Update: ${versionStr}${buildTag}`;
    const message = release.release_notes
      ? `A new mobile app version is available: ${release.release_notes}`
      : `JustRide ${versionStr} is now available. Download the new update for improved performance and features.`;

    // 2. Prepare bulk notification documents
    const notifications = users.map((user) => ({
      recipient_id: user._id,
      user_id: user._id,
      recipient_model: "User",
      target_audience: "INDIVIDUAL",
      type: "APP_UPDATE",
      priority: release.is_mandatory ? "urgent" : "high",
      title,
      message,
      data: {
        app_release_id: release._id,
        version: release.version,
        build_number: release.build_number,
        platform: release.platform,
        channel: release.channel,
        download_url: release.file_url,
        file_size_bytes: release.file_size_bytes,
        is_mandatory: !!release.is_mandatory,
      },
      is_read: false,
    }));

    // 3. Perform atomic bulk insert
    const result = await Notification.insertMany(notifications, { ordered: false });

    console.log(`[ReleaseNotifier] Successfully dispatched app APK release notification for ${versionStr} to ${result.length} users.`);
    return { sent: result.length };
  } catch (err) {
    console.error("[ReleaseNotifier] Error broadcasting app release notification:", err.message);
    return { error: err.message };
  }
};
