const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function message(subject, paragraphs, action) {
  const text = [...paragraphs, ...(action ? [`${action.label}: ${action.url}`] : []), 'JustRide', 'https://www.justride.cc', 'Questions? Reply to info@justride.cc'].join('\n\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#0b100d;color:#f5f7f5;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#141a16;border:1px solid #34483d"><tr><td style="padding:32px"><a href="https://www.justride.cc" style="font-size:28px;font-weight:bold;color:#f5f7f5;text-decoration:none">Just<span style="color:#34d399">Ride</span></a><h1 style="font-size:24px;line-height:1.3;color:#f5f7f5">${escapeHtml(subject)}</h1>${paragraphs.map(p => `<p style="font-size:16px;line-height:1.7;color:#d2dcd5">${escapeHtml(p)}</p>`).join('')}${action ? `<p style="padding:16px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#34d399;color:#0b100d;padding:14px 20px;font-weight:bold;text-decoration:none">${escapeHtml(action.label)}</a></p>` : ''}<p style="font-size:13px;line-height:1.6;color:#aab5ad">Questions? Reply to this email or contact <a href="mailto:info@justride.cc" style="color:#34d399">info@justride.cc</a>.</p></td></tr></table></td></tr></table></body></html>`;
  return { subject, html, text };
}

const firstName = (name) => String(name || 'rider').trim().split(/\s+/)[0];
const interestConfirmation = (name) => message('Thanks for your interest in JustRide', [
  `Hi ${firstName(name)},`, "Thanks for joining the JustRide interest list. We’re glad to have you along for the ride.",
  'We’ll keep you informed about product progress, early access and availability as details are confirmed.',
  'Keep your eyes on the ride. — The JustRide team',
], { label: 'Explore JustRide', url: 'https://www.justride.cc' });

const unlinkOtp = (name, otp) => message('Your JustRide device unlink code', [
  `Hi ${firstName(name)},`, `Your device unlink code is ${otp}. It expires in 10 minutes.`,
  'Do not share this code. If you did not request it, secure your account and contact us.',
]);

function passwordReset(name, token) {
  const url = new URL('/reset-password', process.env.PUBLIC_WEBSITE_URL || 'https://www.justride.cc');
  if (url.protocol !== 'https:' && process.env.NODE_ENV !== 'development') throw new Error('Invalid public website URL');
  // Fragment keeps the reset token out of HTTP access logs and Referer headers.
  url.hash = token;
  return message('Reset your JustRide password', [`Hi ${firstName(name)},`,
    'Use the link below to choose a new password. It expires in 15 minutes.',
    'If you did not request this, you can ignore this email.'], { label: 'Reset password', url: url.toString() });
}

const accountConfirmation = (name) => message('Welcome to JustRide', [`Hi ${firstName(name)},`,
  'Your JustRide account has been created. You can now sign in to the JustRide app.',
  'If you did not create this account, contact us.']);
const passwordChanged = (name) => message('Your JustRide password was changed', [`Hi ${firstName(name)},`,
  'Your password has been reset successfully.', 'If this was not you, contact us immediately.']);

module.exports = { interestConfirmation, unlinkOtp, passwordReset, accountConfirmation, passwordChanged };
