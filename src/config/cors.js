const allowedOrigins = new Set([
  'https://justride.cc',
  'https://www.justride.cc',
  'https://admin.justride.cc',
  'https://justride-customer.vercel.app',
  'https://justride-admin.vercel.app',
  'https://justrideadminpage.vercel.app',
  'https://justride.io',
  'https://www.justride.io',
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean),
]);

function origin(origin, callback) {
  if (!origin) return callback(null, true); // Native apps and server requests.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    if (process.env.NODE_ENV !== 'production') return callback(null, true);
  } else if (allowedOrigins.has(origin)) {
    return callback(null, true);
  }
  const error = new Error('CORS: Origin is not allowed');
  error.status = 403;
  return callback(error);
}

module.exports = { origin, credentials: true };
