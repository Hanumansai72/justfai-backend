const { log } = require("../security/auditLogger");
const safeRequestPath = require('../utils/safeRequestPath');

const errorHandler = (err, req, res, next) => {
  const statusCode = err.name === 'MulterError' ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
    : err.name === 'ValidationError' || err.name === 'CastError' ? 400
    : err.code === 11000 ? 409 : err.statusCode || err.status || 500;
  const message = process.env.NODE_ENV === 'production' && err.code === 11000 ? 'Resource already exists'
    : process.env.NODE_ENV === 'production' && ['CastError', 'ValidationError'].includes(err.name) ? 'Invalid request details'
    : err.message || "Internal Server Error";

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

