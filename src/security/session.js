const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Helper = require('../models/Helper.model');
const fail = (message, statusCode = 401) => Object.assign(new Error(message), { statusCode });

async function authenticateAccessToken(token) {
  if (typeof token !== 'string' || !token) throw fail('Not authorized, no token');
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET must be configured');
  let decoded;
  try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
  catch (error) {
    if (['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) throw fail('Not authorized, token failed');
    throw error;
  }
  if (!decoded?.id) throw fail('Not authorized, token failed');
  const fields = 'name email username avatar role status status_reason employee_id +credential_version';
  let user = await User.findById(decoded.id).select(fields).lean();
  if (!user) user = await Helper.findById(decoded.id).select(fields).lean();
  if (!user) throw fail('Account not found');
  if (user.status && user.status !== 'active') throw fail('Account is no longer active.', 403);
  if ((decoded.credential_version || 0) !== (user.credential_version || 0)) throw fail('Session revoked. Please sign in again.');
  if (user.role === 'ADMIN') {
    if (typeof decoded.sid !== 'string' || !await User.exists({ _id: user._id, role: 'ADMIN',
      refresh_tokens: { $elemMatch: { session_id: decoded.sid, scope: 'admin', expires_at: { $gt: new Date() } } },
    })) throw fail('Admin session ended. Please sign in again.');
    user.admin_session_id = decoded.sid;
  }
  if (["SENIOR_HELPER", "LEAD_SUPPORT"].includes(user.role)) { user.staff_role = user.role; user.role = "HELPER"; }
  return user;
}

function disconnectUser(userId) {
  // HTTP-only/serverless instances may have no attached Socket.IO server.
  const { getIO } = require('../socket');
  let io; try { io = getIO(); } catch { return; }
  try { io.in(`user:${userId}`).disconnectSockets(true); } catch (error) { console.warn("Socket revocation deferred to session validation:", error.message); }
}

function disconnectAdminSession(sessionId) {
  try { require('../socket').getIO().in(`admin-session:${sessionId}`).disconnectSockets(true); }
  catch { /* Every request and socket event also checks stored session membership. */ }
}

module.exports = { authenticateAccessToken, disconnectUser, disconnectAdminSession };
