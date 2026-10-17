const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  article_id: { type: String, required: true },
  helpful: { type: Boolean, required: true },
}, { timestamps: true });
schema.index({ user_id: 1, article_id: 1 }, { unique: true });
schema.plugin(require('./plugins/invalidateAdminCache'), { groups: ['support'] });
module.exports = mongoose.model('HelpFeedback', schema);
