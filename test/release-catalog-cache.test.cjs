const assert = require('node:assert/strict');
const { test } = require('node:test');

const cache = require('../src/services/cache.service');
const AppRelease = require('../src/models/AppRelease.model');
const FirmwareRelease = require('../src/models/FirmwareRelease.model');
const Device = require('../src/models/device.model');
const { getLatestAppUpdate } = require('../src/controllers/admin/appRelease.controller');
const { getLatestPublicFirmware } = require('../src/controllers/admin/firmware.controller');
const { getLatestFirmware, checkUpdate } = require('../src/controllers/device/firmware.controller');

function query(value) {
  return { sort() { return this; }, select() { return this; },
    lean: async () => value, exec: async () => value };
}

async function request(handler, query = {}, extra = {}) {
  const result = { status: 200 };
  const res = {
    status(status) { result.status = status; return this; },
    json(body) { result.body = body; return this; },
  };
  await handler({ query, ...extra }, res, error => { throw error; });
  return result;
}

function cacheFixture(t) {
  const entries = new Map();
  t.mock.method(cache, 'getOrSet', async (group, key, fetch) => {
    const id = JSON.stringify([group, key]);
    if (!entries.has(id)) entries.set(id, await fetch());
    return entries.get(id);
  });
  t.mock.method(cache, 'invalidate', async groups => {
    for (const id of entries.keys()) if (groups.includes(JSON.parse(id)[0])) entries.delete(id);
  });
}

test('APK catalog shares a cached lookup across installed builds and invalidates after a write', async t => {
  cacheFixture(t);
  let build = 15;
  const db = t.mock.method(AppRelease, 'findOne', filter => query(filter.is_mandatory
    ? { build_number: 13 }
    : { _id: 'release', platform: 'android', channel: 'stable', version: String(build),
        build_number: build, file_url: 'https://example.invalid/app.apk' }));

  const old = (await request(getLatestAppUpdate, { current_build: '12' })).body;
  const recent = (await request(getLatestAppUpdate, { current_build: '13' })).body;
  assert.equal(old.update_available, true);
  assert.equal(old.data.is_mandatory, true);
  assert.equal(recent.data.is_mandatory, false);
  assert.equal(recent.data.build_number, 15);
  assert.equal(db.mock.callCount(), 2);

  build = 16;
  await AppRelease.schema.s.hooks.execPost('findOneAndUpdate', {}, [{ build_number: build }]);
  const updated = (await request(getLatestAppUpdate, { current_build: '15' })).body;
  assert.equal(updated.update_available, true);
  assert.equal(updated.data.build_number, 16);
  assert.equal(db.mock.callCount(), 4);
});

test('public firmware uses featured release first and updates when a release is withdrawn', async t => {
  cacheFixture(t);
  let featured = { _id: 'f', version: '2.2.0', channel: 'beta', is_featured: true };
  const fallback = { _id: 's', version: '2.1.0', channel: 'stable' };
  const db = t.mock.method(FirmwareRelease, 'findOne', filter =>
    query(filter.is_featured ? featured : fallback));
  assert.equal((await request(getLatestPublicFirmware)).body.data.version, '2.2.0');
  assert.equal((await request(getLatestPublicFirmware)).body.data.version, '2.2.0');
  assert.equal(db.mock.callCount(), 1);
  featured = null;
  await FirmwareRelease.schema.s.hooks.execPost('updateOne', {}, [{ modifiedCount: 1 }]);
  assert.equal((await request(getLatestPublicFirmware)).body.data.version, '2.1.0');
  assert.equal(db.mock.callCount(), 3);
});

test('device checks share model catalog entries and still check owner, version and timestamps', async t => {
  cacheFixture(t);
  const db = t.mock.method(FirmwareRelease, 'findOne', filter =>
    query({ version: filter.device_type === null ? '2.0.0' : '2.1.0' }));
  const device = { _id: 'd', linked_to: 'owner', device_type: 'AMOLED143',
    device_id: 'd', firmware_version: '1.5.0' };
  t.mock.method(Device, 'findOne', () => query(device));
  const write = t.mock.method(Device, 'findOneAndUpdate', async () => ({
    latest_firmware: '2.1.0', firmware_update_available: true,
  }));

  await request(getLatestFirmware, { device_type: 'AMOLED143' });
  assert.equal(db.mock.callCount(), 1);
  const extra = { params: { id: 'd' }, user: { _id: 'owner', role: 'USER' } };
  const first = await request(checkUpdate, {}, extra);
  assert.equal(first.body.data.update_available, true);
  assert.ok(first.body.data.last_checked instanceof Date);
  device.firmware_version = '2.1.0';
  assert.equal((await request(checkUpdate, {}, extra)).body.data.update_available, false);
  assert.equal(db.mock.callCount(), 1);
  assert.equal(write.mock.callCount(), 2);
  const forbidden = await request(checkUpdate, {},
    { ...extra, user: { _id: 'someone-else', role: 'USER' } });
  assert.equal(forbidden.status, 403);
  assert.equal(write.mock.callCount(), 2);
  delete device.device_type;
  assert.equal((await request(checkUpdate, {}, extra)).body.data.latest_firmware, '2.0.0');
  assert.equal(db.mock.callCount(), 2);
});
