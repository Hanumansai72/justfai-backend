const express = require("express");
const router = express.Router();

const { protect, authorize } = require("../middlewares/authMiddleware");
const { authIpLimiter, loginLimiter, registerLimiter, googleLimiter, refreshLimiter, logoutLimiter, passwordResetLimiter, resetVerifyLimiter, userReadLimiter, profileWriteLimiter, userWriteLimiter, adminReadLimiter } = require("../security/rateLimiter");
const validate = require("../security/validate");
const { otpSendLimiter, otpVerifyLimiter } = require('../security/rateLimiter');
const { getDeletionStatus, requestDeletionOtp, deleteAccount } = require('../controllers/accountDeletion.controller');

const {
  register,
  login,
  googleAuth,
  refreshToken,
  logout,
  forgotPassword,
  resetPassword,
  changePassword,
  getMe,
  updateProfile,
  getAllUsers,
} = require("../controllers/userController");

// ── Public Auth Routes ─────────────────────────────────────────
router.post("/register",              authIpLimiter, registerLimiter, validate.register,       register);
router.post("/login",                 authIpLimiter, loginLimiter, validate.login,          login);
router.post("/google",                authIpLimiter, googleLimiter,                          googleAuth);
router.post("/refresh-token",         refreshLimiter,                          refreshToken);
router.post("/logout",                                                      logoutLimiter, logout);
router.post("/forgot-password",       authIpLimiter, passwordResetLimiter, validate.forgotPassword, forgotPassword);
router.post("/reset-password/:token", resetVerifyLimiter, validate.resetPassword,  resetPassword);
router.post("/reset-password",        resetVerifyLimiter, validate.resetPassword,  resetPassword);

// ── Authenticated User Routes ──────────────────────────────────
router.get("/me",              protect, userReadLimiter,                                    getMe);
router.put("/profile",         protect, profileWriteLimiter, validate.updateProfile,            updateProfile);
router.put("/change-password", protect, profileWriteLimiter, validate.changePassword, changePassword);
router.get('/deletion-status', protect, authorize('USER'), userReadLimiter, getDeletionStatus);
router.post('/delete-account/otp', protect, authorize('USER'), otpSendLimiter, requestDeletionOtp);
router.delete('/me', protect, authorize('USER'), otpVerifyLimiter, deleteAccount);
router.delete('/delete-account', protect, authorize('USER'), otpVerifyLimiter, deleteAccount);

// ── Admin-only Routes ──────────────────────────────────────────
router.get("/",         protect, authorize("ADMIN"), adminReadLimiter,                         getAllUsers);

module.exports = router;
