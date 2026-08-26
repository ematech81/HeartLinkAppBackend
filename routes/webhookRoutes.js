const express = require('express');
const router  = express.Router();
const { korapayWebhook } = require('../controllers/paymentController');

// ── Server-to-server webhooks ───────────────────────────────────────────────
// These are called by the shared korapay-webhook-router, never directly by
// KoraPay (KoraPay's dashboard webhook URL points at the router; the router
// forwards to whatever this app registers as ROUTE_HRT, which is this exact
// path). No auth middleware — origin is verified inside the handler itself
// via the KoraPay signature (and optionally x-router-secret).
router.post('/korapay', korapayWebhook);

module.exports = router;
