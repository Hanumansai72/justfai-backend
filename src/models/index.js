/**
 * models/index.js
 * Centralized Model Registry for JustRide Backend.
 *
 * Clean architectural export point for all Mongoose models.
 */
module.exports = {
  User:            require("./User"),
  Helper:          require("./Helper.model"),
  Device:          require("./device.model"),
  SupportTicket:   require("./SupportTicket.model"),
  SavedAddress:    require("./Saved_address.model"),
  Notification:    require("./Notification.model"),
  FirmwareRelease: require("./FirmwareRelease.model"),
  FirmwareHistory: require("./FirmwareHistory.model"),
  AuditLog:        require("./AuditLog.model"),
};
