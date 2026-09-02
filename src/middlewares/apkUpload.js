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
    const isApk =
      file.originalname.endsWith(".apk") ||
      file.originalname.endsWith(".aab") ||
      file.mimetype === "application/vnd.android.package-archive" ||
      file.mimetype === "application/octet-stream";

    if (isApk) {
      cb(null, true);
    } else {
      cb(new Error("Only .apk or .aab Android packages are allowed"), false);
    }
  },
});

module.exports = apkUpload;
