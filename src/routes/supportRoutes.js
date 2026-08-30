const express = require("express");
const router  = express.Router();

const { protect } = require("../middlewares/authMiddleware");
const {
  reportDeviceProblem,
  reportConnectionIssue,
  contactSupport,
  submitFeedback,
  getMyTickets,
  getTicketDetails,
  addTicketMessage,
} = require("../controllers/support.controller");

// All support and reporting routes require authentication
router.use(protect);

// Issue reporting & feedback
router.post("/device-problem",     reportDeviceProblem);
router.post("/connection-issue",   reportConnectionIssue);
router.post("/contact",            contactSupport);
router.post("/feedback",           submitFeedback);

// Ticket history & thread
router.get("/my-tickets",          getMyTickets);
router.get("/tickets/:id",         getTicketDetails);
router.post("/tickets/:id/messages", addTicketMessage);

module.exports = router;
