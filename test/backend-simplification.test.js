const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
process.env.ENABLE_REDIS = 'false';
process.env.JWT_SECRET = 'isolated-test-access-secret';
process.env.JWT_REFRESH_SECRET = 'isolated-test-refresh-secret';
const User = require('../src/models/User');
const Device = require('../src/models/device.model');
const Ticket = require('../src/models/SupportTicket.model');
const Helper = require('../src/models/Helper.model');
const cache = require('../src/services/cache.service');

// Evaluate only the aggregation operators used by this endpoint, on fixtures.
// This checks count equivalence without requiring a remote database.
function evaluate(expression, document) {
  if (typeof expression === 'string' && expression.startsWith('$')) return document[expression.slice(1)];
  if (!expression || typeof expression !== 'object' || expression instanceof Date) return expression;
  if (Array.isArray(expression)) return expression.map(item => evaluate(item, document));
  const [[operator, operands]] = Object.entries(expression);
  const values = evaluate(operands, document);
  switch (operator) {
    case '$eq': return values[0] === values[1];
    case '$gte': return values[0] >= values[1];
    case '$in': return values[1].includes(values[0]);
    case '$and': return values.every(Boolean);
    case '$cond': return values[0] ? values[1] : values[2];
    default: throw new Error(`Unexpected operator ${operator}`);
  }
}

function aggregate(documents, pipeline) {
  const match = pipeline.find(stage => stage.$match)?.$match;
  if (match) documents = documents.filter(document => match.status.$in.includes(document.status));
  if (!documents.length) return [];
  const group = pipeline.find(stage => stage.$group).$group;
  assert.deepEqual(pipeline.at(-1), { $project: { _id: 0 } });
  return [Object.fromEntries(Object.entries(group).filter(([key]) => key !== '_id')
    .map(([key, expression]) => [key, documents.reduce((sum, document) =>
      sum + evaluate(expression.$sum, document), 0)]))];
}

const response = () => ({ status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; } });

for (const empty of [false, true]) {
  test(`dashboard keeps all original metric definitions (${empty ? 'empty' : 'mixed'} collections)`, async () => {
    const users = empty ? [] : [
      { role: 'ADMIN', status: 'active', createdAt: new Date() },
      { role: 'USER', status: 'active', createdAt: new Date(0) },
      { status: 'suspended' }, { status: 'banned' }, { status: null }, {},
    ];
    const devices = [];
    if (!empty) for (const paired of [true, false, null, undefined])
      for (const active of [true, false, null, undefined])
        for (const blocked of [true, false, null, undefined])
          for (const retired of [true, false, null, undefined])
            devices.push({ is_paired: paired, is_active: active, is_blocked: blocked, is_retired: retired });
    const tickets = empty ? [] : ['open', 'in_progress', 'resolved', 'closed', undefined]
      .flatMap(status => ['low', 'high', 'critical', undefined].map(priority => ({ status, priority })));
    const aggregations = [
      mock.method(User, 'aggregate', pipeline => aggregate(users, pipeline)),
      mock.method(Device, 'aggregate', pipeline => aggregate(devices, pipeline)),
      mock.method(Ticket, 'aggregate', pipeline => aggregate(tickets, pipeline)),
    ];
    const recentQuery = { select() { return this; }, populate() { return this; },
      sort() { return this; }, limit() { return this; }, lean: async () => [] };
    const find = mock.method(Device, 'find', () => recentQuery);
    mock.method(cache, 'getOrSet', (group, key, fetch, ttl) => {
      assert.equal(group, 'dashboard');
      assert.equal(key, 'admin:dashboard:stats');
      assert.equal(ttl, 30);
      return fetch();
    });
    try {
      const res = response();
      await require('../src/controllers/admin/dashboard.controller').getDashboardStats({}, res, error => { throw error; });
      const count = (rows, predicate) => rows.filter(predicate).length;
      const expectedUsers = { total: users.length, active: count(users, u => u.status === 'active'),
        new_this_month: empty ? 0 : 1, suspended: count(users, u => ['suspended', 'banned'].includes(u.status)) };
      const usable = d => d.is_blocked === false && d.is_retired === false;
      const expectedDevices = { total: devices.length,
        paired: count(devices, d => usable(d) && d.is_paired === true),
        active: count(devices, d => usable(d) && d.is_paired === true && d.is_active === true),
        available: count(devices, d => usable(d) && d.is_paired === false && d.is_active === true),
        offline: count(devices, d => usable(d) && d.is_active === false),
        blocked: count(devices, d => d.is_blocked === true), retired: count(devices, d => d.is_retired === true) };
      const open = t => ['open', 'in_progress'].includes(t.status);
      const expectedSupport = { open_tickets: count(tickets, open),
        urgent_tickets: count(tickets, t => open(t) && ['high', 'critical'].includes(t.priority)) };
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.data, {
        overview: { total_users: expectedUsers.total, active_users: expectedUsers.active,
          total_devices: expectedDevices.total, paired_devices: expectedDevices.paired, ...expectedSupport },
        users: expectedUsers, devices: expectedDevices, support: expectedSupport, recent_pairings: [],
      });
      assert.equal(find.mock.callCount(), 1);
      for (const call of aggregations) assert.equal(call.mock.callCount(), 1);
    } finally { mock.restoreAll(); }
  });
}

for (const found of [true, false]) {
  test(`helper deletion uses one operation and keeps ${found ? 'success' : 'not-found'} response`, async () => {
    const helper = { _id: 'helper-id', employee_id: 'EMP-1', name: 'Helper', email: 'helper@example.test' };
    const remove = mock.method(Helper, 'findByIdAndDelete', id => {
      assert.equal(id, helper._id);
      return { select() { return this; }, lean: async () => found ? helper : null };
    });
    const audit = require('../src/security/auditLogger');
    const log = mock.method(audit, 'log', () => {});
    try {
      const res = response();
      await require('../src/controllers/admin/auth.controller').deleteHelperUser(
        { params: { id: helper._id } }, res, error => { throw error; });
      assert.equal(remove.mock.callCount(), 1);
      assert.equal(res.statusCode, found ? 200 : 404);
      assert.equal(res.body.message, found ? 'Staff member [EMP-1] removed successfully' : 'Staff user not found');
      assert.equal(log.mock.callCount(), found ? 1 : 0);
    } finally { mock.restoreAll(); }
  });
}
