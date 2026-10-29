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
    if (typeof file.originalname === 'string' && file.originalname.toLowerCase().endsWith('.bin') &&
      ['application/octet-stream', 'application/x-binary', 'application/macbinary'].includes(file.mimetype)
    ) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error("Only .bin firmware binary files are allowed"), { statusCode: 400 }), false);
    }
  },
});

module.exports = firmwareUpload;
