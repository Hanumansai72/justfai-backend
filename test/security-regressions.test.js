const { test } = require('node:test');
const assert = require('node:assert/strict');
const Device = require('../src/models/device.model');
const User = require('../src/models/User');
const cryptoHelpers = require('../src/utils/deviceCrypto');
const response = () => { const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } }; return res; };
const next = error => { if (error) throw error; };

test('device OTP uses cryptographic randomness and missing HMAC secret fails safely', t => {
  t.mock.method(Math, 'random', () => { throw new Error('Weak random source used'); });
  assert.match(cryptoHelpers.generateNumericOtp(), /^\d{6}$/);
  assert.equal(cryptoHelpers.generateDeviceHash('AA:BB:CC:DD:EE:FF', 'code', 'unique-secret').length, 64);
  if (!process.env.DEVICE_SECRET) assert.throws(() => cryptoHelpers.generateDeviceHash('AA:BB:CC:DD:EE:FF', 'code'), /secret/);
});
test('blocked device pre-pair check selects and enforces lifecycle flags', async t => {
  t.mock.method(Device, 'findOne', query => ({ select(fields) {
    if (query.$or) assert.match(fields, /is_blocked.*is_retired/);
    return { lean: async () => query.$or ? { is_active: true, is_blocked: true, is_retired: false } : null };
  } }));
  const res = response();
  await require('../src/controllers/device/pairing.controller').checkDeviceAccess({ body: { device_id: 'device' }, user: { _id: 'user' } }, res, next);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.reason, 'DEVICE_BLOCKED');
});
test('cloud image deletion rejects other owners and does not hide provider failures', async t => {
  const provider = require('../src/services/cloudinary.service');
  const remove = t.mock.method(provider, 'deleteImage', async () => ({ result: 'ok' }));
  const controller = require('../src/controllers/upload.controller');
  const req = { user: { _id: 'owner' }, body: { public_id: 'justride/users/victim/display/image' } };
  let res = response();
  await controller.deleteImage(req, res, next);
  assert.equal(res.statusCode, 403); assert.equal(remove.mock.callCount(), 0);
  req.body.public_id = 'justride/users/owner/display/image'; res = response();
  await controller.deleteImage(req, res, next);
  assert.equal(res.statusCode, 200);
  remove.mock.mockImplementation(async () => null); res = response();
  await controller.deleteImage(req, res, next);
  assert.equal(res.statusCode, 503);
  req.body.public_id = 'justride/users/owner/../../victim'; res = response();
  await controller.deleteImage(req, res, next);
  assert.equal(res.statusCode, 403);
});
test('boot does not create default admins without explicit seed opt-in', async t => {
  const old = process.env.SEED_ADMIN; delete process.env.SEED_ADMIN;
  t.after(() => { if (old !== undefined) process.env.SEED_ADMIN = old; });
  const lookup = t.mock.method(User, 'findOne', async () => { throw new Error('Unexpected seed DB access'); });
  await require('../src/config/seedAdmin')();
  assert.equal(lookup.mock.callCount(), 0);
});
test('error logging redacts reset tokens and production hides internal details', t => {
  const warnings = [];
  t.mock.method(console, 'error', value => warnings.push(value));
  const audit = require('../src/security/auditLogger');
  const record = t.mock.method(audit, 'log', () => {});
  delete require.cache[require.resolve('../src/middlewares/errorHandler')];
  const handler = require('../src/middlewares/errorHandler');
  const old = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  const res = response();
  handler(new Error('sensitive provider details'), { method: 'POST', originalUrl: '/api/users/reset-password/secret-token?private=yes' }, res, next);
  if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old;
  assert.equal(res.body.message, 'Internal Server Error');
  const entries = record.mock.calls.map(({ arguments: [entry] }) => ({ message: entry.message, metadata: entry.metadata }));
  assert.ok(!JSON.stringify([warnings, entries]).includes('secret-token'));
});

test('stale unlink cannot disconnect a newly paired owner', async t => {
  t.mock.method(Device, 'findOne', () => ({ select() { return this; }, exec: async () => ({
    _id: 'device', is_paired: true, linked_to: 'owner', device_hash: 'old-hash',
  }) }));
  t.mock.method(Device, 'updateOne', async filter => {
    assert.equal(filter.linked_to, 'owner');
    assert.equal(filter.device_hash, 'old-hash');
    return { modifiedCount: 0 };
  });
  const res = response();
  await require('../src/controllers/device/pairing.controller').unlinkDevice({
    user: { _id: 'owner' }, params: {}, body: { device_id: 'device', device_hash: 'old-hash' },
  }, res, next);
  assert.equal(res.statusCode, 409);
});

test('repeated firmware checks notify only when the update state changes', async t => {
  const notifications = require('../src/controllers/notification.controller');
  const notify = t.mock.method(notifications, 'sendNotification', async () => {});
  const Release = require('../src/models/FirmwareRelease.model');
  t.mock.method(Release, 'findOne', () => ({ sort() { return this; }, lean: async () => ({ version: '2.0.0' }) }));
  t.mock.method(Device, 'findOne', () => ({ select() { return this; }, exec: async () => ({
    _id: 'device', device_id: 'test', linked_to: 'owner', firmware_version: '1.0.0',
  }) }));
  let state = { latest_firmware: null, firmware_update_available: false };
  t.mock.method(Device, 'findOneAndUpdate', async (filter, update, options) => {
    assert.equal(options.new, false);
    const previous = state;
    state = update.$set;
    return previous;
  });
  delete require.cache[require.resolve('../src/controllers/device/firmware.controller')];
  const { checkUpdate } = require('../src/controllers/device/firmware.controller');
  const req = { user: { _id: 'owner' }, params: { id: 'test' } };
  await checkUpdate(req, response(), next);
  await checkUpdate(req, response(), next);
  assert.equal(notify.mock.callCount(), 1);
});
