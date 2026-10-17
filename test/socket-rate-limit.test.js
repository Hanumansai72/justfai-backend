const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryWindowStore } = require('../src/security/rateLimitStore');
const { createLimiter } = require('../src/security/rateLimiter');

test('REST and reconnected sockets share the authenticated chat message budget', async t => {
  const store = new MemoryWindowStore();
  t.mock.method(require('../src/security/rateLimitStore'), 'getStore', () => store);
  const chat = require('../src/services/chat.service');
  t.mock.method(chat, 'verifyTicketAccess', async () => {});
  t.mock.method(chat, 'saveMessage', async () => ({}));
  const presence = require('../src/services/presence.service');
  t.mock.method(presence, 'setUserOnline', async () => {});
  const setup = require('../src/socket/chat.socket');
  const io = { emit() {}, to() { return this; } };
  const connect = () => {
    const handlers = {};
    setup(io, { user: { _id: 'same-user' }, id: 'socket', join() {}, on(name, fn) { handlers[name] = fn; } });
    return handlers;
  };
  let accepted = false;
  await createLimiter('chatMessage', { store })({ user: { _id: 'same-user' }, ip: '127.0.0.1' }, {
    setHeader() {}, status() { return this; }, json() {},
  }, () => { accepted = true; });
  assert.equal(accepted, true);
  for (let i = 0; i < 9; i++) {
    let ack;
    await connect().send_message({ ticketId: 'ticket', body: 'hello' }, result => { ack = result; });
    assert.equal(ack.success, true);
  }
  let denied;
  await connect().send_message({ ticketId: 'ticket', body: 'hello' }, result => { denied = result; });
  assert.equal(denied.code, 'RATE_LIMITED');
  assert.ok(denied.retryAfter > 0);
});
