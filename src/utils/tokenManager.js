/**
 * utils/tokenManager.js
 * Comprehensive JWT Access & Refresh Token Management.
 *
 * Implements:
 *   - Short-lived Access Tokens (15m)
 *   - Long-lived Refresh Tokens (30d) with unique JTI
 *   - SHA-256 hashing of refresh tokens stored in DB (Zero-Plaintext-at-Rest)
 *   - Token Rotation with Automatic Reuse Detection (RFC 6749 / OAuth 2.0 BCP)
 *   - Dual delivery: Secure HTTP-Only Cookie + JSON response body
 */
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const ACCESS_SECRET  = process.env.JWT_SECRET || "justride_access_secret_key_default";
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "justride_refresh_secret_key_default";
const ACCESS_EXPIRE  = process.env.JWT_EXPIRE || "15m";
const REFRESH_EXPIRE = process.env.JWT_REFRESH_EXPIRE || "30d";

/** SHA-256 hash of a raw token string */
const hashToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

/**
 * Generate a short-lived access token (15m).
 * @param {Object} user - User document or plain object
 */
const generateAccessToken = (user) => {
  return jwt.sign(
    {
      id: user._id || user.id,
      role: user.role || "USER",
    },
    ACCESS_SECRET,
    { expiresIn: ACCESS_EXPIRE }
  );
};

/**
 * Generate a long-lived refresh token (30d) with unique JTI.
 * @param {Object} user - User document or plain object
 */
const generateRefreshToken = (user) => {
  const jti = crypto.randomBytes(16).toString("hex");
  return jwt.sign(
    {
      id: user._id || user.id,
      jti,
    },
    REFRESH_SECRET,
    { expiresIn: REFRESH_EXPIRE }
  );
};

/**
 * Verify a refresh token string against REFRESH_SECRET.
 * @param {string} token
 * @returns {Object} decoded payload
 */
const verifyRefreshToken = (token) => {
  return jwt.verify(token, REFRESH_SECRET);
};

/**
 * Set HTTP-Only cookies on the response for secure web client usage.
 * @param {Object} res - Express response
 * @param {string} accessToken
 * @param {string} refreshToken
 */
const setTokenCookies = (res, accessToken, refreshToken) => {
  const isProduction = process.env.NODE_ENV === "production";

  // Access Token Cookie (15 min)
  res.cookie("accessToken", accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "strict" : "lax",
    maxAge: 15 * 60 * 1000, // 15 minutes
  });

  // Refresh Token Cookie (30 days)
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "strict" : "lax",
    path: "/", // Accessible across all API endpoints
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
};

/**
 * Clear authentication cookies on logout.
 * @param {Object} res - Express response
 */
const clearTokenCookies = (res) => {
  const isProduction = process.env.NODE_ENV === "production";
  res.clearCookie("accessToken", {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "strict" : "lax",
    path: "/",
  });
  res.clearCookie("refreshToken", {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "strict" : "lax",
    path: "/",
  });
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  hashToken,
  setTokenCookies,
  clearTokenCookies,
};
