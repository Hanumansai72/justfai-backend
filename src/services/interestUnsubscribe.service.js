const { createHmac, timingSafeEqual } = require('node:crypto');

function signature(id) {
  const secret = process.env.INTEREST_UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('Email unsubscribe signing is not configured.');
  return createHmac('sha256', secret).update(`interest-updates:${id}`).digest('base64url');
}

function unsubscribeUrl(id) {
  const key = String(id);
  if (!/^[a-f0-9]{24}$/i.test(key)) throw new Error('Invalid interest identifier.');
  const url = new URL('/api/early-interest/unsubscribe', process.env.PUBLIC_API_URL || 'https://backend.justride.cc');
  if (url.protocol !== 'https:') throw new Error('Email unsubscribe URL must use HTTPS.');
  url.searchParams.set('token', `${key}.${signature(key)}`);
  return url.toString();
}

function verifyUnsubscribe(token) {
  if (typeof token !== 'string' || token.length > 120) return null;
  const [id, supplied, extra] = token.split('.');
  if (extra || !/^[a-f0-9]{24}$/i.test(id || '') || !/^[\w-]{43}$/.test(supplied || '')) return null;
  const expected = signature(id);
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)) ? id : null;
}

module.exports = { unsubscribeUrl, verifyUnsubscribe };
