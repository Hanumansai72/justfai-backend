const express = require("express");
const router  = express.Router();

const { protect } = require("../middlewares/authMiddleware");
const upload      = require("../middlewares/upload.middleware");
const {
  uploadAvatar,
  uploadImage,
  getImagePreview,
} = require("../controllers/upload.controller");

// All upload routes require authentication
router.use(protect);

// Upload profile avatar (accepts multipart field name "image" or "avatar")
router.post(
  "/avatar",
  (req, res, next) => {
    // Middleware wrapper allowing either "avatar" or "image" field names
    upload.fields([
      { name: "avatar", maxCount: 1 },
      { name: "image", maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, message: err.message });
      }
      // Normalize req.file from fields
      if (req.files?.avatar?.[0]) req.file = req.files.avatar[0];
      else if (req.files?.image?.[0]) req.file = req.files.image[0];
      next();
    });
  },
  uploadAvatar
);

// Upload generic image (240x240 smart crop)
router.post(
  "/image",
  upload.single("image"),
  uploadImage
);

// Dynamic preview URL endpoint
router.get("/preview", getImagePreview);
router.get("/preview/*splat", (req, res, next) => {
  // Capture wildcard public_id from path
  const rawPublicId = req.params.splat || req.params[0];
  req.params.public_id = rawPublicId;
  getImagePreview(req, res, next);
});

module.exports = router;
