const { drainInterestEmails } = require('../queues/interestEmail.queue');
let timer;
let running = false;

// Persistent Node deployments recover queued work even when there are no new requests.
function startInterestEmailWorker() {
  if (timer) return timer;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await drainInterestEmails(); }
    catch { console.error('[interest-email] QUEUE_PROCESSING_FAILED'); }
    finally { running = false; }
  };
  timer = setInterval(tick, 10000);
  timer.unref();
  void tick();
  return timer;
}

module.exports = { startInterestEmailWorker };
