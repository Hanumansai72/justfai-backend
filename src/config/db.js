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

const connectDB = async () => {
  // If already connected (readyState 1), reuse existing connection
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }

  const mongoUri =
    process.env.MONGO_URI ||
    "mongodb+srv://hanumansai72_db_user:lLoWiMGYc1zz6FFC@cluster0.adldhhz.mongodb.net/justride?appName=Cluster0";

  try {
    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
    });

    cachedConnection = conn;
    console.log("MongoDB Connected Successfully");
    console.log(`Host: ${conn.connection.host}`);
    console.log(`Database: ${conn.connection.name}`);
    return conn;
  } catch (error) {
    console.error("MongoDB Connection Error:", error.message);
    if (process.env.NODE_ENV !== "production") {
      // Don't crash serverless container abruptly on temporary network glitch
      console.warn("Retrying on next request...");
    }
    throw error;
  }
};

module.exports = connectDB;