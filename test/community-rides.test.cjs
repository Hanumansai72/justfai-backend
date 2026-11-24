const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'community-rides-test';
const host = '507f1f77bcf86cd799439201';
const guest = '507f1f77bcf86cd799439202';
const rideId = '507f1f77bcf86cd799439203';
const reqId = '507f1f77bcf86cd799439204';
const User = require('../src/models/User');
const CommunityRide = require('../src/models/CommunityRide');
const query = value => ({ select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, async lean() { return value; } });
const accounts = [host, guest].map(id => ({ _id: id, name: 'Rider', role: 'USER', status: 'active' }));
User.findById = id => query(accounts.find(user => user._id === id));
User.find = filter => query(accounts.filter(user => filter._id.$in.includes(user._id)));
const notifications = require('../src/services/communityNotification.service');
notifications.sendCommunityNotification = async () => {};
require('../src/services/communitySafety.service').blockedRiderIds = async () => [];
require('../src/security/rateLimiter').userLimiter = (req, res, next) => next();

let server, base, created;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/rides', require('../src/routes/communityRideRoutes'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/rides`;
});
after(() => new Promise(resolve => server.close(resolve)));

const send = (user, path, method = 'GET', body) => fetch(base + path, {
  method,
  headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${jwt.sign({ id: user }, process.env.JWT_SECRET)}` } : {}) },
  body: body == null ? undefined : JSON.stringify(body),
});

test('scheduled rides require a rider session and are available without Premium', async () => {
  assert.equal((await send(null, '/')).status, 401);
  CommunityRide.create = async values => {
    created = { _id: rideId, ...values, requests: [], state: 'planned', departureAt: values.departureAt };
    return { toObject: () => created };
  };
  const response = await send(host, '/', 'POST', {
    title: 'Sunday ride', origin: 'Hyderabad', destination: 'Vikarabad',
    departureAt: new Date(Date.now() + 86400000).toISOString(), capacity: 4,
    pace: 'steady', visibility: 'public',
  });
  assert.equal(response.status, 201);
  const { data } = await response.json();
  assert.equal(data.isHost, true);
  assert.equal(data.isMember, true);
  assert.equal(data.slotsLeft, 3);
});

test('join requests are atomic with capacity checks and public labels reject coordinates', async () => {
  const invalid = await send(guest, '/', 'POST', {
    title: 'Bad route', origin: '17.4,78.4', destination: 'Vikarabad',
    departureAt: new Date(Date.now() + 86400000).toISOString(), capacity: 4, pace: 'steady',
  });
  assert.equal(invalid.status, 400);
  let filterSeen;
  CommunityRide.findById = () => query({ _id: rideId, host, participants: [host] });
  CommunityRide.findOneAndUpdate = (filter, update) => {
    filterSeen = filter;
    created = { ...created, requests: [{ _id: reqId, rider: guest, kind: 'join', state: 'pending' }] };
    return query(created);
  };
  const joined = await send(guest, `/${rideId}/join`, 'POST', {});
  assert.equal(joined.status, 200);
  assert.deepEqual(filterSeen.$expr, { $lt: [{ $size: '$participants' }, '$capacity'] });
  assert.equal(created.requests[0].state, 'pending');
});
