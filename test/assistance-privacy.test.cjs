const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'community-assist-test';
const requester = '507f1f77bcf86cd799439101';
const helper = '507f1f77bcf86cd799439102';
const stranger = '507f1f77bcf86cd799439103';
const requestId = '507f1f77bcf86cd799439104';
const offerId = '507f1f77bcf86cd799439105';
const User = require('../src/models/User');
const { AssistanceRequest } = require('../src/models/Assistance');
const lookup = value => ({ select() { return this; }, async lean() { return value; } });
User.findById = id => lookup({ _id: id, role: 'USER', status: 'active' });
const record = {
  _id: requestId, requester, acceptedHelper: helper, type: 'puncture', state: 'assigned',
  location: { type: 'Point', coordinates: [78.4867, 17.385] },
  offers: [{ _id: offerId, helper, state: 'accepted', message: '' }],
  createdAt: new Date(), expiresAt: new Date(Date.now() + 3600000),
};
AssistanceRequest.findOne = filter => {
  const allowed = filter.$or?.some(item => item.requester === helper || item.acceptedHelper === helper);
  return lookup(allowed ? record : null);
};
require('../src/security/rateLimiter').userLimiter = (req, res, next) => next();
require('../src/services/communitySafety.service').blockedRiderIds = async () => [];

let server, base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/assist', require('../src/routes/assistanceRoutes'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/assist`;
});
after(() => new Promise(resolve => server.close(resolve)));

const get = user => fetch(`${base}/requests/${requestId}`, {
  headers: user ? { Authorization: `Bearer ${jwt.sign({ id: user }, process.env.JWT_SECRET)}` } : {},
});

test('precise assistance coordinates require requester or accepted helper access', async () => {
  assert.equal((await get(null)).status, 401);
  assert.equal((await get(stranger)).status, 404);
  const allowed = await get(helper);
  assert.equal(allowed.status, 200);
  const { data } = await allowed.json();
  assert.deepEqual(data.location, { lat: 17.385, lng: 78.4867 });
  assert.equal(data.offers, undefined);
});
