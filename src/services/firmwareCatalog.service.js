const FirmwareRelease = require('../models/FirmwareRelease.model');
const cache = require('./cache.service');

function latestFirmware({ channel = 'stable', deviceType, genericOnly = false } = {}) {
  const filter = { is_active: true, channel };
  if (deviceType !== undefined) filter.device_type = { $in: [null, deviceType] };
  else if (genericOnly) filter.device_type = null;

  const load = () => FirmwareRelease.findOne(filter).sort({ release_date: -1 }).lean();
  // Device-specific and universal-only lookups must never share the all-model key.
  const mode = deviceType !== undefined ? 'compatible' : genericOnly ? 'universal' : 'all';
  const key = JSON.stringify(['latest-catalog-v1', channel, mode, deviceType ?? null]);
  return cache.getOrSet('firmware', key, load);
}

function latestPublicFirmware() {
  return cache.getOrSet('firmware', 'latest-public-v1', async () => {
    const fields = 'version channel device_type release_notes file_url checksum is_featured release_date';
    const latest = await FirmwareRelease.findOne({ is_featured: true, is_active: true })
      .select(fields).lean() ?? await FirmwareRelease.findOne({ is_active: true, channel: 'stable' })
      .sort({ release_date: -1 }).select(fields).lean();

    return { data: latest ? {
      id: latest._id,
      version: latest.version,
      channel: latest.channel,
      device_type: latest.device_type,
      release_notes: latest.release_notes,
      file_url: latest.file_url,
      checksum: latest.checksum,
      is_featured: !!latest.is_featured,
      release_date: latest.release_date,
    } : null };
  });
}

module.exports = { latestFirmware, latestPublicFirmware };
