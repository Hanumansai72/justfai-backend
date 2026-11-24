const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'admin-api-test-secret';
process.env.JWT_REFRESH_SECRET = 'admin-api-test-refresh-secret';

const User = require('../src/models/User');
const Helper = require('../src/models/Helper.model');
const admin = '507f1f77bcf86cd799439011';
const helper = '507f1f77bcf86cd799439012';
const customer = '507f1f77bcf86cd799439013';
const lookup = data => ({ select() { return this; }, async lean() { return data; } });
User.findById = id => lookup(id === helper ? null : {
  _id: id, role: id === admin ? 'ADMIN' : 'USER', status: 'active',
});
Helper.findById = () => lookup({ _id: helper, role: 'HELPER', status: 'active' });
User.exists = async filter => {
  const session = filter.refresh_tokens.$elemMatch;
  assert.equal(session.scope, 'admin');
  return filter._id === admin && session.session_id === 'active' ? { _id: admin } : null;
};
let updates = 0;
User.findOneAndUpdate = (filter, change) => {
  updates += 1;
  assert.deepEqual(filter, { _id: customer, role: 'USER', status: { $ne: 'deleted' } });
  return lookup({ _id: customer, premium_until: change.$set.premium_until });
};
require('../src/security/rateLimiter').staffLimiter = (req, res, next) => next();
require('../src/security/auditLogger').log = () => {};

let base, server;
before(async () => {
  const app = express();
  app.use(express.json(), cookieParser());
  app.use('/admin', require('../src/routes/adminRoutes'));
  app.use('/devices', require('../src/routes/deviceRoutes'));
  app.use('/early-interest', require('../src/routes/earlyInterestRoutes'));
  app.use('/users', require('../src/routes/userRoutes'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => new Promise(resolve => server.close(resolve)));

const token = (id, sid) => jwt.sign({ id, sid, role: 'ADMIN' }, process.env.JWT_SECRET);
const bearer = (id, sid) => ({ Authorization: 'Bearer ' + token(id, sid) });
const cookie = { Cookie: 'accessToken=' + token(admin, 'active') };
const grant = headers => fetch(base + '/admin/users/' + customer + '/subscription', {
  method: 'PATCH',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: '{"days":30}',
});

test('only a live admin Bearer session can grant Premium', async () => {
  assert.equal((await grant({})).status, 401);
  assert.equal((await grant(cookie)).status, 401);
  assert.equal((await grant(bearer(admin, 'revoked'))).status, 401);
  assert.equal((await grant(bearer(customer))).status, 403);
  assert.equal((await grant(bearer(helper))).status, 403);
  assert.equal(updates, 0);
  const allowed = await grant(bearer(admin, 'active'));
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('cache-control'), 'private, no-store');
  assert.ok(Date.parse((await allowed.json()).data.premiumUntil) > Date.now());
  assert.equal(updates, 1);
});

test('staff-only aliases also reject a cookie by itself', async () => {
  for (const [path, method] of [
    ['/early-interest', 'GET'],
    ['/users', 'GET'],
    ['/devices/' + customer + '/setup-code', 'POST'],
  ]) {
    const response = await fetch(base + path, { method, headers: cookie });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});
