const dns = require("dns");
const mongoose = require("mongoose");

// Fix MongoDB Atlas SRV DNS resolution issue
dns.setServers([
  "8.8.8.8",
  "1.1.1.1"
]);

const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is not defined in .env");
    }

    const conn = await mongoose.connect("mongodb+srv://hanumansai72_db_user:lLoWiMGYc1zz6FFC@cluster0.adldhhz.mongodb.net/justride?appName=Cluster0", {
      family: 4,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });

    console.log("MongoDB Connected Successfully");
    console.log(`Host: ${conn.connection.host}`);
    console.log(`Database: ${conn.connection.name}`);
  } catch (error) {
    console.error("MongoDB Connection Error:", error.message);

    // Helpful diagnostics
    if (error.code === "ECONNREFUSED") {
      console.error(
        "DNS connection was refused. Using Google/Cloudflare DNS: 8.8.8.8 / 1.1.1.1"
      );
    }

    process.exit(1);
  }
};

module.exports = connectDB;