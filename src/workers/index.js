/**
 * workers/index.js
 * Central Worker Orchestrator.
 * Starts all BullMQ background workers on application boot.
 */
const { startNotificationWorker } = require("./notification.worker");
const { startAuditWorker }        = require("./audit.worker");

const startWorkers = () => {
  if (process.env.ENABLE_REDIS === "false") {
    console.log("[Workers] Background workers skipped (ENABLE_REDIS=false)");
    return;
  }

  startNotificationWorker();
  startAuditWorker();
  console.log("[Workers] All background workers initialized ⚡");
};

module.exports = {
  startWorkers,
};
