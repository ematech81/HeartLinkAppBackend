const express = require('express');
const router  = express.Router();
const {
  initializePayment,
  verifyPayment,
  paystackWebhook,
  subscribe,
  boostProfile,
  getTopProfiles,
  getPaymentStatus,
  runExpiryCheck,
} = require('../controllers/paymentController');
const { protect } = require('../middleware/authMiddleware');

// ── Paystack checkout flow ────────────────────────────────────────────────────
router.post('/initialize',   protect, initializePayment); // Step 1 — get checkout URL
router.post('/verify',       protect, verifyPayment);     // Step 2 — confirm payment
router.post('/webhook',      paystackWebhook);            // Paystack server webhook (no auth)

// ── Legacy / internal ─────────────────────────────────────────────────────────
router.post('/subscribe',    protect, subscribe);         // kept for compat
router.post('/boost',        protect, boostProfile);      // kept for compat

// ── Info & cron ───────────────────────────────────────────────────────────────
router.get('/top-profiles',  protect, getTopProfiles);
router.get('/status',        protect, getPaymentStatus);
router.post('/run-expiry',   protect, runExpiryCheck);

module.exports = router;
