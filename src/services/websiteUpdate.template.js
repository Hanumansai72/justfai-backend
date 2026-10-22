const { createHash } = require('node:crypto');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SUBJECT = 'A fresh look at JustRide Aventura';
const TEST_RECIPIENT = 'hanumansai72@gmail.com';

function websiteUpdate(name = 'rider', unsubscribeUrl = '', test = false, directPermission = false) {
  const firstName = String(name || 'rider').trim().split(/\s+/)[0];
  const paragraphs = [
    `Hi ${firstName},`,
    'Thanks for being part of the JustRide early-interest community.',
    'We\u2019ve refreshed our website! Explore Aventura\u2019s 1.75-inch display and preview its navigation, call alerts and music controls.',
    'Price coming soon. You\u2019re already on our interest list\u2014there\u2019s no need to register again.',
  ];
  const footer = test ? 'TEST PREVIEW: No subscribers have been contacted.' : directPermission ? 'You registered interest in JustRide and confirmed you would like to receive this update.' : 'You opted in to JustRide product and availability updates.';
  const text = [...paragraphs, 'Explore the website: https://justride.cc', 'Every journey has a story.', 'Team JustRide',
    'Questions? Reply to info@justride.cc', footer, ...(unsubscribeUrl ? [`Unsubscribe from product updates: ${unsubscribeUrl}`] : [])].join('\n\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#080a09;color:#eff1ed;font-family:Arial,Helvetica,sans-serif"><div style="display:none;max-height:0;overflow:hidden">A fresh look at Aventura. Explore the display and stay connected to what comes next.</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#080a09"><tr><td align="center" style="padding:36px 18px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px"><tr><td style="padding:20px 12px"><a href="https://justride.cc" style="font-size:28px;font-weight:bold;color:#eff1ed;text-decoration:none">Just<span style="color:#70e8a6">Ride</span></a><p style="color:#70e8a6;font-size:12px;letter-spacing:2px;margin:36px 0 14px">A FRESH LOOK</p><h1 style="font-size:42px;line-height:1.1;font-weight:500;letter-spacing:-1px;margin:0 0 28px">The next chapter<br>of Aventura.</h1>${paragraphs.map(p => `<p style="font-size:16px;line-height:1.75;color:#d3dcd5;margin:0 0 18px">${escape(p)}</p>`).join('')}<table role="presentation" cellspacing="0" cellpadding="0" style="margin:28px 0 36px"><tr><td bgcolor="#70e8a6" style="border-radius:30px"><a href="https://justride.cc" style="display:inline-block;padding:16px 26px;color:#080a09;font-size:16px;font-weight:bold;text-decoration:none">Explore the website &rarr;</a></td></tr></table><p style="font-size:20px;line-height:1.4;color:#70e8a6;margin:0 0 12px">Every journey has a story.</p><p style="font-size:15px;color:#eff1ed">Team JustRide</p><p style="font-size:12px;line-height:1.8;color:#bbc3bd;margin-top:36px">${footer}<br>Questions? <a href="mailto:info@justride.cc" style="color:#70e8a6">info@justride.cc</a>${unsubscribeUrl ? `<br><a href="${escape(unsubscribeUrl)}" style="color:#bbc3bd">Unsubscribe from product updates</a>` : ''}</p></td></tr></table></td></tr></table></body></html>`;
  return { subject: test ? `[TEST] ${SUBJECT}` : SUBJECT, html, text };
}

const contentHash = () => createHash('sha256').update(websiteUpdate('rider', 'https://example.com/unsubscribe').html).digest('hex');
module.exports = { websiteUpdate, contentHash, SUBJECT, TEST_RECIPIENT };
