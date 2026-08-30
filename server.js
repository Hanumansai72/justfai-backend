const dotenv = require("dotenv");
dotenv.config();

const app = require("./src/app");
const connectDB = require("./src/config/db");
const seedAdmin = require("./src/config/seedAdmin");
const { startWorkers } = require("./src/workers");

const PORT = process.env.PORT || 5000;

connectDB().then(async () => {
  // Ensure default Admin credentials exist in database
  await seedAdmin();

  // Start background message queue workers
  startWorkers();

  app.listen(PORT, () => {
    console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
  });
});
