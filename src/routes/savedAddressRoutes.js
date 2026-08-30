const express = require("express");
const router = express.Router();
const {
  createAddress,
  getAllAddresses,
  getAddressById,
  updateAddress,
  deleteAddress,
} = require("../controllers/savedAddressController");
const { protect } = require("../middlewares/authMiddleware");

// All saved address routes require authentication
router.use(protect);

router.route("/")
  .post(createAddress)
  .get(getAllAddresses);

router.route("/:id")
  .get(getAddressById)
  .put(updateAddress)
  .delete(deleteAddress);

module.exports = router;
