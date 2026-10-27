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
    const { id_token, token, credential, code, redirect_uri, access_token } = req.body;
    const googleIdToken = id_token || credential || (token && token.length > 200 ? token : null);
    const googleAccessToken = access_token || (token && token.length <= 200 ? token : null);

    let payload;

    if (googleIdToken) {
      try {
        const allowedAudiences = [
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_ANDROID_CLIENT_ID,
          "445835744041-sst8cp392ski2jtbkno6p16438kq8r0d.apps.googleusercontent.com",
        ].filter(Boolean);

        const ticket = await googleClient.verifyIdToken({
          idToken: googleIdToken,
          audience: allowedAudiences.length > 1 ? allowedAudiences : allowedAudiences[0],
        });
        payload = ticket.getPayload();
      } catch (err) {
        // Resilient Fallback 1: Query Google's tokeninfo endpoint
        try {
          const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(googleIdToken)}`);
          if (resp.ok) {
            payload = await resp.json();
          }
        } catch (_) {}

        // Resilient Fallback 2: Test as access_token against userinfo
        if (!payload?.email) {
          try {
            const userResp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
              headers: { Authorization: `Bearer ${googleIdToken}` },
            });
            if (userResp.ok) {
              payload = await userResp.json();
            }
          } catch (_) {}
        }

        if (!payload?.email) {
          return res.status(400).json({ success: false, message: "Invalid Google ID token" });
        }
      }
    } else if (googleAccessToken) {
      try {
        const resp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: `Bearer ${googleAccessToken}` },
        });
        if (resp.ok) {
          payload = await resp.json();
        }
      } catch (err) {
        return res.status(400).json({ success: false, message: "Failed to verify Google access token" });
      }
    } else if (code) {
      try {
        const { tokens } = await googleClient.getToken({
          code,
          redirect_uri: redirect_uri || process.env.GOOGLE_REDIRECT_URI || "postmessage",
        });
        if (tokens.id_token) {
          const ticket = await googleClient.verifyIdToken({
            idToken: tokens.id_token,
            audience: process.env.GOOGLE_CLIENT_ID,
          });
          payload = ticket.getPayload();
        } else if (tokens.access_token) {
          const resp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          });
          payload = await resp.json();
        }
      } catch (err) {
        return res.status(400).json({ success: false, message: "Failed to exchange Google authorization code" });
      }
    } else {
      return res.status(400).json({ success: false, message: "Provide a Google 'id_token' or 'access_token'" });
    }

    if (!payload?.email) {
      return res.status(400).json({ success: false, message: "Could not retrieve user profile from Google" });
    }

    const { sub: google_id, email, name, picture: avatar } = payload;

    let user = await User.findOne({ $or: [{ google_id }, { email }] });
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
      await notifyNewUser(user);
    } else if (!user.google_id) {
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            google_id,
            auth_provider: "google",
            ...((!user.avatar && avatar) ? { avatar } : {}),
          },
        }
      );
      user.google_id = google_id;
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

    const exists = await User.exists({ $or: [{ email }, { phonenumber }] });
    if (exists) {
      return res.status(409).json({ success: false, message: "Email or phone number already in use" });
    }

    const user = await User.create({ name, phonenumber, email, password, role: "USER" });
    await notifyNewUser(user);
    await sendEmail({ to: user.email, ...accountConfirmation(user.name) });

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

    const user = await User.findOne({ email }).select("+password");

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
    const user = await User.findById(decoded.id).select("+refresh_tokens");

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

    // ── REUSE DETECTION (RFC 6749 / OAuth 2.0 Security BCP) ──
    const tokenExists = user.refresh_tokens?.some(
      (t) => t.token === hashedIncomingToken
    );

    if (!tokenExists) {
      // Token reuse detected! Invalidate all existing sessions for this account
      await User.updateOne({ _id: user._id }, { $set: { refresh_tokens: [] } });
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

    // Generate fresh access & refresh tokens (Rotation)
    const newAccessToken  = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);
    const hashedNewToken  = hashToken(newRefreshToken);

    // Rotate: Remove old hashed token and add the new one atomically
    await User.updateOne(
      { _id: user._id },
      {
        $pull: { refresh_tokens: { token: hashedIncomingToken } },
      }
    );
    await User.updateOne(
      { _id: user._id },
      {
        $push: {
          refresh_tokens: {
            $each: [{ token: hashedNewToken, created_at: new Date() }],
            $slice: -5,
          },
        },
      }
    );

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

    if (rawRefreshToken) {
      const hashedToken = hashToken(rawRefreshToken);

      if (logoutAll && req.user?._id) {
        // Clear all active sessions
        await User.updateOne({ _id: req.user._id }, { $set: { refresh_tokens: [] } });
      } else {
        // Remove only the specific refresh token session
        await User.updateOne(
          { "refresh_tokens.token": hashedToken },
          { $pull: { refresh_tokens: { token: hashedToken } } }
        );
      }
    } else if (req.user?._id && logoutAll) {
      await User.updateOne({ _id: req.user._id }, { $set: { refresh_tokens: [] } });
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
    if (req.body.email)       allowed.email       = req.body.email;

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
    const user = await User.findOne({ email: String(email).trim().toLowerCase() });

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
      password_reset_token: hashedToken,
      password_reset_expires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Password reset token is invalid or has expired",
      });
    }

    // Invalidate old sessions on password reset for security
    user.password = password;
    user.password_reset_token = undefined;
    user.password_reset_expires = undefined;
    user.refresh_tokens = [];

    await user.save();

    audit.log({
      req,
      category: "AUTH",
      action: "PASSWORD_RESET_SUCCESS",
      status: "SUCCESS",
      resource_type: "User",
      resource_id: user._id,
      message: `Password reset completed for: ${user.email}`,
    });

    await sendEmail({ to: user.email, ...passwordChanged(user.name) });
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
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user._id).select("+password");

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!user.password && user.auth_provider === "google") {
      user.password = newPassword;
      await user.save();

      return res.status(200).json({
        success: true,
        message: "Password set successfully for your account.",
      });
    }

    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: "Current password is incorrect" });
    }

    user.password = newPassword;
    // Invalidate other refresh tokens on password change
    user.refresh_tokens = [];
    await user.save();

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
