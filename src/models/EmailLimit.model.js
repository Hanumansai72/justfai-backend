const mongoose = require('mongoose');

module.exports = mongoose.model('EmailLimit', new mongoose.Schema({
  _id: String,
  count: { type: Number, default: 0 },
  reservations: { type: [Date], default: undefined },
  resetAt: { type: Date, expires: 0 },
}, { versionKey: false }));
