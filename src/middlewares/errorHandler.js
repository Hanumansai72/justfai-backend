const { log } = require("../security/auditLogger");
const safeRequestPath = require('../utils/safeRequestPath');

const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || "Internal Server Error";

  // Log server-side errors to audit log
  if (statusCode >= 500) {
    const path = safeRequestPath(req);
    console.error(`[Error] ${req.method} ${path}:`, err.name || 'Error');
    log({
      req,
      category: "SYSTEM",
      action: "SERVER_ERROR",
      status: "FAILURE",
      message: `${req.method} ${path} → ${statusCode}`,
      metadata: { statusCode, errorType: err.name || 'Error' },
    });
  }

  res.status(statusCode).json({
    success: false,
    message: statusCode >= 500 && process.env.NODE_ENV === 'production' ? 'Internal Server Error' : message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

module.exports = errorHandler;

