const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
process.env.ENABLE_REDIS = 'false';
process.env.JWT_SECRET = 'isolated-access-test-secret';
process.env.JWT_REFRESH_SECRET = 'isolated-refresh-test-secret';
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');
const Admin = require('../src/models/Admin.model');
const Helper = require('../src/models/Helper.model');
const verifyAdmin = require('../src/config/verifyAdmin');

test('Admin reuses the existing collection and preserves the stored credentials', async () => {
  assert.equal(Admin.collection.name, User.collection.name);
  const password = 'existing-test-password';
  const hash = await bcrypt.hash(password, 4);
  const account = Admin.hydrate({
    _id: new User()._id, name: 'Existing admin', email: 'admin@example.test',
    username: 'existing-admin', role: 'ADMIN', password: hash, status: 'active',
  });
  assert.equal(account.isNew, false);
  assert.equal(account.isModified('password'), false);
  assert.equal(account.password, hash);
  assert.equal(await account.matchPassword(password), true);
  assert.equal(await account.matchPassword('wrong-password'), false);
  account.role = 'USER';
  assert.equal(account.role, 'ADMIN');
});

test('both models reject new admin documents and bulk insertion before database access', async () => {
  for (const Model of [User, Admin]) {
    await assert.rejects(Model.create({ name: 'Extra admin', email: 'extra@example.test',
      role: 'ADMIN', password: 'test-password' }), /creation is disabled/);
    await assert.rejects(Model.insertMany([{ name: 'Extra admin', email: 'extra@example.test',
      role: 'ADMIN' }]), /creation is disabled/);
    await assert.rejects(Model.bulkWrite([{ insertOne: { document: { role: 'ADMIN' } } }]),
      /disabled/);
  }
  await assert.rejects(Admin.insertMany([{ name: 'Implicit admin', email: 'implicit@example.test' }]),
    /creation is disabled/);
});

test('promotion, replacement, pipeline updates and admin upserts are blocked', async () => {
  const id = new User()._id;
  await assert.rejects(User.updateOne({ _id: id }, { $set: { role: 'ADMIN' } }), /roles are fixed/);
  await assert.rejects(User.updateMany({}, { $set: { role: 'ADMIN' } }), /roles are fixed/);
  await assert.rejects(User.findByIdAndUpdate(id, { role: 'ADMIN' }), /roles are fixed/);
  await assert.rejects(User.replaceOne({ _id: id }, { name: 'Replacement' }), /roles are fixed/);
  await assert.rejects(User.updateOne({}, [{ $set: { role: 'ADMIN' } }], { updatePipeline: true }),
    /roles are fixed/);
  await assert.rejects(Admin.updateOne({ _id: id }, { $set: { name: 'New' } }, { upsert: true }),
    /roles are fixed/);
  await assert.rejects(Admin.deleteOne({ _id: id }), /cannot be deleted/);
});

test('database initialization accepts exactly one admin and enforces database uniqueness', async () => {
  const count = mock.method(Admin, 'countDocuments', async () => 1);
  const index = mock.method(Admin.collection, 'createIndex', async () => 'single_admin');
  try {
    await verifyAdmin();
    assert.deepEqual(count.mock.calls[0].arguments, [{ role: 'ADMIN' }]);
    assert.deepEqual(index.mock.calls[0].arguments, [{ role: 1 }, {
      unique: true, partialFilterExpression: { role: 'ADMIN' }, name: 'single_admin',
    }]);
    for (const value of [0, 2]) {
      count.mock.mockImplementation(async () => value);
      await assert.rejects(verifyAdmin(), /Exactly one existing admin is required/);
    }
    assert.equal(index.mock.callCount(), 1);
  } finally { mock.restoreAll(); }
});

test('helper model cannot validate an administrator role', async () => {
  const helper = new Helper({ employee_id: 'EMP-1', name: 'Helper',
    email: 'helper@example.test', password: 'test-password', role: 'ADMIN' });
  await assert.rejects(helper.validate(), /not a valid enum value/);
  helper.role = 'HELPER';
  await helper.validate();
});

test('existing admin credentials remain unchanged when saving a profile update', async () => {
  const hash = await bcrypt.hash('existing-test-password', 4);
  const account = Admin.hydrate({ _id: new User()._id, name: 'Existing admin',
    email: 'admin@example.test', username: 'existing-admin', role: 'ADMIN', password: hash });
  account.name = 'Updated profile';
  const update = mock.method(Admin.collection, 'updateOne', async () => ({ matchedCount: 1, modifiedCount: 1 }));
  try {
    await account.save();
    assert.equal(account.password, hash);
    assert.equal(update.mock.calls[0].arguments[1].$set.password, undefined);
  } finally { mock.restoreAll(); }
});

test('staff login still accepts the existing admin password and issues a session', async () => {
  const audit = require('../src/security/auditLogger');
  const account = Admin.hydrate({ _id: new User()._id, name: 'Existing admin',
    email: 'admin@example.test', username: 'existing-admin', role: 'ADMIN', status: 'active',
    password: await bcrypt.hash('existing-test-password', 4) });
  mock.method(Admin, 'findOne', () => ({ select: async () => account }));
  const update = mock.method(Admin, 'updateOne', async () => ({ modifiedCount: 1 }));
  mock.method(audit, 'log', () => {});
  try {
    const res = { statusCode: 0, status(code) { this.statusCode = code; return this; },
      cookie() {}, json(body) { this.body = body; return this; } };
    await require('../src/controllers/admin/auth.controller').adminLogin(
      { body: { username: 'existing-admin', password: 'existing-test-password' },
        headers: {}, ip: '127.0.0.1' }, res, error => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.role, 'ADMIN');
    assert.ok(res.body.accessToken);
    assert.equal(update.mock.callCount(), 1);
  } finally { mock.restoreAll(); }
});

test('helper provisioning rejects an admin role without creating an account', async () => {
  const create = mock.method(Helper, 'create', () => assert.fail('Must not create an account'));
  try {
    const res = { status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; } };
    await require('../src/controllers/admin/auth.controller').createHelperUser(
      { body: { role: 'ADMIN' } }, res, error => { throw error; });
    assert.equal(res.statusCode, 400);
    assert.equal(create.mock.callCount(), 0);
  } finally { mock.restoreAll(); }
});

test('no user role-promotion route is registered', () => {
  const routes = require('../src/routes/userRoutes');
  assert.equal(routes.stack.some(layer => layer.route?.path === '/:id/role'), false);
});
