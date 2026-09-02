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
    const jwtSecret = process.env.JWT_SECRET || "708b76c65be1418610a3e1401a55eda940a5b3bc0e43cd4be5ddc673ad528db1";
    const decoded = jwt.verify(token, jwtSecret);
    req.user = await User.findById(decoded.id);

    // If not found in Users, check Helper (Customer Care Staff) collection
    if (!req.user) {
      const Helper = require("../models/Helper.model");
      req.user = await Helper.findById(decoded.id);
    }

    if (!req.user) {
      return res.status(401).json({ success: false, message: "Account not found" });
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
    return res.status(401).json({ success: false, message: "Not authorized, token failed" });
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

