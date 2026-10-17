/**
 * config/seedAdmin.js
 * Automatic Admin Provisioner & Seeder.
 * Ensures a default Admin account exists in the database on boot.
 */
const User = require("../models/User");

const seedAdmin = async () => {
  if (process.env.SEED_ADMIN !== "true") return;
  try {
    const adminEmail    = process.env.ADMIN_DEFAULT_EMAIL;
    const adminUsername = process.env.ADMIN_DEFAULT_USERNAME;
    const adminPassword = process.env.ADMIN_DEFAULT_PASSWORD;
    if (!adminEmail || !adminUsername || !adminPassword || adminPassword.length < 12) {
      throw new Error('Admin seed requires explicit email, username and a password of at least 12 characters');
    }

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

      console.log('[Seed] Admin account created');
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
