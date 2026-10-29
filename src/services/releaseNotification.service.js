const isNewerVersion = require('../utils/isNewerVersion');
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
 *   - Android notification-bar delivery through Firebase Cloud Messaging
 */
const User         = require("../models/User");
const Device       = require("../models/device.model");
const Notification = require("../models/Notification.model");
const push = require('./pushNotification.service');

/**
 * Dispatch firmware release notifications to all device owners
 *
 * @param {Object} release - The created/featured FirmwareRelease document
 */
exports.notifyFirmwareRelease = async (release) => {
  try {
    if (release.channel !== 'stable') return { sent: 0, skipped: 'NON_STABLE_RELEASE' };
    const versionStr = `v${release.version.replace(/^v/i, "")}`;

    // 1. Find all distinct users who have an active paired device
    const eligibleDevices = await Device.find({ is_paired: true, is_active: true,
      is_blocked: { $ne: true }, is_retired: { $ne: true }, linked_to: { $ne: null } })
      .select('_id linked_to firmware_version latest_firmware device_type').lean();
    const targets = eligibleDevices.filter(device =>
      (!release.device_type || device.device_type === release.device_type) &&
      isNewerVersion(device.firmware_version, release.version) &&
      (!device.latest_firmware || device.latest_firmware === release.version || isNewerVersion(device.latest_firmware, release.version)));
    const owners = targets.map(device => device.linked_to);
    const pairedUserIds = await User.distinct('_id', { _id: { $in: owners }, role: 'USER', status: 'active' });
    if (!pairedUserIds || pairedUserIds.length === 0) {
      console.log("[ReleaseNotifier] No paired device users found to notify for firmware release.");
      return { sent: 0 };
    }

    const title = 'JustRide firmware update';
    const message = 'A new update is available. Please update your JustRide device.';

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
    const activeOwners = new Set(pairedUserIds.map(String));
    await Device.bulkWrite(targets.filter(device => activeOwners.has(String(device.linked_to))).map(device => ({
      updateOne: {
        filter: { _id: device._id, linked_to: device.linked_to, is_paired: true, is_active: true,
          is_blocked: { $ne: true }, is_retired: { $ne: true },
          firmware_version: device.firmware_version ?? null, latest_firmware: device.latest_firmware ?? null },
        update: { $set: { latest_firmware: release.version, firmware_update_available: true, last_firmware_check: new Date() } },
      },
    })));


    console.log(`[ReleaseNotifier] Successfully dispatched firmware notification for ${versionStr} to ${result.length} device owners.`);
    const delivery = await push.sendToUsers(pairedUserIds, { title, message, type: 'FIRMWARE_UPDATE', releaseId: release._id });
    return { sent: result.length, push: delivery };
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
    if (release.channel !== 'stable') return { sent: 0, skipped: 'NON_STABLE_RELEASE' };
    const versionStr = `v${release.version.replace(/^v/i, "")}`;

    // 1. Find all active end-users
    const users = await User.find({ role: "USER", status: "active" })
      .select("_id name email")
      .lean();

    if (!users || users.length === 0) {
      console.log("[ReleaseNotifier] No active users found to notify for app release.");
      return { sent: 0 };
    }

    const title = 'JustRide app update';
    const message = 'A new update is available. Please update the JustRide app.';

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
    const delivery = release.platform === 'android'
      ? await push.sendToUsers(users.map((user) => user._id), { title, message, type: 'APP_UPDATE', releaseId: release._id })
      : { configured: push.isConfigured(), registered: 0, accepted: 0, failed: 0 };
    return { sent: result.length, push: delivery };
  } catch (err) {
    console.error("[ReleaseNotifier] Error broadcasting app release notification:", err.message);
    return { error: err.message };
  }
};
