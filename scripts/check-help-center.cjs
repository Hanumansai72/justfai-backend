// Isolated checks: no live MongoDB, Cloudinary, Redis, email or user accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const articles = require('../src/data/app-faqs.json');
let saved, vote, deviceFilter, deviceOwned = true, pipeline, uploadOptions;
let notifyFails = false;
const tasks = [];
const moduleObject = { exports: {} };
const localRequire = require('node:module').createRequire(path.join(root, 'src/controllers/help.controller.js'));
const mocks = {
  '../models/HelpFeedback.model': {
    updateOne: async (filter, update, options) => { vote = { filter, update, options }; },
    aggregate: async value => { pipeline = value; return [{ items: [{ _id: articles[0].id, helpful: 2, not_helpful: 3 }], total: [{ count: 12 }] }]; },
  },
  '../models/SupportTicket.model': { create: async value => { saved = value; return { _id: 'ticket-a', ...value }; } },
  '../models/device.model': { findOne: filter => { deviceFilter = filter; return { select: async () => deviceOwned ? { _id: '507f1f77bcf86cd799439011' } : null }; } },
  '../config/cloudinary': { config: () => ({ cloud_name: 'test-cloud' }), uploader: {
    upload_stream: (options, callback) => { uploadOptions = options; return { end: buffer => { assert(Buffer.isBuffer(buffer)); callback(null, { secure_url: 'https://res.cloudinary.com/test-cloud/image/upload/screenshot.png' }); } }; },
  } },
  '../queues/notification.queue': { notifyNewTicket: async () => { if (notifyFails) throw new Error('Simulated queue outage'); } },
  '../security/auditLogger': { log: () => {} },
  '@vercel/functions': { waitUntil: task => tasks.push(task) },
};
vm.runInNewContext(fs.readFileSync(path.join(root, 'src/controllers/help.controller.js'), 'utf8'), {
  module: moduleObject, exports: moduleObject.exports, require: key => Object.hasOwn(mocks, key) ? mocks[key] : localRequire(key),
  console: { error: () => {} }, URL, Date, Buffer,
});
const controller = moduleObject.exports;
const userId = '507f1f77bcf86cd799439012';
const validBody = () => ({ subject: 'Navigation freezes', description: 'Directions freeze when my screen locks.', category: 'navigation_issue', help_article_id: 'screen-lock' });
const ownedUrl = `https://res.cloudinary.com/test-cloud/image/upload/v123/justride/users/${userId}/support/12345678-abcd-1234-abcd-123456789012.png`;
async function call(handler, body, query = {}, file) {
  saved = undefined;
  const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ user: { _id: userId }, body, query, file }, res, error => { throw error; });
  return res;
}

(async () => {
  assert.equal(articles.length, 24);
  assert.equal(new Set(articles.map(article => article.id)).size, 24);
  if (process.argv[2]) {
    const bundled = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    assert.deepEqual(articles, bundled.map(({ id, question }) => ({ id, question })), 'Backend article identifiers must match the APK bundle');
  }
  for (const body of [undefined, {}, { ...validBody(), subject: { $ne: null } }, { ...validBody(), description: 'short' }, { ...validBody(), category: 'ADMIN' }, { ...validBody(), help_article_id: 'unknown' }]) {
    assert.equal((await call(controller.createTicket, body)).code, 400);
    assert.equal(saved, undefined);
  }
  for (const attachments of [[ownedUrl.replace(userId, '507f1f77bcf86cd799439099')], [ownedUrl.replace('test-cloud', 'other-cloud')], ['https://evil.invalid/file.png'], ['javascript:alert(1)'], [ownedUrl, ownedUrl, ownedUrl, ownedUrl], { $ne: null }]) {
    assert.equal((await call(controller.createTicket, { ...validBody(), attachments })).code, 400);
    assert.equal(saved, undefined);
  }
  for (const body of [{ ...validBody(), diagnostics: { app_version: '1.0' } }, { ...validBody(), diagnostics_consent: 'true', diagnostics: {} }, { ...validBody(), diagnostics_consent: true, diagnostics: [] }, { ...validBody(), diagnostics_consent: true, diagnostics: { phone_model: 'x'.repeat(161) } }]) {
    assert.equal((await call(controller.createTicket, body)).code, 400);
    assert.equal(saved, undefined);
  }
  deviceOwned = false;
  assert.equal((await call(controller.createTicket, { ...validBody(), device_id: '507f1f77bcf86cd799439011' })).code, 403);
  assert.equal(deviceFilter.linked_to, userId);
  deviceOwned = true;
  notifyFails = true;
  assert.equal((await call(controller.createTicket, { ...validBody(), user_id: 'attacker', priority: 'critical', status: 'resolved',
    attachments: [ownedUrl, ownedUrl], diagnostics_consent: true,
    diagnostics: { app_version: '1.2.0', phone_model: 'Test phone', password: 'do-not-store', latitude: 'do-not-store', consented_at: '1900-01-01' },
  })).code, 201);
  assert.equal(saved.user_id, userId);
  assert.equal(saved.category, 'navigation_issue');
  assert.equal(saved.priority, undefined);
  assert.equal(saved.status, undefined);
  assert.equal(saved.messages[0].sender_id, userId);
  assert.equal(saved.messages[0].sender_role, 'USER');
  assert.equal(saved.messages[0].attachments.length, 1);
  assert.deepEqual(Object.keys(saved.diagnostics).sort(), ['app_version', 'consented_at', 'phone_model']);
  assert(saved.diagnostics.consented_at instanceof Date);
  assert.equal(deviceFilter.linked_to, userId);
  assert.equal(deviceFilter.is_paired, true);
  await Promise.all(tasks); // Notification failure does not fail an already saved ticket.
  assert.equal((await call(controller.createTicket, validBody())).code, 201);
  assert.equal(saved.diagnostics, undefined);
  assert.equal((await call(controller.saveFeedback, { article_id: 'unknown', helpful: true })).code, 400);
  assert.equal((await call(controller.saveFeedback, { article_id: articles[0].id, helpful: 'true' })).code, 400);
  for (const helpful of [true, false]) {
    assert.equal((await call(controller.saveFeedback, { article_id: articles[0].id, helpful, user_id: 'someone-else' })).code, 200);
    assert.equal(vote.filter.user_id, userId);
    assert.equal(vote.update.$set.helpful, helpful);
    assert.equal(vote.options.upsert, true);
  }
  const summary = await call(controller.getFeedbackSummary, {}, { page: '2', limit: '100' });
  assert.equal(summary.body.pagination.limit, 10);
  assert.equal(summary.body.pagination.pages, 2);
  assert.equal(summary.body.data[0].question, articles[0].question);
  assert.equal(pipeline.at(-1).$facet.items[0].$skip, 10);
  assert.equal(pipeline.at(-1).$facet.items[1].$limit, 10);
  assert.equal((await call(controller.uploadAttachment, {})).code, 400);
  assert.equal((await call(controller.uploadAttachment, {}, {}, { buffer: Buffer.from('test-image') })).code, 201);
  assert(uploadOptions.public_id.startsWith(`justride/users/${userId}/support/`));
  assert.equal(uploadOptions.transformation[0].crop, 'limit');
  const upload = require('../src/middlewares/upload.middleware');
  assert.equal(upload.limits.fileSize, 5 * 1024 * 1024);
  upload.fileFilter({}, { mimetype: 'image/png', originalname: 'screenshot.png' }, (error, accepted) => { assert.equal(error, null); assert.equal(accepted, true); });
  upload.fileFilter({}, { mimetype: 'image/svg+xml', originalname: 'image.svg' }, error => assert(error));
  const source = fs.readFileSync(path.join(root, 'src/routes/adminRoutes.js'), 'utf8');
  assert(source.indexOf("'/support/help-feedback'") < source.indexOf('"/support/:id"'));
  assert(source.includes("authorize('ADMIN', 'HELPER'), adminCache('support')"));
  const routes = fs.readFileSync(path.join(root, 'src/routes/supportRoutes.js'), 'utf8');
  assert(routes.includes('router.use(protect, userLimiter)'));
  for (const endpoint of ['help-feedback', 'attachments', 'tickets']) assert(routes.includes(`router.post('/${endpoint}', authorize('USER')`));
  console.log('PASS: Help Center ticket validation, identity ownership, screenshot ownership and limits, diagnostic consent/whitelist, feedback upsert, admin pagination, route authorization, and notification failure isolation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
