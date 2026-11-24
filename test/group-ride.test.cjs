const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'group-ride-test-secret';
const User = require('../src/models/User');
const GroupRide = require('../src/models/GroupRide');
const id = '507f1f77bcf86cd799439011';
const outsider = '507f1f77bcf86cd799439012';
const rideId = '507f1f77bcf86cd799439013';
const activeUntil = new Date(Date.now() + 3600000);
const users = new Map([id, outsider].map(_id =>
  [_id, { _id, name: 'Rider', role: 'USER', status: 'active', premium_until: activeUntil }]));
const lookup = value => ({
  select() { return this; },
  async lean() { return value; },
});
User.findById = userId => lookup(users.get(userId));
User.find = filter => lookup(Array.from(users.values()).filter(user =>
  filter._id.$in.includes(user._id) && user.premium_until > filter.premium_until.$gt));
require('../src/security/rateLimiter').userLimiter = (req, res, next) => next();
require('../src/services/communitySafety.service').blockedRiderIds = async () => [];

let server, base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/group-rides', require('../src/routes/groupRideRoutes'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port + '/group-rides';
});
after(() => new Promise(resolve => server.close(resolve)));

function request(path, userId, method = 'GET', body) {
  const headers = { 'Content-Type': 'application/json' };
  if (userId) headers.Authorization = 'Bearer ' + jwt.sign({ id: userId }, process.env.JWT_SECRET);
  return fetch(base + path, { method, headers, body: JSON.stringify(body) });
}

test('subscription shows Free and the server blocks group actions after expiry', async () => {
  assert.equal((await request('/current')).status, 401);
  users.get(id).premium_until = new Date(0);
  try {
    const subscription = await request('/subscription', id);
    assert.equal((await subscription.json()).data.premium, false);
    for (const [path, method] of [
      ['', 'POST'], ['/join', 'POST'], ['/current', 'GET'],
      ['/' + rideId + '/location', 'PUT'],
    ]) {
      assert.equal((await request(path, id, method)).status, 403);
    }
  } finally {
    users.get(id).premium_until = activeUntil;
  }
});

test('location writes require membership and stop sharing clears the point', async () => {
  const writes = [];
  GroupRide.findOneAndUpdate = (filter, update) => {
    writes.push(update);
    assert.equal(filter._id, rideId);
    assert.ok(filter.expiresAt.$gt instanceof Date);
    if (filter['members.userId'] !== id) return lookup(null);
    return lookup({
      _id: rideId, owner: id, code: '123456ABCDEF', expiresAt: activeUntil,
      members: [{ userId: id, location: update.$set?.['members.$.location'] }],
    });
  };
  const path = '/' + rideId + '/location';
  const location = { lat: 17.4, lng: 78.6 };
  assert.equal((await request(path, outsider, 'PUT', { location })).status, 404);
  assert.equal((await request(path, id, 'PUT', { location: { lat: 91, lng: 0 } })).status, 400);
  const shared = await request(path, id, 'PUT', { location });
  assert.equal((await shared.json()).data.members[0].location.lat, 17.4);
  const stopped = await request(path, id, 'PUT', { location: null });
  assert.equal((await stopped.json()).data.members[0].location, null);
  assert.deepEqual(writes.at(-1), { $unset: { 'members.$.location': 1 } });
});

test('premium riders create and join by code, and only the host closes the group', async () => {
  let ride;
  GroupRide.deleteMany = async () => ({ deletedCount: 0 });
  GroupRide.create = async fields => {
    assert.equal(fields.owner, id);
    assert.match(fields.code, /^[0-9A-F]{12}$/);
    assert.deepEqual(fields.members, [{ userId: id }]);
    ride = { _id: rideId, ...fields };
    return { toObject: () => ride };
  };
  GroupRide.findOne = () => lookup(null);
  GroupRide.findOneAndUpdate = (filter, update) => {
    assert.equal(filter.code, ride.code);
    assert.deepEqual(filter['members.11'], { $exists: false });
    assert.deepEqual(filter['members.userId'], { $ne: outsider });
    ride.members.push(update.$push.members);
    return lookup(ride);
  };
  GroupRide.deleteOne = async filter => {
    assert.equal(filter.owner, filter['members.userId']);
    return { deletedCount: Number(filter.owner === id) };
  };
  GroupRide.updateOne = async (filter, update) => {
    assert.equal(filter['members.userId'], outsider);
    assert.deepEqual(update, { $pull: { members: { userId: outsider } } });
    return { modifiedCount: 1 };
  };

  const created = await request('', id, 'POST');
  assert.equal(created.status, 201);
  const { data } = await created.json();
  assert.equal(data.isHost, true);
  assert.equal((await request('/join', outsider, 'POST', { code: 'bad' })).status, 400);
  const joined = await request('/join', outsider, 'POST', { code: data.code.toLowerCase() });
  assert.equal(joined.status, 200);
  const joinedData = (await joined.json()).data;
  assert.equal(joinedData.isHost, false);
  assert.equal(joinedData.members.length, 2);
  assert.equal((await request('/' + rideId, outsider, 'DELETE')).status, 200);
  assert.equal((await request('/' + rideId, id, 'DELETE')).status, 200);
});

test('snapshots suppress stale points and riders without Premium', async () => {
  users.get(outsider).premium_until = new Date(0);
  GroupRide.findOne = filter => {
    assert.equal(filter['members.userId'], id);
    return lookup({
      _id: rideId, owner: id, code: '123456ABCDEF', expiresAt: activeUntil,
      members: [
        { userId: id, location: { lat: 17.4, lng: 78.6, updatedAt: new Date(0) } },
        { userId: outsider, location: { lat: 17.5, lng: 78.6, updatedAt: new Date() } },
      ],
    });
  };
  try {
    const response = await request('/current', id);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const { data } = await response.json();
    assert.equal(data.members.length, 1);
    assert.equal(data.members[0].location, null);
  } finally {
    users.get(outsider).premium_until = activeUntil;
  }
});
