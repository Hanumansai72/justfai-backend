const mongoose = require('mongoose');

const earlyInterestSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true, unique: true },
  city: { type: String, required: true, trim: true },
  purchaseIntent: { type: String },
  priceRange: { type: String, enum: ['', '4999-5999', '5999-6999', '6999-7999', '7999-8999'], default: '' },
  notes: { type: String, trim: true },
  emailConsent: { type: Boolean, default: false },
  emailConsentAt: { type: Date },
  emailConsentText: { type: String },
  confirmationEmailStatus: { type: String, enum: ['pending', 'queued', 'sending', 'sent', 'failed'], default: 'pending' },
  confirmationEmailCode: { type: String },
  confirmationEmailStartedAt: { type: Date },
  confirmationEmailNextAttemptAt: { type: Date },
}, { timestamps: true, versionKey: false });

earlyInterestSchema.index({ confirmationEmailStatus: 1, confirmationEmailNextAttemptAt: 1, createdAt: 1 });

earlyInterestSchema.plugin(require('./plugins/invalidateAdminCache'), { groups: ['interest'] });

module.exports = mongoose.model('EarlyInterest', earlyInterestSchema);
