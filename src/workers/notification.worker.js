/**
 * workers/notification.worker.js
 * BullMQ Consumer for Customer & Staff Notification Jobs.
 *
 * Responsibilities:
 *   - Persist notifications to MongoDB Notification collection
 *   - Route staff notifications based on target_audience (ALL_STAFF, ADMIN_ONLY, INDIVIDUAL)
 *   - Dispatch external notification webhooks (FCM push, SendGrid, Slack alerts)
 */
const { Worker } = require("bullmq");
const { redisConfig } = require("../config/redis");
const Notification = require("../models/Notification.model");

const QUEUE_NAME = "notification-queue";

let notificationWorker = null;

const startNotificationWorker = () => {
  if (process.env.ENABLE_REDIS === "false") return null;

  try {
    notificationWorker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const {
          recipient_id,
          user_id,
          recipient_model = "User",
          target_audience = "INDIVIDUAL",
          type,
          title,
          message,
          data = {},
          priority = "medium",
        } = job.data;

        // 1. Persist notification to database
        const notification = await Notification.create({
          recipient_id: recipient_id || user_id || null,
          user_id:      user_id || (recipient_model === "User" ? recipient_id : null),
          recipient_model,
          target_audience,
          type,
          title,
          message,
          data,
          priority,
        });

        // 2. Dispatch real-time webhooks & external channels based on notification type
        switch (type) {
          case "NEW_SUPPORT_TICKET":
          case "TICKET_CUSTOMER_REPLY":
            // In production: Broadcast to staff dashboard via WebSocket/SSE
            // or push urgent alerts to Slack/Teams/Email
            break;

          case "DEVICE_CRITICAL_ALERT":
          case "SECURITY_ALERT":
            // In production: Send immediate high-priority SMS/Email
            break;

          case "FIRMWARE_UPDATE":
          case "DEVICE_PAIRING":
          case "DEVICE_DISCONNECTED":
          case "ACCOUNT_NOTIFICATION":
          default:
            break;
        }

        return { success: true, notificationId: notification._id };
      },
      {
        connection: redisConfig,
        concurrency: 5,
      }
    );

    notificationWorker.on("failed", (job, err) => {
      console.error(`[Worker:Notification] Job ${job?.id} failed on attempt ${job?.attemptsMade}:`, err.message);
    });

    console.log(`[Worker] Notification Worker started (concurrency: 5)`);
    return notificationWorker;
  } catch (err) {
    console.warn("[Worker:Notification] Could not start worker:", err.message);
    return null;
  }
};

module.exports = {
  startNotificationWorker,
};
