const mongoose = require('mongoose');
const User = require('./User');

// Use the existing record and collection: no password/ID migration or new account.
const adminSchema = User.schema.clone();
adminSchema.path('role', {
  type: String, required: true, enum: ['ADMIN'], default: 'ADMIN', immutable: true,
});

adminSchema.pre(/^find/, function () {
  this.where({ role: 'ADMIN' });
});

module.exports = mongoose.model('Admin', adminSchema, User.collection.name);
