const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'community-test-access';
process.env.JWT_REFRESH_SECRET = 'community-test-refresh';

const { Experience, Bookmark, Helpful, Report } = require('../src/models/Community');
require('../src/services/communitySafety.service').blockedRiderIds = async () => [];
const User = require('../src/models/User');
const Ride = require('../src/models/Ride.model');
const admin = '507f1f77bcf86cd799439011';
const owner = '507f1f77bcf86cd799439012';
const other = '507f1f77bcf86cd799439013';
const id = '507f1f77bcf86cd799439014';
const rideId = '507f1f77bcf86cd799439015';
const accounts = [owner, other, admin].map(_id => ({
  _id, name: _id === owner ? 'Rider' : 'Member', role: _id === admin ? 'ADMIN' : 'USER', status: 'active',
}));
const query = value => ({
  select() { return this; }, sort() { return this; }, skip() { return this; },
  limit() { return this; }, async lean() { return value; },
});
User.findById = id => query(accounts.find(account => account._id === id));
User.exists = async filter => filter.refresh_tokens.$elemMatch.session_id === 'active' ? { _id: admin } : null;
User.find = () => query(accounts);
Bookmark.find = () => query([]);
Helpful.find = () => query([]);
const rate = require('../src/security/rateLimiter');
rate.userLimiter = rate.staffLimiter = (req, res, next) => next();

let server, base, post;
const fields = {
  title: 'A morning ride', origin: 'Hyderabad', destination: 'Vikarabad',
  story: 'A quiet morning on the road.', expenses: [{ category: 'Fuel', amount: 700 }],
};

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/community', require('../src/routes/communityRoutes').router);
  app.use('/admin', require('../src/routes/adminRoutes'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => new Promise(resolve => server.close(resolve)));

const request = (user, path, method = 'GET', body, sid) => fetch(base + path, {
  method, body: JSON.stringify(body), headers: {
    'Content-Type': 'application/json',
    ...(user ? { Authorization: 'Bearer ' + jwt.sign({ id: user, sid }, process.env.JWT_SECRET) } : {}),
  },
});

test('explicit publishing validates public labels and owns the linked ride', async () => {
  Experience.create = async data => {
    post = { _id: id, ...data };
    return { toObject: () => post };
  };
  Ride.findOne = filter => {
    assert.equal(filter.status, 'completed');
    return query(filter.user_id === owner && filter.sessionId === 'finished' ? { _id: rideId } : null);
  };
  const path = '/community/experiences';
  assert.equal((await request(null, path)).status, 401);
  assert.equal((await request(owner, path, 'POST', { ...fields, publish: true, author: other })).status, 400);
  assert.equal((await request(owner, path, 'POST', { ...fields, publish: true, origin: '17.4,78.4' })).status, 400);
  assert.equal((await request(other, path, 'POST', { ...fields, publish: true, sourceSessionId: 'finished' })).status, 400);
  const created = await request(owner, path, 'POST', { ...fields, publish: false, sourceSessionId: 'finished' });
  assert.equal(created.status, 201);
  const { data } = await created.json();
  assert.equal(data.state, 'draft');
  assert.equal(data.linkedRide, true);
  assert.equal(data.sourceRide, undefined);
  assert.equal(data.author, undefined);
});

test('only the owner can read and publish a draft', async () => {
  Experience.findOne = filter => {
    const visible = filter.$or
      ? filter.$or.some(allowed => post.state === allowed.state &&
          (!allowed.author || allowed.author === post.author))
      : filter.author === post.author && post.state !== 'removed';
    return query(visible ? post : null);
  };
  Experience.findOneAndUpdate = (filter, change) => {
    assert.equal(filter.author, owner);
    post = { ...post, ...change.$set };
    return query(post);
  };
  const path = '/community/experiences/' + id;
  assert.equal((await request(other, path)).status, 404);
  assert.equal((await request(owner, path)).status, 200);
  assert.equal((await request(other, path, 'PATCH', { ...fields, publish: true })).status, 404);
  assert.equal((await request(owner, path, 'PATCH', { ...fields, publish: true })).status, 200);
  const published = await request(other, path);
  assert.equal(published.status, 200);
  assert.equal(published.headers.get('cache-control'), 'private, no-store');
  assert.equal((await published.json()).data.isOwner, false);
});

test('report submission is idempotent and moderation requires an active admin', async () => {
  Experience.exists = async filter => post.state === filter.state && post.author !== filter.author.$ne;
  let reports = 0;
  Report.updateOne = async (filter, change, options) => {
    assert.deepEqual(filter, { reporter: other, experience: id });
    assert.equal(change.$setOnInsert.reason, 'Incorrect directions');
    assert.equal(options.upsert, true);
    reports += 1;
  };
  Report.find = () => query([]);
  Experience.find = () => query([]);
  const path = '/community/experiences/' + id + '/report';
  assert.equal((await request(owner, path, 'POST', { reason: 'Incorrect directions' })).status, 404);
  assert.equal((await request(other, path, 'POST', { reason: 'Incorrect directions' })).status, 200);
  assert.equal(reports, 1);
  assert.equal((await request(other, '/admin/community/reports')).status, 403);
  assert.equal((await request(admin, '/admin/community/reports', 'GET', undefined, 'revoked')).status, 401);
  assert.equal((await request(admin, '/admin/community/reports', 'GET', undefined, 'active')).status, 200);
});
