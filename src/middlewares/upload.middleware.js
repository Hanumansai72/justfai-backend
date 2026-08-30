/**
 * middlewares/upload.middleware.js
 * In-Memory Multer File Upload Middleware.
 *
 * Enforces:
 *   - Memory storage (buffers directly to Cloudinary without disk I/O)
 *   - 5MB maximum file size limit
 *   - Strict MIME-type filtering (JPEG, PNG, WEBP)
 */
const multer = require("multer");

const storage = multer.memoryStorage();

const path = require("path");

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
  ];

  const allowedExtensions = [".jpg", ".jpeg", ".png", ".webp"];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimeTypes.includes(file.mimetype) && allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(
      new Error("Invalid file. Only JPEG, PNG, and WebP images with valid extensions are allowed."),
      false
    );
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter,
});

module.exports = upload;
