/**
 * queues/notification.queue.js
 * BullMQ Producer for Real-Time & Background User & Staff Notification Jobs.
 *
 * Implements:
 *   - Priority Queuing (Urgent tickets and security alerts get Priority 1)
 *   - Exponential Backoff Retries (3 attempts: 2s, 4s, 8s)
 *   - Staff & Admin Notifications for new support tickets and critical events
 *   - Zero-Downtime Direct Database Fallback if Redis is Offline
 */
const { Queue } = require("bullmq");
const { redisConfig, isRedisConnected } = require("../config/redis");
const Notification = require("../models/Notification.model");

const QUEUE_NAME = "notification-queue";

let notificationQueue = null;

if (process.env.ENABLE_REDIS === "true") {
  try {
    notificationQueue = new Queue(QUEUE_NAME, {
      connection: redisConfig,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 2000,
        },
        removeOnComplete: {
          age: 86400, // 24 hours
          count: 1000,
        },
        removeOnFail: {
          age: 604800, // 7 days
        },
      },
    });
  } catch (err) {
    console.warn("[Queue:Notification] Initialization failed, using direct mode:", err.message);
  }
}

/**
 * Dispatch customer notification job.
 */
const enqueueNotification = async ({ user_id, type, title, message, data = {} }) => {
  if (notificationQueue && isRedisConnected()) {
    try {
      const job = await notificationQueue.add(
        type,
        {
          recipient_id: user_id,
          user_id,
          recipient_model: "User",
          target_audience: "INDIVIDUAL",
          type,
          title,
          message,
          data,
          timestamp: new Date(),
        },
        { priority: type === "SECURITY_ALERT" ? 1 : 3 }
      );
      return { queued: true, jobId: job.id };
    } catch (err) {
      console.warn(`[Queue:Notification] Enqueue failed: ${err.message}. Falling back.`);
    }
  }

  // Graceful direct write fallback
  try {
    const doc = await Notification.create({
      recipient_id: user_id,
      user_id,
      recipient_model: "User",
      target_audience: "INDIVIDUAL",
      type,
      title,
      message,
      data,
    });
    return { queued: false, direct: true, id: doc._id };
  } catch (err) {
    console.error("[Queue:Notification] Direct write fallback error:", err.message);
    return null;
  }
};

/**
 * Dispatch Staff / Admin notification job (for new tickets, replies, and system alerts).
 *
 * @param {Object} options
 * @param {string} options.type - "NEW_SUPPORT_TICKET" | "TICKET_ASSIGNED" | "TICKET_CUSTOMER_REPLY" | "DEVICE_CRITICAL_ALERT" | "SYSTEM_ALERT"
 * @param {string} options.title
 * @param {string} options.message
 * @param {Object} [options.data]
 * @param {string} [options.priority="medium"] - "low" | "medium" | "high" | "urgent"
 * @param {string} [options.target_audience="ALL_STAFF"] - "ALL_STAFF" | "ADMIN_ONLY" | "HELPER_ONLY" | "INDIVIDUAL"
 * @param {string} [options.recipient_id] - Target specific Helper / Admin ObjectId
 * @param {string} [options.recipient_model="Helper"] - "Helper" | "User"
 */
const enqueueStaffNotification = async ({
  type,
  title,
  message,
  data = {},
  priority = "medium",
  target_audience = "ALL_STAFF",
  recipient_id = null,
  recipient_model = "Helper",
}) => {
  const priorityMap = { urgent: 1, high: 2, medium: 3, low: 4 };
  const queuePriority = priorityMap[priority] || 3;

  if (notificationQueue && isRedisConnected()) {
    try {
      const job = await notificationQueue.add(
        type,
        {
          recipient_id,
          recipient_model,
          target_audience,
          type,
          title,
          message,
          data,
          priority,
          timestamp: new Date(),
        },
        { priority: queuePriority }
      );
      return { queued: true, jobId: job.id };
    } catch (err) {
      console.warn(`[Queue:StaffNotification] Enqueue failed: ${err.message}. Falling back.`);
    }
  }

  // Graceful direct write fallback
  try {
    const doc = await Notification.create({
      recipient_id,
      recipient_model,
      target_audience,
      type,
      title,
      message,
      data,
      priority,
    });
    return { queued: false, direct: true, id: doc._id };
  } catch (err) {
    console.error("[Queue:StaffNotification] Direct write fallback error:", err.message);
    return null;
  }
};

/**
 * Convenient Helper: Notify all staff and admins of a newly submitted support ticket.
 */
const notifyNewTicket = async ({ ticket, customer, device = null }) => {
  const isUrgent = ticket.priority === "critical" || ticket.priority === "high";

  return await enqueueStaffNotification({
    type: "NEW_SUPPORT_TICKET",
    title: `New Ticket [${ticket.ticket_number}]: ${ticket.subject}`,
    message: `Customer ${customer.name || customer.email} submitted a ${ticket.category} ticket: "${ticket.description.slice(0, 100)}..."`,
    data: {
      ticket_id:      ticket._id,
      ticket_number:  ticket.ticket_number,
      category:       ticket.category,
      priority:       ticket.priority,
      customer_id:    customer._id || customer.id,
      customer_name:  customer.name,
      customer_email: customer.email,
      device_id:      device?.device_id || device?.BLE_ADDRESS || null,
    },
    priority: isUrgent ? "urgent" : "medium",
    target_audience: "ALL_STAFF",
  });
};

/**
 * Convenient Helper: Notify assigned helper or support team when customer replies in ticket.
 */
const notifyTicketReply = async ({ ticket, customer, messageText }) => {
  return await enqueueStaffNotification({
    type: "TICKET_CUSTOMER_REPLY",
    title: `Reply on Ticket [${ticket.ticket_number}]`,
    message: `${customer.name || "Customer"} replied: "${messageText.slice(0, 120)}..."`,
    data: {
      ticket_id:     ticket._id,
      ticket_number: ticket.ticket_number,
      customer_id:   customer._id || customer.id,
    },
    priority: ticket.priority === "critical" ? "urgent" : "high",
    target_audience: ticket.assigned_to ? "INDIVIDUAL" : "ALL_STAFF",
    recipient_id: ticket.assigned_to || null,
    recipient_model: "Helper",
  });
};

/**
 * Convenient Helper: Notify admins of hardware critical alerts (e.g. tampering, repeated failed auth).
 */
const notifyDeviceCriticalAlert = async ({ device, reason, alertType = "DEVICE_CRITICAL_ALERT" }) => {
  return await enqueueStaffNotification({
    type: "DEVICE_CRITICAL_ALERT",
    title: `Critical Alert: Device ${device.device_id || device.BLE_ADDRESS}`,
    message: `Hardware security alert: ${reason}`,
    data: {
      device_id:   device._id,
      hardware_id: device.device_id,
      ble_address: device.BLE_ADDRESS,
      owner_id:    device.linked_to,
      reason,
    },
    priority: "urgent",
    target_audience: "ADMIN_ONLY",
  });
};

module.exports = {
  notificationQueue,
  enqueueNotification,
  enqueueStaffNotification,
  notifyNewTicket,
  notifyTicketReply,
  notifyDeviceCriticalAlert,
};
