const Admin = require('../../models/Admin.model');
const { clearTokenCookies } = require('../../utils/tokenManager');
const { disconnectAdminSession } = require('../../security/session');
const audit = require('../../security/auditLogger');

exports.list = async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    const account = await Admin.findById(req.user._id).select('+refresh_tokens').lean();
    if (!account) return res.status(401).json({ success: false, message: 'Account not found.' });
    const sessions = (account.refresh_tokens || []).filter(session => session.scope === 'admin' &&
      session.session_id && session.expires_at > new Date()).map(session => ({
      id: session.session_id, current: session.session_id === req.user.admin_session_id,
      signed_in_at: session.signed_in_at || session.created_at, expires_at: session.expires_at,
      ip: session.ip || 'Unavailable', user_agent: session.user_agent || '', location: session.location || 'Unavailable',
    })).sort((a, b) => Number(b.current) - Number(a.current) || new Date(b.signed_in_at) - new Date(a.signed_in_at));
    return res.json({ success: true, data: sessions });
  } catch (error) { next(error); }
};

exports.revoke = async (req, res, next) => {
  try {
    const id = req.params.sessionId;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ success: false, message: 'Invalid session.' });
    const result = await Admin.updateOne({ _id: req.user._id, refresh_tokens: { $elemMatch: { session_id: id, scope: 'admin' } } },
      { $pull: { refresh_tokens: { session_id: id, scope: 'admin' } } });
    if (!result.modifiedCount) return res.status(404).json({ success: false, message: 'This session has already ended.' });
    disconnectAdminSession(id);
    const current = id === req.user.admin_session_id;
    if (current) clearTokenCookies(res);
    audit.log({ req, category: 'ADMIN', action: 'ADMIN_SESSION_REVOKED', resource_type: 'User', resource_id: req.user._id,
      message: current ? 'Admin signed out this session.' : 'Admin remotely signed out another session.', metadata: { session_id: id } });
    return res.json({ success: true, message: 'Session signed out.', data: { current } });
  } catch (error) { next(error); }
};
