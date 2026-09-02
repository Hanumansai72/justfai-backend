/**
 * middlewares/firmwareUpload.js
 * Multer in-memory storage for handling compiled .bin firmware binary uploads
 */
const multer = require("multer");

const storage = multer.memoryStorage();

const firmwareUpload = multer({
  storage,
  limits: {
    fileSize: 16 * 1024 * 1024, // 16 MB max firmware size
  },
  fileFilter: (req, file, cb) => {
    // Allow .bin, application/octet-stream, or application/macbinary
    if (
      file.originalname.endsWith(".bin") ||
      file.mimetype === "application/octet-stream" ||
      file.mimetype === "application/x-binary"
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only .bin firmware binary files are allowed"), false);
    }
  },
});

module.exports = firmwareUpload;
