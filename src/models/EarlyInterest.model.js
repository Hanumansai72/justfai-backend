const mongoose = require('mongoose');

const earlyInterestSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true, unique: true },
  city: { type: String, required: true, trim: true },
  purchaseIntent: { type: String },
  notes: { type: String, trim: true },
  emailConsent: { type: Boolean, default: false },
  emailConsentAt: { type: Date },
  emailConsentText: { type: String },
  confirmationEmailStatus: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
  confirmationEmailCode: { type: String },
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model('EarlyInterest', earlyInterestSchema);
