/**
 * middlewares/apkUpload.js
 * Multer in-memory storage for handling Android APK / bundle uploads
 */
const multer = require("multer");

const storage = multer.memoryStorage();

const apkUpload = multer({
  storage,
  limits: {
    fileSize: 150 * 1024 * 1024, // 150 MB max APK size
  },
  fileFilter: (req, file, cb) => {
    const isApk = /\.(apk|aab)$/i.test(file.originalname) &&
      ['application/vnd.android.package-archive', 'application/octet-stream', 'application/zip'].includes(file.mimetype);

    if (isApk) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error("Only .apk or .aab Android packages are allowed"), { statusCode: 400 }), false);
    }
  },
});

module.exports = apkUpload;
