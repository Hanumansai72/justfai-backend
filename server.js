const http = require("http");
const dotenv = require("dotenv");
dotenv.config();

const app = require("./src/app");
const connectDB = require("./src/config/db");
const seedAdmin = require("./src/config/seedAdmin");
const { startWorkers } = require("./src/workers");
const { initSocket } = require("./src/socket");

const PORT = process.env.PORT || 5000;

connectDB().then(async () => {
  // Ensure default Admin credentials exist in database
  await seedAdmin();

  // Start background message queue workers
  startWorkers();

  // Create HTTP server & bind Socket.IO with Redis Adapter
  const server = http.createServer(app);
  initSocket(server);

  server.listen(PORT, () => {
    console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
    console.log(`Socket.IO Real-time Chat initialized on port ${PORT} 💬⚡`);
  });
});
