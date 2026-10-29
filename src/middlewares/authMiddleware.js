
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

    req.user = await require('../security/session').authenticateAccessToken(token);

    next();
  } catch (error) {
    if (error.statusCode === 401 || error.statusCode === 403) return res.status(error.statusCode).json({ success: false, message: error.message });
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

