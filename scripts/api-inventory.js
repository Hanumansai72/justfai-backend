// Inspect real Express router registrations without running controllers or external services.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const express = require('express');
const policies = require('../src/security/rateLimitPolicies');
const bases = { userRoutes: '/api/users', deviceRoutes: '/api/devices', adminRoutes: '/api/admin',
  savedAddressRoutes: '/api/addresses', notificationRoutes: '/api/notifications', supportRoutes: '/api/support',
  chatRoutes: '/api/chat', uploadRoutes: '/api/upload', earlyInterestRoutes: '/api/early-interest' };
const fn = name => Object.defineProperty(function () {}, 'name', { value: name });
const proxy = prefix => new Proxy(fn(prefix), { get: (_, key) => key === 'single' || key === 'fields' ? () => fn(prefix + '.' + key) : fn(String(key)) });
function policyNames(name, method) {
  const alias = { authLimiter: 'login', otpLimiter: 'otpSend', unlinkLimiter: 'otpVerify', firmwareLimiter: 'firmwareRecord' };
  if (name === 'staffLimiter') return method === 'GET' ? 'adminRead' : 'adminWrite';
  if (name === 'userLimiter') return method === 'GET' ? 'userRead' : 'userWrite';
  return alias[name] || name.replace(/Limiter$/, '');
}
const rows = [];
for (const [file, base] of Object.entries(bases)) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/routes', file + '.js'), 'utf8'), {
    module, exports: module.exports, require: id => {
      if (id === 'express') return express;
      if (id.includes('EarlyInterest.model')) return require('../src/models/EarlyInterest.model');
      if (id.includes('authMiddleware')) return { protect: fn('protect'), authorize: (...roles) => fn('authorize:' + roles.join('/')) };
      return proxy(id);
    }, process, console, Date,
  }, { filename: file });
  const inherited = [];
  for (const layer of module.exports.stack) {
    if (!layer.route) { inherited.push(layer.name); continue; }
    for (const verb of Object.keys(layer.route.methods)) {
      const method = verb.toUpperCase();
      const handlers = layer.route.stack.filter(item => !item.method || item.method === verb).map(item => item.name);
      const names = [...inherited, ...handlers];
      const roles = names.find(name => name.startsWith('authorize:'));
      const selected = names.filter(name => name.endsWith('Limiter')).map(name => policyNames(name, method));
      if (file === 'deviceRoutes') selected.unshift(method === 'GET' ? 'deviceRead' : 'deviceWrite');
      selected.unshift('global');
      const auth = roles ? roles.slice(10) : names.includes('protect') ? 'Authenticated user' : 'Public';
      const frequency = file === 'adminRoutes' && layer.route.path.includes('dashboard') ? '1/min visible dashboard (+ manual refresh)' : file === 'deviceRoutes' && layer.route.path.startsWith('/my-device') ? '3/min per visible mobile screen; concurrent calls deduplicated' : method === 'GET' ? 'On view/open or explicit refresh (estimate)' : 'User action; no automatic HTTP retries (estimate)';
      rows.push({ method, endpoint: base + (layer.route.path === '/' ? '' : layer.route.path), auth,
        controller: handlers.at(-1) === '<anonymous>' ? file + '.inline' : handlers.at(-1),
        frequency, policies: selected.map(name => ({ name, ...policies[name] })),
        source: 'src/routes/' + file + '.js' });
    }
  }
}
for (const [endpoint, controller] of [['/', 'health'], ['/api/app-releases/latest', 'getLatestAppUpdate'], ['/api/firmware/latest', 'getLatestPublicFirmware']]) {
  rows.push({ method: 'GET', endpoint, auth: 'Public', controller, frequency: 'On launch/download page or health check (estimate)',
    policies: ['global', ...(endpoint === '/' ? [] : ['publicRead'])].map(name => ({ name, ...policies[name] })), source: 'src/app.js' });
}
rows.sort((a,b) => a.endpoint.localeCompare(b.endpoint) || a.method.localeCompare(b.method));
for (const row of rows) {
  row.justification = row.policies.some(p => /login|register|google|password|reset|otp/i.test(p.name))
    ? 'Bound credential guessing and delivery costs; separate action budgets.'
    : row.policies.some(p => p.name === 'upload') ? 'Bound storage/provider cost before parsing uploads.'
    : row.source.includes('deviceRoutes') ? 'Allow 20-second polling and reconnect bursts; BLE/GPS/OTA chunks do not use HTTP.'
    : row.auth === 'Public' ? 'Bound anonymous reads/submissions and email cost.'
    : row.method === 'GET' ? 'Allow normal view refreshes; per-user budget isolates shared-network users.'
    : 'Bound authenticated mutation cost; no automatic replay of writes.';
}
fs.mkdirSync(path.join(__dirname, '../docs'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '../docs/api-inventory.json'), JSON.stringify(rows, null, 2) + '\n');
const lines = ['# HTTP API inventory', '', 'Generated from Express router registrations using stubbed controllers. Frequencies are source-derived estimates, not traffic measurements. Each category quota is shared; all HTTP requests also share the secondary IP ceiling. All windows are exact sliding windows.', '',
  '| Method | Endpoint | Auth | Controller | Estimated frequency | Shared policies (limit/window/scope) | Justification |', '|---|---|---|---|---|---|---|'];
for (const row of rows) lines.push('| ' + [row.method, row.endpoint, row.auth, row.controller, row.frequency, row.policies.map(p => p.name + ': ' + p.limit + '/' + p.windowMs/1000 + 's/' + p.scope).join('; '), row.justification].join(' | ') + ' |');
fs.writeFileSync(path.join(__dirname, '../docs/api-inventory.md'), lines.join('\n') + '\n');
console.log('Inventoried ' + rows.length + ' HTTP method/path combinations');
if (rows.some(row => row.policies.some(policy => !policy.limit))) throw new Error('Inventory contains an unconfigured policy');
module.exports = rows;
