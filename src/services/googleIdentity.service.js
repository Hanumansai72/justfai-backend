const invalid = () => Object.assign(new Error('Invalid Google sign-in credential'), { statusCode: 400 });

module.exports = async function verifyGoogleIdentity(client, input, fetcher = fetch) {
  const audiences = [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_ANDROID_CLIENT_ID].filter(Boolean);
  if (!audiences.length) throw Object.assign(new Error('Google sign-in is not configured'), { statusCode: 503 });
  const validString = value => typeof value === 'string' && value.length > 0 && value.length <= 10000;
  let idToken = input.id_token || input.credential;
  let accessToken = input.access_token;
  if (input.token && !idToken && !accessToken) {
    if (!validString(input.token)) throw invalid();
    if (input.token.split('.').length === 3) idToken = input.token;
    else accessToken = input.token;
  }
  if (input.code && !idToken && !accessToken) {
    if (!validString(input.code)) throw invalid();
    const redirect = process.env.GOOGLE_REDIRECT_URI || 'postmessage';
    if (input.redirect_uri && input.redirect_uri !== redirect) throw invalid();
    const { tokens } = await client.getToken({ code: input.code, redirect_uri: redirect });
    idToken = tokens.id_token; accessToken = tokens.access_token;
  }
  let payload;
  if (idToken) {
    if (!validString(idToken)) throw invalid();
    const ticket = await client.verifyIdToken({ idToken, audience: audiences });
    payload = ticket.getPayload();
  } else if (accessToken) {
    if (!validString(accessToken)) throw invalid();
    const info = await client.getTokenInfo(accessToken);
    if (!audiences.includes(info.aud) || (info.azp && !audiences.includes(info.azp)) ||
        !Number.isFinite(info.expiry_date) || info.expiry_date <= Date.now()) throw invalid();
    const response = await fetcher('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw invalid();
    payload = await response.json();
    if ((info.sub || info.user_id) && (info.sub || info.user_id) !== payload.sub) throw invalid();
  } else throw invalid();
  if (!payload || typeof payload.email !== 'string' || typeof payload.sub !== 'string' ||
      !payload.sub || payload.email_verified !== true) throw invalid();
  return { ...payload, email: payload.email.trim().toLowerCase() };
};
