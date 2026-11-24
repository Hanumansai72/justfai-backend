const { Schema, model } = require('mongoose');
const oid = Schema.Types.ObjectId;
const point = new Schema({
  type: { type: String, enum: ['Point'], required: true, default: 'Point' },
  coordinates: { type: [Number], required: true },
}, { _id: false });

const presenceSchema = new Schema({
  user: { type: oid, required: true, unique: true },
  location: { type: point, required: true },
  updatedAt: { type: Date, required: true, expires: 900 },
}, { timestamps: true });
presenceSchema.index({ location: '2dsphere' });

const offerSchema = new Schema({
  helper: { type: oid, required: true },
  state: { type: String, enum: ['pending', 'accepted', 'declined', 'cancelled'], default: 'pending' },
  message: { type: String, maxlength: 300, default: '' },
}, { timestamps: true });

const requestSchema = new Schema({
  requester: { type: oid, required: true },
  activeForUser: { type: oid, unique: true, sparse: true },
  location: { type: point, required: true },
  type: { type: String, enum: ['fuel', 'puncture', 'breakdown', 'battery', 'ev_battery', 'lost', 'mechanic', 'towing', 'accident', 'other'], required: true },
  description: { type: String, maxlength: 500, default: '' },
  motorcycle: { type: String, maxlength: 80, default: '' },
  state: { type: String, enum: ['open', 'assigned', 'resolved', 'cancelled', 'expired'], default: 'open' },
  acceptedHelper: { type: oid, default: null },
  offers: { type: [offerSchema], default: [] },
  expiresAt: { type: Date, required: true },
  purgeAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });
requestSchema.index({ requester: 1, state: 1, createdAt: -1 });
requestSchema.index({ location: '2dsphere', state: 1, expiresAt: 1 });

module.exports = {
  AssistPresence: model('AssistPresence', presenceSchema),
  AssistanceRequest: model('AssistanceRequest', requestSchema),
};
