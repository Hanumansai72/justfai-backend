const express = require("express");
const { userLimiter } = require("../security/rateLimiter");
const router  = express.Router();
const help = require('../controllers/help.controller');
const { uploadLimiter } = require('../security/rateLimiter');
const upload = require('../middlewares/upload.middleware');

const { protect, authorize } = require("../middlewares/authMiddleware");
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
router.use(protect, userLimiter);
router.post('/help-feedback', authorize('USER'), help.saveFeedback);
router.post('/attachments', authorize('USER'), uploadLimiter, upload.single('image'), help.uploadAttachment);
router.post('/tickets', authorize('USER'), help.createTicket);

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
