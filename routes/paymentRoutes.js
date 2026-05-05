const express = require('express');
const router  = express.Router();
const {
  initializePayment,
  verifyPayment,
  flutterwaveWebhook,
  subscribe,
  boostProfile,
  getTopProfiles,
  getPaymentStatus,
  runExpiryCheck,
} = require('../controllers/paymentController');
const { protect } = require('../middleware/authMiddleware');

// ── Flutterwave checkout flow ─────────────────────────────────────────────────
router.post('/initialize',   protect, initializePayment); // Step 1 — get checkout link
router.post('/verify',       protect, verifyPayment);     // Step 2 — confirm payment
router.post('/webhook',      flutterwaveWebhook);         // Flutterwave server webhook (no auth)

// ── Internal / admin ──────────────────────────────────────────────────────────
router.post('/subscribe',    protect, subscribe);         // direct activation (no payment)
router.post('/boost',        protect, boostProfile);      // direct boost (no payment)

// ── Info & cron ───────────────────────────────────────────────────────────────
router.get('/top-profiles',  protect, getTopProfiles);
router.get('/status',        protect, getPaymentStatus);
router.post('/run-expiry',   protect, runExpiryCheck);

module.exports = router;
