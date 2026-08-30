const { log } = require("../security/auditLogger");

const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || "Internal Server Error";

  // Log server-side errors to audit log
  if (statusCode >= 500) {
    console.error(`[Error] ${req.method} ${req.originalUrl}:`, err.stack);
    log({
      req,
      category: "SYSTEM",
      action: "SERVER_ERROR",
      status: "FAILURE",
      message: `${req.method} ${req.originalUrl} → ${statusCode}: ${message}`,
      metadata: { statusCode, error: message },
    });
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

module.exports = errorHandler;

