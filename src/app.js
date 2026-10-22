const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");

// Middlewares
const errorHandler = require("./middlewares/errorHandler");

// Security layer
const { sanitizeMongo, sanitizeXss } = require("./security/sanitize");
const securityLogger = require("./security/securityLogger");
const { generalLimiter, publicReadLimiter } = require("./security/rateLimiter");

// Routes
const userRoutes = require("./routes/userRoutes");
const savedAddressRoutes = require("./routes/savedAddressRoutes");
const deviceRoutes = require("./routes/deviceRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const supportRoutes = require("./routes/supportRoutes");
const chatRoutes = require("./routes/chatRoutes");
const uploadRoutes = require("./routes/uploadRoutes");
const adminRoutes = require("./routes/adminRoutes");
const earlyInterestRoutes = require("./routes/earlyInterestRoutes");

const app = express();

// Trust reverse proxies (Vercel, Render, Cloudflare, AWS, Nginx)
app.set("trust proxy", process.env.TRUST_PROXY
  ? process.env.TRUST_PROXY.split(",").map(value => value.trim())
  : process.env.VERCEL === "1" ? 1 : false);

// ─────────────────────────────────────────────────────────────
// Security Headers
// ─────────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: process.env.NODE_ENV === "production" ? undefined : false,
    crossOriginEmbedderPolicy: false,
  })
);

// ─────────────────────────────────────────────────────────────
// CORS — restrict to known origins in production
// ─────────────────────────────────────────────────────────────
app.use(
  cors({
    ...require('./config/cors'),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposedHeaders: ["Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "RateLimit-Policy"],
    allowedHeaders: ["Content-Type", "Authorization", "x-auth-token", "Accept", "Origin"],
  })
);

// ─────────────────────────────────────────────────────────────
// Secondary IP ceiling; endpoint-specific policies run after authentication.
// ─────────────────────────────────────────────────────────────
app.use(securityLogger);
app.use(generalLimiter);

// ─────────────────────────────────────────────────────────────
// HTTP Logging
// ─────────────────────────────────────────────────────────────
morgan.token('safe-url', require('./utils/safeRequestPath'));
app.use(morgan(':method :safe-url :status :response-time ms'));

// ─────────────────────────────────────────────────────────────
// Body Parsing (10 kb limit to reject oversized payloads)
// ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cookieParser());

// ─────────────────────────────────────────────────────────────
// Input Sanitisation (must come AFTER body parsing)
// ─────────────────────────────────────────────────────────────
app.use(sanitizeMongo);
app.use(sanitizeXss);

// ─────────────────────────────────────────────────────────────
// Ensure Database Connected (Critical for Serverless/Cloud Lambdas)
// ─────────────────────────────────────────────────────────────
const mongoose = require("mongoose");
const connectDB = require("./config/db");

app.use(async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      await connectDB();
    }
    next();
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ message: "JustRide API is running 🚀", env: process.env.NODE_ENV });
});

const { getLatestAppUpdate } = require("./controllers/admin/appRelease.controller");
const { getLatestPublicFirmware } = require("./controllers/admin/firmware.controller");

// ─────────────────────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────────────────────
app.get("/api/app-releases/latest", publicReadLimiter, getLatestAppUpdate);
app.get("/api/firmware/latest",     publicReadLimiter, getLatestPublicFirmware);
app.use("/api/users", userRoutes);
app.use("/api/addresses", savedAddressRoutes);
app.use('/api/rides', require('./routes/rideRoutes'));
app.use('/api/maps', require('./routes/mapRoutes'));
app.use("/api/devices", deviceRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/early-interest", require("./routes/websiteUpdateRoutes"));
app.use("/api/early-interest", earlyInterestRoutes);

// ─────────────────────────────────────────────────────────────
// 404 Handler
// ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
});

// ─────────────────────────────────────────────────────────────
// Global Error Handler
// ─────────────────────────────────────────────────────────────
app.use(errorHandler);

module.exports = app;
