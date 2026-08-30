/**
 * config/seedAdmin.js
 * Automatic Admin Provisioner & Seeder.
 * Ensures a default Admin account exists in the database on boot.
 */
const User = require("../models/User");

const seedAdmin = async () => {
  try {
    const adminEmail    = process.env.ADMIN_DEFAULT_EMAIL || "admin@justride.io";
    const adminUsername = process.env.ADMIN_DEFAULT_USERNAME || "admin";
    const adminPassword = (process.env.ADMIN_DEFAULT_PASSWORD && process.env.ADMIN_DEFAULT_PASSWORD.length >= 6)
      ? process.env.ADMIN_DEFAULT_PASSWORD
      : "AdminPassword123!";

    // Check if an admin account already exists
    const existingAdmin = await User.findOne({
      $or: [{ username: adminUsername }, { email: adminEmail }, { role: "ADMIN" }],
    });

    if (!existingAdmin) {
      await User.create({
        name: "Super Administrator",
        username: adminUsername,
        email: adminEmail,
        password: adminPassword, // Automatically hashed with bcrypt via User schema pre-save hook
        role: "ADMIN",
        status: "active",
      });

      console.log(`[Seed] Default Admin account created: username="${adminUsername}", email="${adminEmail}" (pwd: ${adminPassword}) 🛡️`);
    } else {
      if (!existingAdmin.username) {
        existingAdmin.username = adminUsername;
        await existingAdmin.save({ validateBeforeSave: false });
      }
    }
  } catch (err) {
    console.error("[Seed] Error seeding default admin account:", err.message);
  }
};

module.exports = seedAdmin;
