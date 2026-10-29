const express = require("express");
const { userLimiter } = require("../security/rateLimiter");
const router = express.Router();
const {
  createAddress,
  getAllAddresses,
  getAddressById,
  updateAddress,
  deleteAddress,
} = require("../controllers/savedAddressController");
const { protect, authorize } = require("../middlewares/authMiddleware");

// All saved address routes require authentication
router.use(protect, authorize("USER"), userLimiter);

router.route("/")
  .post(createAddress)
  .get(getAllAddresses);

router.route("/:id")
  .get(getAddressById)
  .put(updateAddress)
  .delete(deleteAddress);

require('../security/sanitize').sanitizeParams(router);
module.exports = router;
