const { GoogleAuth } = require('google-auth-library');
const PushInstallation = require('../models/PushInstallation.model');

function configuration() {
  try {
    const credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
    return credentials.project_id && credentials.client_email && credentials.private_key ? credentials : null;
  } catch { return null; }
}

let auth;
let credentialSource;

exports.isConfigured = () => Boolean(configuration());

// FCM accepts one installation per HTTP v1 request; keep concurrency bounded.
exports.sendToUsers = async (userIds, { title, message, type, releaseId }) => {
  const credentials = configuration();
  const result = { configured: Boolean(credentials), registered: 0, accepted: 0, failed: 0 };
  if (!credentials || !userIds.length) return result;
  if (!auth || credentialSource !== process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credentialSource = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
  }
  const client = await auth.getClient();
  const installations = await PushInstallation.find({ user_id: { $in: userIds }, enabled: true }).select('fid').lean();
  result.registered = installations.length;
  for (let offset = 0; offset < installations.length; offset += 10) {
    await Promise.all(installations.slice(offset, offset + 10).map(async ({ fid }) => {
      try {
        await client.request({
          url: `https://fcm.googleapis.com/v1/projects/${credentials.project_id}/messages:send`,
          method: 'POST', timeout: 10000, retry: false,
          data: { message: {
            token: fid,
            data: { title: title.slice(0, 120), body: message.slice(0, 500), type, ...(releaseId != null && { release_id: String(releaseId) }) },
            android: { priority: 'HIGH', ttl: '86400s', restricted_package_name: process.env.ANDROID_PACKAGE_NAME || 'com.example.justride_ui' },
          } },
        });
        result.accepted++;
      } catch (error) {
        result.failed++;
        const details = error.response?.data?.error;
        const expired = details?.details?.some((detail) => detail.errorCode === 'UNREGISTERED');
        if (expired) await PushInstallation.deleteOne({ fid });
        console.warn('[Push] Delivery failed:', expired ? 'UNREGISTERED' : details?.status || 'FCM_REQUEST_FAILED');
      }
    }));
  }
  return result;
};
