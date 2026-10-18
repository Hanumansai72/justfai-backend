const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapParameters, reserveMapRequest, downloadMap, jpegDimensions } = require('../src/services/staticMap');
const { MemoryWindowStore } = require('../src/security/rateLimitStore');

const params = mapParameters({ latitude: 17.437, longitude: 78.58 });
// A structural JPEG header for proxy boundary tests; actual codec tests run in Flutter.
const jpeg = Buffer.from([255,216,255,192,0,8,8,0,194,0,198,1,255,217]);

test('validate coordinates, zoom, style and native dimensions', () => {
  assert.equal(params.size, '198x194');
  assert.equal(params.format, 'jpg');
  for (const input of [{}, {latitude:'',longitude:0}, {latitude:[],longitude:0},
    {latitude:90,longitude:0}, {latitude:0,longitude:Infinity},
    {latitude:0,longitude:0,zoom:19}, {latitude:0,longitude:0,style:'bad'}]) {
    assert.throws(() => mapParameters(input));
  }
  assert.deepEqual(jpegDimensions(jpeg), {width:198,height:194});
  assert.equal(jpegDimensions(Buffer.from('not an image')), null);
});

test('shared account limits apply across callers, configurable rolling daily budget', async () => {
  let now = 0;
  const store = new MemoryWindowStore(() => now);
  assert.equal(await reserveMapRequest(store), 0);
  assert.equal(await reserveMapRequest(store), 0);
  assert.ok(await reserveMapRequest(store) > 0);
  now += 1001;
  assert.equal(await reserveMapRequest(store), 0);
  const previous = process.env.LOCATIONIQ_DAILY_BUDGET;
  process.env.LOCATIONIQ_DAILY_BUDGET = '1';
  assert.ok(await reserveMapRequest(store) > 0);
  if (previous == null) delete process.env.LOCATIONIQ_DAILY_BUDGET;
  else process.env.LOCATIONIQ_DAILY_BUDGET = previous;
});

test('proxy validates provider URL, payload and status without disclosing key', async () => {
  const fetcher = async url => {
    assert.equal(url.origin, 'https://maps.locationiq.com');
    assert.equal(url.searchParams.get('key'), 'test-placeholder');
    assert.equal(url.searchParams.get('size'), '198x194');
    return new Response(jpeg, {headers:{'content-type':'image/jpeg'}});
  };
  const result = await downloadMap(params, 'test-placeholder', fetcher);
  assert.equal(result.status, 200);
  assert.deepEqual(result.bytes, jpeg);
  for (const status of [401,403,429,500,503]) {
    const response = await downloadMap(params, 'test-placeholder', async () => new Response('error', {status}));
    assert.equal(response.status, status === 429 ? 429 : 502);
    assert.equal(JSON.stringify(response).includes('test-placeholder'), false);
  }
});

test('reject invalid MIME, excessive bytes, corrupted JPEG and wrong dimensions', async () => {
  const wrongSize = Buffer.from(jpeg); wrongSize[10] = 197;
  for (const [bytes, headers] of [[jpeg, {'content-type':'text/html'}],
    [jpeg, {'content-type':'image/jpeg','content-length':'512001'}],
    [Buffer.from('broken'), {'content-type':'image/jpeg'}],
    [wrongSize, {'content-type':'image/jpeg'}],
    [Buffer.alloc(512001), {'content-type':'image/jpeg'}]]) {
    assert.equal((await downloadMap(params, 'test-placeholder', async () => new Response(bytes, {headers}))).status, 502);
  }
});

test('network/timeout and shared budget failures propagate to fail-closed route', async () => {
  await assert.rejects(downloadMap(params, 'test-placeholder', async () => { throw new DOMException('Timeout', 'TimeoutError'); }));
  await assert.rejects(downloadMap(params, 'test-placeholder', async () => { throw new Error('Offline'); }));
  await assert.rejects(reserveMapRequest({consume: async () => { throw new Error('Redis unavailable'); }}));
});
