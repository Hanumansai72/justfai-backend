const { sendEmail } = require('./email.service');
const { adminSignIn } = require('./email.templates');

// Vercel sets these edge headers; do not trust client-supplied location elsewhere.
function loginLocation(req) {
  if (process.env.VERCEL !== '1') return 'Unavailable';
  try {
    return ['x-vercel-ip-city', 'x-vercel-ip-country-region', 'x-vercel-ip-country']
      .map(header => decodeURIComponent(String(req.get(header) || '')).slice(0, 120))
      .filter(Boolean).join(', ') || 'Unavailable';
  } catch {
    return 'Unavailable';
  }
}

async function sendAdminLoginAlert({ account, ip, req, at = new Date() }) {
  if (account.role !== 'ADMIN') return { sent: false, code: 'ADMIN_ONLY' };
  return sendEmail({ to: 'hanumansai72@gmail.com', ...adminSignIn({
    email: account.email, ip: ip || 'Unavailable', location: loginLocation(req), at,
  }) });
}

module.exports = { sendAdminLoginAlert };
