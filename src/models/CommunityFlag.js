const { Schema, model } = require('mongoose');
const schema = new Schema({
  reporter: { type: Schema.Types.ObjectId, required: true },
  subjectType: { type: String, enum: ['ride', 'assistance', 'rider'], required: true },
  subject: { type: Schema.Types.ObjectId, required: true },
  context: { type: Schema.Types.ObjectId, default: null },
  reason: { type: String, required: true, maxlength: 500 },
  state: { type: String, enum: ['pending', 'dismissed', 'actioned'], default: 'pending' },
}, { timestamps: true });
schema.index({ reporter: 1, subjectType: 1, subject: 1, context: 1 }, { unique: true });
schema.index({ state: 1, createdAt: 1, _id: 1 });
module.exports = model('CommunityFlag', schema);
