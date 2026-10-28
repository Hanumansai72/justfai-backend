const jwt = require("jsonwebtoken");
const User = require("../models/User");

// Protect routes - verify JWT token
exports.protect = async (req, res, next) => {
  try {
    let token;

    // Check for token in Authorization header (Bearer/raw), custom headers, or HTTP-only cookies
    if (req.headers.authorization) {
      if (req.headers.authorization.toLowerCase().startsWith("bearer ")) {
        token = req.headers.authorization.split(" ")[1];
      } else {
        token = req.headers.authorization.trim();
      }
    } else if (req.headers["x-auth-token"]) {
      token = req.headers["x-auth-token"];
    } else if (req.cookies && (req.cookies.accessToken || req.cookies.token)) {
      token = req.cookies.accessToken || req.cookies.token;
    }

    if (!token) {
      return res.status(401).json({ success: false, message: "Not authorized, no token" });
    }

    // Verify token
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) throw new Error("JWT_SECRET must be configured");
    let decoded;
    try {
      decoded = jwt.verify(token, jwtSecret);
    } catch (error) {
      if (!['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) throw error;
      return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
    }
    if (!decoded?.id) return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
    req.user = await User.findById(decoded.id)
      .select("role status status_reason name email employee_id +credential_version")
      .lean();

    // If not found in Users, check Helper (Customer Care Staff) collection
    if (!req.user) {
      const Helper = require("../models/Helper.model");
      req.user = await Helper.findById(decoded.id)
        .select("role status status_reason name email employee_id")
        .lean();
    }

    if (!req.user) {
      return res.status(401).json({ success: false, message: "Account not found" });
    }

    if (req.user.role === 'ADMIN' && (decoded.credential_version || 0) !== (req.user.credential_version || 0)) {
      return res.status(401).json({ success: false, message: 'Password changed. Please sign in again.' });
    }

    // Security check: Block suspended or banned accounts immediately
    if (req.user.status && req.user.status !== "active") {
      return res.status(403).json({
        success: false,
        message: `Account is ${req.user.status}${req.user.status_reason ? `: ${req.user.status_reason}` : ". Contact support."}`,
      });
    }

    next();
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
    }
    // Database/configuration failures are service errors, not expired credentials.
    return next(error);
  }
};

// Grant access to specific roles (e.g. authorize("ADMIN"))
exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `User role '${req.user ? req.user.role : "Unknown"}' is not authorized to perform this action`,
      });
    }
    next();
  };
};

