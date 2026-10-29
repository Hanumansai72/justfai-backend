const { z } = require('zod');
const Ride = require('../models/Ride.model');

const place = z.object({
  name: z.string().max(200).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  placeId: z.string().max(300).nullable().optional(),
  rawQuery: z.string().max(500).nullable().optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
const rideInput = z.object({
  sessionId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  startTime: z.iso.datetime({ offset: true }),
  endTime: z.iso.datetime({ offset: true }),
  origin: place, destination: place,
  distanceMeters: z.number().min(0),
  durationSeconds: z.number().int().min(0),
  averageSpeedKmh: z.number().min(0),
  maxSpeedKmh: z.number().min(0),
  status: z.enum(['completed', 'stopped']),
}).strict().refine(value => Date.parse(value.endTime) >= Date.parse(value.startTime), {
  message: 'Ride end time must be after its start time', path: ['endTime'],
});

exports.saveRide = async (req, res, next) => {
  const parsed = rideInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false,
    message: 'Invalid ride summary', errors: parsed.error.issues.map(({ path, message }) => ({ field: path.join('.'), message })) });
  const filter = { user_id: req.user._id, sessionId: parsed.data.sessionId };
  try {
    // Retries of a completed session return the original record, never a second ride.
    const now = new Date();
    const ride = await Ride.findOneAndUpdate(filter,
      { $setOnInsert: { ...parsed.data, user_id: req.user._id, createdAt: now, updatedAt: now } },
      { upsert: true, new: true, runValidators: true, timestamps: false }).lean();
    return res.status(200).json({ success: true, data: ride });
  } catch (error) {
    // Two devices/requests may race on the same unique session key.
    if (error.code === 11000) {
      try {
        const ride = await Ride.findOne(filter).lean();
        if (ride) return res.status(200).json({ success: true, data: ride });
      } catch (readError) { return next(readError); }
    }
    return next(error);
  }
};

exports.getRides = async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(10, Number.parseInt(req.query.limit, 10) || 10));
    const filter = { user_id: req.user._id };
    const [items, total] = await Promise.all([
      Ride.find(filter).sort({ endTime: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Ride.countDocuments(filter),
    ]);
    return res.json({ success: true, data: { items, total, page, limit } });
  } catch (error) { return next(error); }
};
