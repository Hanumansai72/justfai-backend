// Operational helper. Bulk approval requires the explicit owner-confirmed permission argument.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { websiteUpdate, TEST_RECIPIENT } = require('../src/services/websiteUpdate.template');

async function checkLivePreferences() {
  const { unsubscribeUrl } = require('../src/services/interestUnsubscribe.service');
  const response = await fetch(unsubscribeUrl('000000000000000000000000'), { signal: AbortSignal.timeout(15000) });
  const page = await response.text();
  if (!response.ok || !page.includes('form method="post"') || !page.includes('Unsubscribe from product updates')) {
    throw Object.assign(new Error('Deploy the email preference endpoint before sending the campaign.'), { code: 'UNSUBSCRIBE_ENDPOINT_NOT_READY' });
  }
}

async function main() {
  const operation = process.argv[2] || 'status';
  if (!['status', 'preview', 'test', 'approve', 'work'].includes(operation)) throw new Error('Use status, preview, test, approve, or work.');
  if (operation === 'preview') {
    const output = resolve(process.argv[3] || 'website-update-preview.html');
    writeFileSync(output, websiteUpdate('Hanuman', '', true).html);
    console.log(`Preview written: ${output}`);
    return;
  }
  // This standalone helper uses MongoDB and SMTP; it does not need background Redis connections.
  process.env.ENABLE_REDIS = 'false';
  const service = require('../src/services/websiteUpdateCampaign.service');
  if (!process.env.MONGO_URI) throw new Error('Database is not configured.');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000 });
  if (operation === 'test') {
    if (process.argv[3] !== TEST_RECIPIENT) throw new Error('The test recipient must be explicitly confirmed as the third argument.');
    const delivery = await service.sendTest();
    console.log(JSON.stringify({ testRecipient: TEST_RECIPIENT, ...delivery }));
    if (!delivery.sent) process.exitCode = 1;
  }
  if (operation === 'approve') {
    const count = Number(process.argv[3]);
    if (!Number.isSafeInteger(count) || process.argv[4] !== 'OWNER_CONFIRMED_DIRECT_PERMISSION') throw new Error('Provide the exact audience count and explicit owner-confirmed permission argument.');
    await checkLivePreferences();
    console.log(JSON.stringify(await service.approve({ confirmation: service.CONFIRMATION, expectedRecipients: count, includeContacted: true,
      permissionNote: 'Owner explicitly confirmed direct permission for the interested contacts in this chat on 22 October 2026.', approvalSource: 'owner-chat' })));
  }
  if (operation === 'work') {
    await checkLivePreferences();
    do {
      const current = await service.status();
      if (current.state !== 'queued') { console.log(`Campaign state: ${current.state}. No further messages processed.`); break; }
      await service.drainWebsiteUpdates();
      const updated = await service.status();
      console.log(JSON.stringify({ time: new Date().toISOString(), state: updated.state, counts: updated.counts }));
      const delay = updated.nextAttemptAt ? Math.min(60000, Math.max(10000, new Date(updated.nextAttemptAt).getTime() - Date.now())) : 10000;
      await new Promise(resolve => setTimeout(resolve, delay));
    } while (true);
  }
  const { key, state, eligibleCount, contactedCount, testStatus, testCode, testSentAt, testedCurrentContent, total, counts } = await service.status();
  console.log(JSON.stringify({ key, state, eligibleCount, contactedCount, testStatus, testCode, testSentAt, testedCurrentContent, total, counts }));
}

main().catch(error => {
  // Avoid printing credentials, connection strings, tokens, or recipient lists.
  console.error(`[website-update] ${error.code || error.name || 'ERROR'}`);
  process.exitCode = 1;
}).finally(async () => {
  await mongoose.disconnect();
  require.cache[require.resolve('../src/config/redis')]?.exports.redisClient?.disconnect();
});
