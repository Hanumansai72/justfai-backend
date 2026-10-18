const { getStore } = require('../security/rateLimitStore');

const WIDTH = 198, HEIGHT = 194, MAX_BYTES = 512000;

function mapParameters(input) {
  const latitude = Number(input.latitude), longitude = Number(input.longitude);
  const zoom = Number(input.zoom ?? 16);
  const style = input.style ?? 'dark';
  if (![input.latitude, input.longitude, input.zoom ?? 16].every(value =>
      (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '') ||
      !Number.isFinite(latitude) || Math.abs(latitude) > 85 ||
      !Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
      !Number.isInteger(zoom) || zoom < 0 || zoom > 18 ||
      !['dark', 'light', 'streets'].includes(style)) throw new Error('Invalid map parameters');
  // Routes are rendered locally only after checking their provider provenance.
  return { center: `${latitude},${longitude}`, zoom: String(zoom),
    size: `${WIDTH}x${HEIGHT}`, scale: '1', format: 'jpg', maptype: style };
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return null;
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 255) {
    while (bytes[i] === 255) i++;
    const marker = bytes[i++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(i);
    if (length < 2 || i + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) return null;
      return { height: bytes.readUInt16BE(i + 3), width: bytes.readUInt16BE(i + 5) };
    }
    i += length;
  }
  return null;
}

async function reserveMapRequest(store = getStore()) {
  const configured = Number(process.env.LOCATIONIQ_DAILY_BUDGET ?? 4500);
  const budget = Number.isInteger(configured) && configured > 0 ? Math.min(configured, 5000) : 4500;
  // Shared across all callers and instances. Reserve before contacting the provider;
  // failed attempts count conservatively. A rolling day avoids timezone-reset assumptions.
  for (const [name, windowMs, limit] of [['second', 1000, 2], ['minute', 60000, 60], ['day', 86400000, budget]]) {
    const result = await store.consume(`locationiq:account:${name}`, { windowMs, limit });
    if (!result.allowed) return Math.ceil(result.resetMs / 1000);
  }
  return 0;
}

async function downloadMap(parameters, key, fetcher = fetch) {
  const url = new URL('https://maps.locationiq.com/v3/staticmap');
  url.search = new URLSearchParams({ ...parameters, key }).toString();
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const upstream = await fetcher(url, { signal: controller.signal,
      redirect: 'error', headers: { Accept: 'image/jpeg', 'User-Agent': 'JustRide/1.0' } });
    if (upstream.status !== 200) {
      await upstream.body?.cancel();
      return { status: upstream.status === 429 ? 429 : 502,
        retryAfter: Math.min(3600, Math.max(30, Number(upstream.headers.get('retry-after')) || 60)) };
    }
    const mime = upstream.headers.get('content-type')?.split(';')[0];
    if (mime !== 'image/jpeg' || Number(upstream.headers.get('content-length')) > MAX_BYTES) {
      await upstream.body?.cancel();
      return { status: 502 };
    }
    const chunks = []; let size = 0;
    for await (const chunk of upstream.body) {
      size += chunk.length;
      if (size > MAX_BYTES) { controller.abort(); return { status: 502 }; }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 ||
        bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return { status: 502 };
    const dimensions = jpegDimensions(bytes);
    if (dimensions?.width !== WIDTH || dimensions?.height !== HEIGHT) return { status: 502 };
    return { status: 200, bytes, elapsedMs: Date.now() - started };
  } finally { clearTimeout(timer); }
}

module.exports = { mapParameters, reserveMapRequest, downloadMap, jpegDimensions };
