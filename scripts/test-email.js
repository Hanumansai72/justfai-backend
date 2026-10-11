require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const { sendEmail } = require('../src/services/email.service');
const { interestConfirmation } = require('../src/services/email.templates');

(async () => {
  if (!process.env.MAIL_PASSWORD) {
    console.log('MAIL_PASSWORD is missing. Add it privately to .env.');
    process.exitCode = 1;
    return;
  }
  try {
    await connectDB();
    const result = await sendEmail({ to: 'info@justride.cc', ...interestConfirmation('JustRide team') });
    console.log(result.sent ? 'SMTP accepted the test. Check Webmail and received-message authentication headers.' : `Test not sent: ${result.code}`);
    if (!result.sent) process.exitCode = 1;
  } catch { console.log('Test setup failed. Check database connectivity privately.'); process.exitCode = 1; }
  finally { await mongoose.disconnect(); }
})();
