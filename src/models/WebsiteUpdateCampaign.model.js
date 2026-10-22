const mongoose = require('mongoose');

const recipientSchema = new mongoose.Schema({
  interestId: { type: mongoose.Schema.Types.ObjectId, required: true },
  name: String,
  email: String,
  permissionBasis: { type: String, enum: ['recorded_opt_in', 'owner_confirmed_direct'], default: 'recorded_opt_in' },
  status: { type: String, enum: ['queued', 'sending', 'sent', 'failed', 'skipped'], default: 'queued' },
  code: String,
  claimId: String,
  startedAt: Date,
  sentAt: Date,
  nextAttemptAt: { type: Date, default: () => new Date(0) },
}, { _id: false });

module.exports = mongoose.model('WebsiteUpdateCampaign', new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  state: { type: String, enum: ['draft', 'queued', 'completed'], default: 'draft' },
  testStatus: { type: String, enum: ['not_sent', 'sending', 'sent', 'failed'], default: 'not_sent' },
  testCode: String,
  testSentAt: Date,
  testStartedAt: Date,
  testContentHash: String,
  approvedAt: Date,
  includeContacted: { type: Boolean, default: false },
  permissionNote: String,
  approvalSource: String,
  approvedBy: mongoose.Schema.Types.ObjectId,
  recipients: { type: [recipientSchema], default: [] },
}, { timestamps: true, versionKey: false }));
