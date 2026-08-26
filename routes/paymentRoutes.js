const express = require('express');
const router  = express.Router();
const {
  initializePayment,
  verifyPayment,
  getTopProfiles,
  getPaymentStatus,
  runExpiryCheck,
} = require('../controllers/paymentController');
const { protect }      = require('../middleware/authMiddleware');
const { adminProtect } = require('../middleware/adminMiddleware');

// ── KoraPay checkout flow ───────────────────────────────────────────────────
router.post('/initialize',   protect, initializePayment); // Step 1 — get checkout link
router.post('/verify',       protect, verifyPayment);     // Step 2 — confirm payment
// The KoraPay webhook itself lives at POST /api/webhooks/korapay (see
// routes/webhookRoutes.js), not here — it's called by the shared router,
// not directly by KoraPay, and that path is already fixed as ROUTE_HRT on
// the router's side.

// NOTE: /subscribe and /boost (direct, no-payment activation) were removed —
// see the NOTE block in paymentController.js (right after activatePlan's
// helpers) for why. Use PATCH /api/admin/subscriptions/:id to manually
// grant/adjust a user's plan instead.

// ── Info & cron ───────────────────────────────────────────────────────────────
router.get('/top-profiles',  protect,      getTopProfiles);
router.get('/status',        protect,      getPaymentStatus);
router.post('/run-expiry',   adminProtect, runExpiryCheck); // global sweep — admin/cron only, not per-user

module.exports = router;
