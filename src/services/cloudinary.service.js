/**
 * services/cloudinary.service.js
 * Cloudinary Upload & Transformation Service.
 *
 * Implements:
 *   - In-memory stream upload (no temporary disk files)
 *   - Auto-gravity Smart Cropping (240 x 240) preserving key content & faces
 *   - High-fidelity quality retention (quality: 'auto:best', fetch_format: 'auto')
 *   - Dynamic preview URL generator
 *   - Image deletion helper
 */
const cloudinary = require("../config/cloudinary");
const streamifier = require("stream");

class CloudinaryService {
  /**
   * Upload an in-memory buffer to Cloudinary with automatic 240x240 smart resize.
   *
   * @param {Buffer} fileBuffer - Image buffer from multer
   * @param {Object} [options] - Custom upload options
   * @param {string} [options.folder] - Target Cloudinary folder
   * @param {number} [options.width=240] - Desired width
   * @param {number} [options.height=240] - Desired height
   * @returns {Promise<Object>} Upload result with secure URLs and transformation metadata
   */
  async uploadImage(fileBuffer, options = {}) {
    const {
      folder = process.env.CLOUDINARY_FOLDER || "justride_uploads",
      width = 240,
      height = 240,
      gravity = "auto", // "auto" uses AI subject detection; "face" centers on person
    } = options;

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: "image",
          // Smart 240x240 transformation that preserves main subject & quality
          transformation: [
            {
              width,
              height,
              crop: "fill",         // Fills exact 240x240 dimensions
              gravity,             // AI-driven smart focal point centering
              quality: "auto:best", // Maximum quality with intelligent compression
              fetch_format: "auto", // Serves next-gen WebP/AVIF to supported clients
            },
          ],
        },
        (error, result) => {
          if (error) {
            console.error("[Cloudinary] Upload stream error:", error);
            return reject(new Error(error.message || "Failed to upload image to Cloudinary"));
          }

          resolve({
            public_id:     result.public_id,
            secure_url:    result.secure_url,
            url:           result.url,
            format:        result.format,
            width:         result.width,
            height:        result.height,
            bytes:         result.bytes,
            created_at:    result.created_at,
            // 240x240 thumbnail preview URL
            preview_240:   this.getPreviewUrl(result.public_id, { width: 240, height: 240 }),
          });
        }
      );

      // Pipe the file buffer directly into the Cloudinary upload stream
      const bufferStream = new streamifier.PassThrough();
      bufferStream.end(fileBuffer);
      bufferStream.pipe(uploadStream);
    });
  }

  /**
   * Generate an optimized on-the-fly Cloudinary transformation preview URL.
   *
   * @param {string} publicId - Cloudinary public ID
   * @param {Object} [transformOptions]
   * @param {number} [transformOptions.width=240]
   * @param {number} [transformOptions.height=240]
   * @param {string} [transformOptions.crop='fill']
   * @param {string} [transformOptions.gravity='auto']
   * @returns {string} Fully qualified secure URL
   */
  getPreviewUrl(publicId, transformOptions = {}) {
    const {
      width = 240,
      height = 240,
      crop = "fill",
      gravity = "auto",
    } = transformOptions;

    return cloudinary.url(publicId, {
      secure: true,
      transformation: [
        {
          width,
          height,
          crop,
          gravity,
          quality: "auto:best",
          fetch_format: "auto",
        },
      ],
    });
  }

  /**
   * Delete an image from Cloudinary by public ID.
   * @param {string} publicId
   */
  async deleteImage(publicId) {
    if (!publicId) return null;
    try {
      return await cloudinary.uploader.destroy(publicId);
    } catch (err) {
      console.warn(`[Cloudinary] Delete failed for ${publicId}:`, err.message);
      return null;
    }
  }
}

module.exports = new CloudinaryService();
