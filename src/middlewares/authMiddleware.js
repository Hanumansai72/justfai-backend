const jwt = require("jsonwebtoken");
const User = require("../models/User");

// Protect routes - verify JWT token
exports.protect = async (req, res, next) => {
  try {
    let token;

    // Check for token in Authorization header or HTTP-only cookie
    if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
      token = req.headers.authorization.split(" ")[1];
    } else if (req.cookies && req.cookies.accessToken) {
      token = req.cookies.accessToken;
    }

    if (!token) {
      return res.status(401).json({ success: false, message: "Not authorized, no token" });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
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

