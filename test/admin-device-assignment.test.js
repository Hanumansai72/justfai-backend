const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const deviceId = '111111111111111111111111';
const userId = '222222222222222222222222';
async function assign(options = {}, body = { user_id: userId }) {
  let write, error;
  const device = { _id: deviceId, BLE_ADDRESS: 'AA:BB:CC:DD:EE:FF', device_secret: 'test-secret', is_active: true, is_paired: false, linked_to: null, ...options.device };
  const dependencies = {
    '../../models/device.model': {
      findOne: () => ({ session() { return this; }, select() { return this; }, lean: async () => options.other || null }),
      findById: () => ({ session: () => ({ select: async () => device }) }),
      findOneAndUpdate: async (filter, update) => { write = { filter, update }; return options.race ? null : device; },
    },
    '../../models/User': { updateOne: async () => ({ matchedCount: options.inactive ? 0 : 1 }) },
    mongoose: { isObjectIdOrHexString: v => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v), connection: { transaction: async callback => callback({}) } },
    '../../services/cache.service': { invalidate: async () => {} },
    '../../security/auditLogger': { log() {} },
    '../../utils/deviceCrypto': { generateRandomCode: () => 'internal-code', generateDeviceHash: () => 'internal-hash', hashString: () => 'hashed-code' },
  };
  const exports = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/controllers/admin/pairing.controller.js'), 'utf8'), {
    exports, require: name => dependencies[name], process: { env: {} },
  });
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await exports.assignDevice({ params: { id: deviceId }, body, user: { _id: 'admin' } }, response, e => { error = e; });
  return { response, write, error };
}
test('assigns without a setup code and does not return credentials', async () => {
  const { response, write, error } = await assign();
  assert.equal(error, undefined);
  assert.equal(response.body.success, true);
  assert.equal(write.update.$set.linked_to, userId);
  assert.equal(write.filter.is_paired, false);
  assert.equal(write.filter.linked_to, null);
  assert.equal(JSON.stringify(response.body).includes('internal-hash'), false);
});
for (const [name, options] of Object.entries({
  inactiveUser: { inactive: true }, otherDevice: { other: { _id: 'another' } },
  ownedDevice: { device: { is_paired: true, linked_to: 'another' } },
  blocked: { device: { is_blocked: true } }, retired: { device: { is_retired: true } },
  inactiveDevice: { device: { is_active: false } }, missingSecret: { device: { device_secret: null } },
  ownershipRace: { race: true },
})) {
  test(`rejects ${name}`, async () => {
    const { error, response } = await assign(options);
    assert.equal(error.statusCode, 409);
    assert.equal(response.body, undefined);
  });
}
test('rejects invalid user IDs before writing', async () => {
  const { response, write } = await assign({}, { user_id: {} });
  assert.equal(response.code, 400);
  assert.equal(write, undefined);
});
test('repeated assignment to the same owner preserves credentials', async () => {
  const { response, write, error } = await assign({ device: { is_paired: true, linked_to: userId } });
  assert.equal(error, undefined);
  assert.equal(response.body.success, true);
  assert.equal(write, undefined);
});
test('rejects a missing request body without a server error', async () => {
  const { response, error } = await assign({}, null);
  assert.equal(error, undefined);
  assert.equal(response.code, 400);
});
