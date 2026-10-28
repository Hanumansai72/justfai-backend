const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  fid: { type: String, required: true, unique: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  enabled: { type: Boolean, default: false },
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model('PushInstallation', schema);
