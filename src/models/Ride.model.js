const mongoose = require('mongoose');

const placeSchema = new mongoose.Schema({
  name: String, address: String, placeId: String, rawQuery: String,
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
}, { _id: false });

const rideSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId: { type: String, required: true },
  startTime: { type: Date, required: true },
  endTime: { type: Date, required: true },
  origin: { type: placeSchema, required: true },
  destination: { type: placeSchema, required: true },
  distanceMeters: { type: Number, required: true, min: 0 },
  durationSeconds: { type: Number, required: true, min: 0 },
  averageSpeedKmh: { type: Number, required: true, min: 0 },
  maxSpeedKmh: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['completed', 'stopped'], required: true },
}, { timestamps: true, versionKey: false });

rideSchema.index({ user_id: 1, sessionId: 1 }, { unique: true });
rideSchema.index({ user_id: 1, endTime: -1, _id: -1 });

module.exports = mongoose.model('Ride', rideSchema);
