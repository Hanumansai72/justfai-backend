const verifyGoogleIdentity = require('../services/googleIdentity.service');
const { waitUntil } = require('@vercel/functions');
const User = require("../models/User");
const { OAuth2Client } = require("google-auth-library");
const audit = require("../security/auditLogger");
const { notifyNewUser } = require("../queues/notification.queue");
const { sendEmail } = require('../services/email.service');
const { passwordReset, accountConfirmation, passwordChanged } = require('../services/email.templates');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  hashToken,
  setTokenCookies,
  clearTokenCookies,
} = require("../utils/tokenManager");

const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || "postmessage"
);

/** Safe user projection — never leak password, __v, or internal fields */
const USER_PROJECTION = "name email phonenumber role status status_reason avatar auth_provider createdAt";

const formatUserResponse = (user) => ({
  id:            user._id,
  name:          user.name,
  email:         user.email,
  phonenumber:   user.phonenumber || null,
  avatar:        user.avatar || null,
  auth_provider: user.auth_provider,
  role:          user.role,
  status:        user.status || "active",
});

/**
 * Helper: Issue Access + Refresh tokens, store hashed refresh token in DB,
 * set secure HTTP-only cookies, and return structured JSON response.
 */
const issueTokensAndRespond = async (res, user, statusCode = 200, customMessage = null) => {
  if (user.status && user.status !== 'active') {
    return res.status(403).json({ success: false, message: 'This account is no longer active.' });
  }
  const accessToken  = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);
  const hashedRefreshToken = hashToken(refreshToken);

  // Maintain active sessions (keep latest 5 active refresh tokens to prevent unbounded array growth)
  await User.updateOne(
    { _id: user._id },
    {
      $push: {
        refresh_tokens: {
          $each: [{ token: hashedRefreshToken, created_at: new Date() }],
          $slice: -5, // Keeps only the 5 most recent active sessions
        },
      },
    }
  );

  // Set HTTP-Only cookies for web clients
  setTokenCookies(res, accessToken, refreshToken);

  return res.status(statusCode).json({
    success: true,
    ...(customMessage && { message: customMessage }),
    token: accessToken, // Alias for clients expecting 'token'
    accessToken,
    refreshToken,
    data: formatUserResponse(user),
  });
};

// ─────────────────────────────────────────────
// @desc    Google Sign-in / Sign-up
// @route   POST /api/users/google
// @access  Public
// ─────────────────────────────────────────────
exports.googleAuth = async (req, res, next) => {
  try {
    let payload;
    try { payload = await verifyGoogleIdentity(googleClient, req.body || {}); }
    catch (error) {
      return res.status(error.statusCode === 503 ? 503 : 400).json({ success: false,
        message: error.statusCode === 503 ? 'Google sign-in is not configured.' : 'Invalid Google sign-in credential.' });
    }

    const { sub: google_id, email, name, picture: avatar } = payload;

    let user = await User.findOne({ $or: [{ google_id }, { email }] }).select("+credential_version");
    if (user && user.role !== 'USER') return res.status(403).json({ success: false, message: 'Staff must sign in through the staff portal.' });
    if (user?.status === 'deleted') {
      return res.status(403).json({ success: false, message: 'This account was deleted. Its email cannot be used again.' });
    }

    if (!user) {
      const cleanUsername = (email.split("@")[0].replace(/[^a-zA-Z0-9]/g, "") + "_" + Math.floor(1000 + Math.random() * 9000)).toLowerCase();
      user = await User.create({
        name: name || email.split("@")[0],
        username: cleanUsername,
        email,
        google_id,
        avatar,
        auth_provider: "google",
        role: "USER",
      });
      waitUntil(Promise.resolve().then(() => notifyNewUser(user)).catch(() => console.warn('[Notification] DISPATCH_FAILED')));
    } else if (user.google_id !== google_id) {
      return res.status(409).json({ success: false, message: 'Sign in using your existing account credentials. Google account linking requires a verified account-linking flow.' });
    }

    if (user.status && user.status !== "active") {
      return res.status(403).json({
        success: false,
        message: `Account is ${user.status}${user.status_reason ? `: ${user.status_reason}` : ". Contact support."}`,
      });
    }

    audit.log({
      req,
      category: "AUTH",
      action: "GOOGLE_AUTH",
      status: "SUCCESS",
      resource_type: "User",
      resource_id: user._id,
      message: `Google auth: ${user.email}`,
    });

    return await issueTokensAndRespond(res, user, 200, "Google authentication successful");
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Register a new user
// @route   POST /api/users/register
// @access  Public
// ─────────────────────────────────────────────
exports.register = async (req, res, next) => {
  try {
    const { name, phonenumber, email, password } = req.body;

    const exists = await User.exists({ $or: [{ email }, ...(phonenumber ? [{ phonenumber }] : [])] });
    if (exists) {
      return res.status(409).json({ success: false, message: "Email or phone number already in use" });
    }

    const user = await User.create({ name, phonenumber, email, password, role: "USER" });
    waitUntil(Promise.resolve().then(() => notifyNewUser(user)).catch(() => console.warn('[Notification] DISPATCH_FAILED')));
    waitUntil(Promise.resolve().then(() => sendEmail({ to: user.email, ...accountConfirmation(user.name) })).catch(() => console.warn('[Email] CONFIRMATION_FAILED')));

    audit.log({
      req,
      category: "AUTH",
      action: "USER_REGISTER",
      status: "SUCCESS",
      resource_type: "User",
      resource_id: user._id,
      message: `New user registered: ${user.email}`,
    });

    return await issueTokensAndRespond(res, user, 201, "Registration successful");
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Login user
// @route   POST /api/users/login
// @access  Public
// ─────────────────────────────────────────────
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email, role: "USER" }).select("+password +credential_version");

    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    if (user.status && user.status !== "active") {
      return res.status(403).json({
        success: false,
        message: `Account is ${user.status}${user.status_reason ? `: ${user.status_reason}` : ". Contact support."}`,
      });
    }

    audit.log({
      req,
      category: "AUTH",
      action: "USER_LOGIN",
      status: "SUCCESS",
      resource_type: "User",
      resource_id: user._id,
      message: `Login: ${user.email}`,
    });

    return await issueTokensAndRespond(res, user, 200, "Login successful");
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Refresh Access Token (Token Rotation + Reuse Detection)
// @route   POST /api/users/refresh-token
// @access  Public
// ─────────────────────────────────────────────
exports.refreshToken = async (req, res, next) => {
  try {
    // Extract refresh token from HTTP-only cookie or request body
    const rawRefreshToken = req.cookies?.refreshToken || req.body?.refreshToken;

    if (!rawRefreshToken) {
      return res.status(401).json({ success: false, message: "No refresh token provided" });
    }

    // Verify cryptographic signature and expiration
    let decoded;
    try {
      decoded = verifyRefreshToken(rawRefreshToken);
    } catch (err) {
      clearTokenCookies(res);
      return res.status(401).json({ success: false, message: "Invalid or expired refresh token" });
    }

    const hashedIncomingToken = hashToken(rawRefreshToken);

    // Fetch user including hidden refresh_tokens array
    let Model = User;
    let user = await Model.findById(decoded.id).select("+refresh_tokens +credential_version");
    if (!user) { Model = require("../models/Helper.model"); user = await Model.findById(decoded.id).select("+refresh_tokens +credential_version"); }

    if (!user) {
      clearTokenCookies(res);
      return res.status(401).json({ success: false, message: "User not found" });
    }

    if (user.status && user.status !== "active") {
      clearTokenCookies(res);
      return res.status(403).json({
        success: false,
        message: `Account is ${user.status}. Session terminated.`,
      });
    }

    if ((decoded.credential_version || 0) !== (user.credential_version || 0)) {
      clearTokenCookies(res);
      return res.status(401).json({ success: false, message: "Session revoked. Please sign in again." });
    }
    const versionFilter = user.credential_version
      ? { credential_version: user.credential_version }
      : { $or: [{ credential_version: 0 }, { credential_version: { $exists: false } }] };

    // ── REUSE DETECTION (RFC 6749 / OAuth 2.0 Security BCP) ──
    const tokenExists = user.refresh_tokens?.some(
      (t) => t.token === hashedIncomingToken
    );

    if (!tokenExists) {
      // Token reuse detected! Invalidate all existing sessions for this account
      await Model.updateOne({ _id: user._id, ...versionFilter }, { $set: { refresh_tokens: [] }, $inc: { credential_version: 1 } });
      require("../security/session").disconnectUser(user._id);
      clearTokenCookies(res);

      audit.log({
        req,
        category: "SECURITY",
        action: "REFRESH_TOKEN_REUSE_DETECTED",
        status: "BLOCKED",
        resource_type: "User",
        resource_id: user._id,
        message: `Refresh token reuse attempt on user ${user.email}. All sessions revoked.`,
      });

      return res.status(403).json({
        success: false,
        message: "Invalid refresh token. All active sessions have been revoked for security.",
      });
    }

    if (user.role === 'ADMIN' && !user.refresh_tokens?.some(session => session.token === hashedIncomingToken &&
      session.scope === 'admin' && typeof decoded.sid === 'string' && session.session_id === decoded.sid && session.expires_at > new Date())) {
      clearTokenCookies(res);
      return res.status(401).json({ success: false, message: 'Admin session ended. Please sign in again.' });
    }

    // Generate fresh access & refresh tokens (Rotation)
    const newAccessToken  = generateAccessToken(user, decoded.sid);
    const newRefreshToken = generateRefreshToken(user, decoded.sid);
    const hashedNewToken  = hashToken(newRefreshToken);

    // One conditional write ensures concurrent requests cannot reuse the same token.
    const rotated = await Model.updateOne(
      { _id: user._id, ...versionFilter, "refresh_tokens.token": hashedIncomingToken, status: "active" },
      { $set: { "refresh_tokens.$[session].token": hashedNewToken, "refresh_tokens.$[session].created_at": new Date() } },
      { arrayFilters: [{ "session.token": hashedIncomingToken }] }
    );
    if (!rotated.modifiedCount) {
      clearTokenCookies(res);
      return res.status(401).json({ success: false, message: "Session changed. Please sign in again." });
    }

    // Set updated HTTP-only cookies
    setTokenCookies(res, newAccessToken, newRefreshToken);

    audit.log({
      req,
      category: "AUTH",
      action: "TOKEN_REFRESH",
      status: "SUCCESS",
      resource_type: "User",
      resource_id: user._id,
      message: `Token refreshed for: ${user.email}`,
    });

    res.status(200).json({
      success: true,
      message: "Token refreshed successfully",
      token: newAccessToken,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Logout user (Revoke active refresh token + clear cookies)
// @route   POST /api/users/logout
// @access  Public / Private
// ─────────────────────────────────────────────
exports.logout = async (req, res, next) => {
  try {
    const rawRefreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
    const { logoutAll } = req.body || {};

    if (rawRefreshToken && typeof rawRefreshToken !== 'string') return res.status(400).json({ success: false, message: 'Invalid refresh token.' });
    if (logoutAll) {
      let decoded; try { decoded = verifyRefreshToken(rawRefreshToken); }
      catch { return res.status(401).json({ success: false, message: 'A valid refresh token is required to sign out all sessions.' }); }
      const filter = { _id: decoded.id, 'refresh_tokens.token': hashToken(rawRefreshToken) };
      const Helper = require('../models/Helper.model');
      let Model = User;
      let account = await User.findOne(filter).select('name email role');
      if (!account) { Model = Helper; account = await Helper.findOne(filter).select('name email role'); }
      if (!account) return res.status(401).json({ success: false, message: 'Session is no longer active.' });
      const revoked = await Model.updateOne(filter, { $set: { refresh_tokens: [] }, $inc: { credential_version: 1 } });
      if (!revoked.matchedCount) return res.status(401).json({ success: false, message: 'Session is no longer active.' });
      req.auditActor = account;
      require('../security/session').disconnectUser(account._id);
    } else if (rawRefreshToken) {
      const filter = { 'refresh_tokens.token': hashToken(rawRefreshToken) };
      const change = { $pull: { refresh_tokens: { token: hashToken(rawRefreshToken) } } };
      await User.updateOne(filter, change);
      await require('../models/Helper.model').updateOne(filter, change);
    }

    clearTokenCookies(res);

    audit.log({
      req,
      category: "AUTH",
      action: "USER_LOGOUT",
      status: "SUCCESS",
      resource_type: "User",
      resource_id: req.user?._id || null,
      message: `User logged out${logoutAll ? " (all sessions revoked)" : ""}`,
    });

    res.status(200).json({
      success: true,
      message: logoutAll ? "Logged out from all devices successfully" : "Logged out successfully",
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get current logged-in user
// @route   GET /api/users/me
// @access  Private
// ─────────────────────────────────────────────
exports.getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select(USER_PROJECTION).lean();

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.status(200).json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Update user profile (self-update, role-restricted)
// @route   PUT /api/users/profile
// @access  Private
// ─────────────────────────────────────────────
exports.updateProfile = async (req, res, next) => {
  try {
    if (req.body.role && req.user.role !== "ADMIN") {
      return res.status(403).json({ success: false, message: "Not authorized to change role" });
    }

    const allowed = {};
    if (req.body.name)        allowed.name        = req.body.name;
    if (req.body.phonenumber) allowed.phonenumber = req.body.phonenumber;
    if (req.body.email !== undefined && (typeof req.body.email !== 'string' || req.body.email.trim().toLowerCase() !== req.user.email)) {
      return res.status(400).json({ success: false, message: 'Changing email requires email ownership verification.' });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: allowed },
      { new: true, runValidators: true, select: USER_PROJECTION }
    ).lean();

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.status(200).json({ success: true, message: "Profile updated successfully", data: user });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get all users (Admin Only)
// @route   GET /api/users?page=1&limit=20&role=USER
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.getAllUsers = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.role && ["ADMIN", "USER"].includes(req.query.role.toUpperCase())) {
      filter.role = req.query.role.toUpperCase();
    }

    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select(USER_PROJECTION)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    res.status(200).json({
      success: true,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      count: users.length,
      data: users,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Forgot Password — Generate reset token & send email link
// @route   POST /api/users/forgot-password
// @access  Public
// ─────────────────────────────────────────────
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: String(email).trim().toLowerCase(), role: { $ne: "ADMIN" } });

    // Anti-enumeration defense
    if (!user) {
      return res.status(200).json({
        success: true,
        message: "If an account with that email exists, password reset instructions have been sent.",
      });
    }

    if (user.status && user.status !== "active") {
      return res.status(200).json({
        success: true,
        message: "If an account with that email exists, password reset instructions have been sent.",
      });
    }

    const resetToken = user.getResetPasswordToken();
    await user.save({ validateBeforeSave: false });
    let delivery;
    try { delivery = await sendEmail({ to: user.email, ...passwordReset(user.name, resetToken) }); }
    catch { delivery = { sent: false }; console.warn('[email] RESET_TEMPLATE_FAILED'); }
    if (!delivery.sent) {
      // Do not invalidate a newer concurrent request's token.
      await User.updateOne({ _id: user._id, password_reset_token: user.password_reset_token },
        { $unset: { password_reset_token: '', password_reset_expires: '' } });
    }

    audit.log({
      req,
      category: "AUTH",
      action: "FORGOT_PASSWORD_REQUEST",
      status: "SUCCESS",
      resource_type: "User",
      resource_id: user._id,
      message: `Password reset requested for: ${user.email}`,
    });

    res.status(200).json({
      success: true,
      message: "If an account with that email exists, password reset instructions have been sent.",
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Reset Password using valid token
// @route   POST /api/users/reset-password/:token OR POST /api/users/reset-password
// @access  Public
// ─────────────────────────────────────────────
exports.resetPassword = async (req, res, next) => {
  try {
    const crypto = require("crypto");
    const rawToken = req.params.token || req.body.token;
    const { password } = req.body;

    if (!rawToken) {
      return res.status(400).json({ success: false, message: "Reset token is required" });
    }

    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

    const user = await User.findOne({
      role: { $ne: "ADMIN" },
      password_reset_token: hashedToken,
      password_reset_expires: { $gt: new Date() },
    }).select("+credential_version");

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Password reset token is invalid or has expired",
      });
    }

    // Invalidate old sessions on password reset for security
    user.password = password;
    user.credential_version = (user.credential_version || 0) + 1;
    user.password_reset_token = undefined;
    user.password_reset_expires = undefined;
    user.refresh_tokens = [];

    await user.save();
    require('../security/session').disconnectUser(user._id);

    audit.log({
      req,
      category: "AUTH",
      action: "PASSWORD_RESET_SUCCESS",
      status: "SUCCESS",
      resource_type: "User",
      resource_id: user._id,
      message: `Password reset completed for: ${user.email}`,
    });

    waitUntil(Promise.resolve().then(() => sendEmail({ to: user.email, ...passwordChanged(user.name) })).catch(() => console.warn('[Email] PASSWORD_NOTICE_FAILED')));
    return await issueTokensAndRespond(res, user, 200, "Password reset successful. You are now logged in.");
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Change Password (for logged-in users)
// @route   PUT /api/users/change-password
// @access  Private
// ─────────────────────────────────────────────
exports.changePassword = async (req, res, next) => {
  try {
    if (req.user.role === 'ADMIN') return res.status(403).json({ success: false,
      message: 'Use Admin Profile and email OTP to change the admin password.' });
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user._id).select("+password +credential_version");

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!user.password && user.auth_provider === "google") {
      user.password = newPassword;
      user.credential_version = (user.credential_version || 0) + 1;
      user.refresh_tokens = [];
      await user.save();
      require('../security/session').disconnectUser(user._id);

      return await issueTokensAndRespond(res, user, 200, 'Password set successfully for your account.');
    }

    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: "Current password is incorrect" });
    }

    user.password = newPassword;
    user.credential_version = (user.credential_version || 0) + 1;
    // Invalidate other refresh tokens on password change
    user.refresh_tokens = [];
    await user.save();
    require('../security/session').disconnectUser(user._id);

    audit.log({
      req,
      category: "AUTH",
      action: "PASSWORD_CHANGE_SUCCESS",
      status: "SUCCESS",
      resource_type: "User",
      resource_id: user._id,
      message: `Password changed for user: ${user.email}`,
    });

    return await issueTokensAndRespond(res, user, 200, "Password changed successfully");
  } catch (error) {
    next(error);
  }
};
