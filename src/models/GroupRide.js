const mongoose = require('mongoose');
const { Schema } = mongoose;

const locationSchema = new Schema({
  lat: Number,
  lng: Number,
  updatedAt: Date,
}, { _id: false });
const memberSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  location: locationSchema,
}, { _id: false });

const schema = new Schema({
  owner: { type: Schema.Types.ObjectId, required: true },
  code: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, expires: 0 },
  members: [memberSchema],
});

// One active group per rider. The join update also excludes an existing member.
schema.index({ 'members.userId': 1 }, { unique: true });

module.exports = mongoose.model('GroupRide', schema);
