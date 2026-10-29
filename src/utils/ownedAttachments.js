const cloudinary = require('../config/cloudinary');
function ownedAttachments(value, userId) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3) return null;
  const prefix = `/${cloudinary.config().cloud_name}/image/upload/`;
  return value.every(value => {
    if (typeof value !== 'string' || value.length > 1000) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'res.cloudinary.com' && !url.username && !url.password &&
        url.pathname.startsWith(prefix) && new RegExp(`/(?:v\\d+/)?justride/users/${userId}/support/[a-f0-9-]+\\.(?:jpg|jpeg|png|webp)$`, 'i').test(url.pathname);
    } catch { return false; }
  }) ? [...new Set(value)] : null;
}

module.exports = ownedAttachments;
