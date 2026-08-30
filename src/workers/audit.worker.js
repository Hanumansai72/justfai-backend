/**
 * workers/audit.worker.js
 * BullMQ Consumer for Audit Log Jobs.
 */
const { Worker } = require("bullmq");
const { redisConfig } = require("../config/redis");
const AuditLog = require("../models/AuditLog.model");

const QUEUE_NAME = "audit-log-queue";

let auditWorker = null;

const startAuditWorker = () => {
  if (process.env.ENABLE_REDIS === "false") return null;

  try {
    auditWorker = new Worker(
      QUEUE_NAME,
      async (job) => {
        await AuditLog.create(job.data);
        return { success: true };
      },
      {
        connection: redisConfig,
        concurrency: 10, // Higher concurrency for lightweight write operations
      }
    );

    auditWorker.on("failed", (job, err) => {
      console.error(`[Worker:Audit] Job ${job?.id} failed:`, err.message);
    });

    console.log(`[Worker] Audit Log Worker started (concurrency: 10)`);
    return auditWorker;
  } catch (err) {
    console.warn("[Worker:Audit] Could not start worker:", err.message);
    return null;
  }
};

module.exports = {
  startAuditWorker,
};
