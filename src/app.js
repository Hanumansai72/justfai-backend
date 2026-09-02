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
const { generalLimiter } = require("./security/rateLimiter");

// Routes
const userRoutes = require("./routes/userRoutes");
const savedAddressRoutes = require("./routes/savedAddressRoutes");
const deviceRoutes = require("./routes/deviceRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const supportRoutes = require("./routes/supportRoutes");
const chatRoutes = require("./routes/chatRoutes");
const uploadRoutes = require("./routes/uploadRoutes");
const adminRoutes = require("./routes/adminRoutes");

const app = express();

// Trust reverse proxies (Vercel, Render, Cloudflare, AWS, Nginx)
app.set("trust proxy", 1);

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
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:8080",
      "https://justride-admin.vercel.app",
      "https://justrideadminpage.vercel.app",
    ];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, Postman)
      if (!origin) return callback(null, true);

      // Wildcard origin support
      if (allowedOrigins.includes("*")) {
        return callback(null, true);
      }

      // Allow any localhost / 127.0.0.1 port
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }

      // Allow all JustRide and Vercel deployed frontends (*.vercel.app)
      try {
        const hostname = new URL(origin).hostname;
        if (hostname.endsWith(".vercel.app") || hostname.endsWith("justride.io")) {
          return callback(null, true);
        }
      } catch (e) {}

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: Origin '${origin}' is not allowed`));
      }
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-auth-token", "Accept", "Origin"],
    credentials: true,
  })
);

// ─────────────────────────────────────────────────────────────
// Global Rate Limiter (100 req/min per IP)
// ─────────────────────────────────────────────────────────────
app.use(generalLimiter);

// ─────────────────────────────────────────────────────────────
// HTTP Logging
// ─────────────────────────────────────────────────────────────
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

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
// Security Audit Logger
// ─────────────────────────────────────────────────────────────
app.use(securityLogger);

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

// ─────────────────────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────────────────────
app.get("/api/app-releases/latest", getLatestAppUpdate);
app.use("/api/users", userRoutes);
app.use("/api/addresses", savedAddressRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/admin", adminRoutes);

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
