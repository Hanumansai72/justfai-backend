const express = require("express");
const router = express.Router();

const { protect, authorize } = require("../middlewares/authMiddleware");
const { authLimiter } = require("../security/rateLimiter");
const validate = require("../security/validate");

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
  updateUserRole,
  getAllUsers,
  deleteAccount,
} = require("../controllers/userController");

// ── Public Auth Routes ─────────────────────────────────────────
router.post("/register",              authLimiter, validate.register,       register);
router.post("/login",                 authLimiter, validate.login,          login);
router.post("/google",                authLimiter,                          googleAuth);
router.post("/refresh-token",         authLimiter,                          refreshToken);
router.post("/logout",                                                      logout);
router.post("/forgot-password",       authLimiter, validate.forgotPassword, forgotPassword);
router.post("/reset-password/:token", authLimiter, validate.resetPassword,  resetPassword);
router.post("/reset-password",        authLimiter, validate.resetPassword,  resetPassword);

// ── Authenticated User Routes ──────────────────────────────────
router.get("/me",              protect,                                    getMe);
router.put("/profile",         protect, validate.updateProfile,            updateProfile);
router.put("/change-password", protect, authLimiter, validate.changePassword, changePassword);
router.delete("/me",           protect,                                    deleteAccount);
router.delete("/delete-account", protect,                                  deleteAccount);

// ── Admin-only Routes ──────────────────────────────────────────
router.get("/",         protect, authorize("ADMIN"),                         getAllUsers);
router.put("/:id/role", protect, authorize("ADMIN"), validate.updateUserRole, updateUserRole);

module.exports = router;
