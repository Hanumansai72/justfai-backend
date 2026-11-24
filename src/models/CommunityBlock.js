const { Schema, model } = require('mongoose');
const schema = new Schema({
  blocker: { type: Schema.Types.ObjectId, required: true },
  blocked: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });
schema.index({ blocker: 1, blocked: 1 }, { unique: true });
schema.index({ blocked: 1, blocker: 1 });
module.exports = model('CommunityBlock', schema);
