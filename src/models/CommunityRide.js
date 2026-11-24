const { Schema, model } = require('mongoose');
const oid = Schema.Types.ObjectId;
const request = new Schema({
  rider: { type: oid, required: true },
  kind: { type: String, enum: ['join', 'invite'], default: 'join' },
  state: { type: String, enum: ['pending', 'accepted', 'rejected', 'cancelled'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });
const ride = new Schema({
  host: { type: oid, required: true },
  title: { type: String, required: true, maxlength: 100 },
  origin: { type: String, required: true, maxlength: 100 },
  destination: { type: String, required: true, maxlength: 100 },
  departureAt: { type: Date, required: true },
  returnAt: { type: Date, default: null },
  meetingPoint: { type: String, maxlength: 120, default: '' },
  capacity: { type: Number, min: 2, max: 15, required: true },
  pace: { type: String, enum: ['relaxed', 'steady', 'brisk'], required: true },
  experienceLevel: { type: String, enum: ['any', 'beginner', 'intermediate', 'experienced'], default: 'any' },
  budget: { type: Number, min: 0, max: 10000000, default: null },
  description: { type: String, maxlength: 1000, default: '' },
  visibility: { type: String, enum: ['public', 'private'], default: 'public' },
  state: { type: String, enum: ['planned', 'cancelled', 'completed'], default: 'planned' },
  participants: { type: [oid], default: [] },
  requests: { type: [request], default: [] },
}, { timestamps: true });
ride.index({ visibility: 1, state: 1, departureAt: 1, _id: 1 });
ride.index({ host: 1, state: 1, departureAt: 1 });
ride.index({ participants: 1, departureAt: 1 });
module.exports = model('CommunityRide', ride);
