const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cors = require('cors');

test('production preflight allows JustRide sites and rejects other origins', async (t) => {
  const previousEnvironment = process.env.NODE_ENV;
  const previousOrigins = process.env.ALLOWED_ORIGINS;
  process.env.NODE_ENV = 'production';
  process.env.ALLOWED_ORIGINS = 'https://legacy.example.com';
  t.after(() => {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
    if (previousOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = previousOrigins;
  });
  const app = express();
  app.use(cors(require('../src/config/cors')));
  app.use((error, _req, res, _next) => res.status(error.status).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const preflight = origin => fetch(`http://127.0.0.1:${server.address().port}/api/early-interest`, {
    method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type' },
  });
  for (const origin of ['https://justride.cc', 'https://www.justride.cc', 'https://admin.justride.cc']) {
    const response = await preflight(origin);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assert.match(response.headers.get('access-control-allow-headers'), /authorization/i);
  }
  for (const origin of ['https://untrusted.example.com', 'https://admin.justride.cc.evil.example', 'http://localhost:3000']) {
    const response = await preflight(origin);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  process.env.NODE_ENV = 'development';
  assert.equal((await preflight('http://127.0.0.1:3000')).status, 204);
});
