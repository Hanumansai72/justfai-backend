const { Schema, model } = require('mongoose');
const oid = Schema.Types.ObjectId;
const experience = new Schema({
  author: { type: oid, required: true },
  sourceRide: { type: oid },
  state: { type: String, enum: ['draft', 'published', 'removed'], required: true },
  publishedAt: Date,
  title: String, origin: String, destination: String, region: String,
  motorcycle: String, story: String, roadNotes: String, season: String,
  distanceKm: Number, durationMinutes: Number, travelledOn: String,
  hotel: String, hotelCost: Number, hotelParking: String,
  expenses: [{ _id: false, category: String, amount: Number }],
  helpfulCount: { type: Number, default: 0 },
}, { timestamps: true });
experience.index({ state: 1, publishedAt: -1, _id: -1 });
experience.index({ state: 1, helpfulCount: -1, publishedAt: -1, _id: -1 });
experience.index({ author: 1, updatedAt: -1 });
experience.index({ title: 'text', origin: 'text', destination: 'text', region: 'text',
  motorcycle: 'text', story: 'text', hotel: 'text' });

const bookmark = new Schema({
  user: { type: oid, required: true },
  experience: { type: oid, required: true },
}, { timestamps: true });
bookmark.index({ user: 1, experience: 1 }, { unique: true });
bookmark.index({ user: 1, createdAt: -1, _id: -1 });
const helpful = bookmark.clone();

const report = new Schema({
  reporter: { type: oid, required: true },
  experience: { type: oid, required: true },
  reason: { type: String, required: true },
  state: { type: String, enum: ['pending', 'dismissed', 'removed'], default: 'pending' },
}, { timestamps: true });
report.index({ reporter: 1, experience: 1 }, { unique: true });
report.index({ state: 1, createdAt: 1, _id: 1 });

module.exports = {
  Experience: model('CommunityExperience', experience),
  Bookmark: model('CommunityBookmark', bookmark),
  Helpful: model('CommunityHelpful', helpful),
  Report: model('CommunityReport', report),
};
