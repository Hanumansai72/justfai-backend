const express = require('express');
const validator = require('validator');
const EarlyInterest = require('../models/EarlyInterest.model');
const ApiResponse = require('../utils/apiResponse');
const { protect, authorize } = require('../middlewares/authMiddleware');

const router = express.Router();
const intents = ['Yes', 'Maybe', 'I want to know the price first'];
const optionalText = (value, max) => typeof value === 'string' && value.trim().length <= max;

router.post('/', async (req, res, next) => {
  try {
    const { name, email, city, purchaseIntent = '', notes = '', website = '' } = req.body || {};
    if (website) return ApiResponse.created(res, null, 'You are on the list');
    if (typeof name !== 'string' || name.trim().length < 2 || name.length > 100 ||
        typeof email !== 'string' || !validator.isEmail(email) || email.length > 254 ||
        typeof city !== 'string' || city.trim().length < 2 || city.length > 100 ||
        !optionalText(notes, 1000) ||
        (purchaseIntent && !intents.includes(purchaseIntent))) {
      return ApiResponse.badRequest(res, 'Please check the form details and try again.');
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (await EarlyInterest.exists({ email: normalizedEmail })) {
      return ApiResponse.success(res, null, 'You are already on the list.');
    }
    await EarlyInterest.create({ name: name.trim(), email: normalizedEmail, city: city.trim(), purchaseIntent, notes: notes.trim() });
    return ApiResponse.created(res, null, 'You are on the list.');
  } catch (error) {
    if (error.code === 11000) return ApiResponse.success(res, null, 'You are already on the list.');
    next(error);
  }
});

router.get('/', protect, authorize('ADMIN', 'HELPER'), async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = 100;
    const [items, total] = await Promise.all([
      EarlyInterest.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      EarlyInterest.countDocuments(),
    ]);
    return ApiResponse.success(res, { items, total, page, limit });
  } catch (error) { next(error); }
});

module.exports = router;
