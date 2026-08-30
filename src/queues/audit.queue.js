/**
 * queues/audit.queue.js
 * BullMQ Producer for High-Throughput Security & System Audit Logs.
 *
 * Prevents HTTP request latency by moving MongoDB audit writes to background queues.
 */
const { Queue } = require("bullmq");
const { redisConfig, isRedisConnected } = require("../config/redis");
const AuditLog = require("../models/AuditLog.model");

const QUEUE_NAME = "audit-log-queue";

let auditQueue = null;

if (process.env.ENABLE_REDIS !== "false") {
  try {
    auditQueue = new Queue(QUEUE_NAME, {
      connection: redisConfig,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "fixed", delay: 1000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { age: 86400 },
      },
    });
  } catch (err) {
    console.warn("[Queue:Audit] Initialization failed, using direct mode:", err.message);
  }
}

/**
 * Enqueue an audit log entry.
 * @param {Object} logData
 */
const enqueueAuditLog = async (logData) => {
  if (auditQueue && isRedisConnected()) {
    try {
      await auditQueue.add("LOG_ENTRY", logData);
      return { queued: true };
    } catch (err) {
      // Fall through to direct write
    }
  }

  // Graceful Fallback: direct write
  try {
    await AuditLog.create(logData);
    return { queued: false, direct: true };
  } catch (err) {
    return null;
  }
};

module.exports = {
  auditQueue,
  enqueueAuditLog,
};
