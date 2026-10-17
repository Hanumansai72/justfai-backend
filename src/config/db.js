const mongoose = require("mongoose");

// Only set custom DNS fallback in local development if explicitly enabled
if (process.env.NODE_ENV === "development" && process.env.ENABLE_CUSTOM_DNS === "true") {
  try {
    const dns = require("dns");
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
  } catch (e) {
    // Ignore in environments where DNS modification is restricted
  }
}

let cachedConnection = null;
let connectionPromise = null;

const connectDB = async () => {
  // If already connected (readyState 1), reuse existing connection
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }
  if (connectionPromise) return connectionPromise;

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error("MONGO_URI must be configured");

  connectionPromise = mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
  })
    .then(async (conn) => {
      await require('./verifyAdmin')();
      cachedConnection = conn;
      console.log("MongoDB Connected Successfully");
      console.log(`Host: ${conn.connection.host}`);
      console.log(`Database: ${conn.connection.name}`);
      return conn;
    })
    .catch((error) => {
      console.error("MongoDB Connection Error:", error.message);
      if (process.env.NODE_ENV !== "production") {
        // Don't crash serverless container abruptly on temporary network glitch
        console.warn("Retrying on next request...");
      }
      throw error;
    }).finally(() => {
      connectionPromise = null;
    });
  return connectionPromise;
};

module.exports = connectDB;
