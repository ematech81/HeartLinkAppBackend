const axios       = require('axios');
const crypto      = require('crypto');
const User        = require('../models/User');
const Transaction = require('../models/Transaction');
const { sendPushNotification } = require('../utils/pushNotification');

// ─────────────────────────────────────────────────────────────────────────────
// KoraPay config
//
// This app's payments go through a shared webhook router used across
// several apps (see korapay-webhook-router repo) — KoraPay's dashboard
// webhook URL points at the router, not directly at this app. The router
// extracts the routing prefix from the transaction reference
// ({PREFIX}-{uuid}, prefix "HRT" for this app) and forwards the raw
// webhook to whatever this app registers as ROUTE_HRT
// (/api/webhooks/korapay — see routes/webhookRoutes.js).
// ─────────────────────────────────────────────────────────────────────────────
const KORAPAY_SECRET = process.env.KORAPAY_SECRET_KEY;
const KORAPAY_BASE    = 'https://api.korapay.com';
const ROUTING_PREFIX   = 'HRT';

const korapayHeaders = () => ({
  Authorization: `Bearer ${KORAPAY_SECRET}`,
  'Content-Type': 'application/json',
});

// ─────────────────────────────────────────────────────────────────────────────
// Plans — amounts in Naira (KoraPay uses actual amount, not kobo)
// ─────────────────────────────────────────────────────────────────────────────
const PLANS = {
  monthly: {
    label:       'Monthly',
    amount:      5000,
    durationMs:  30 * 24 * 60 * 60 * 1000,
    freeBoostMs: 0,
  },
  yearly: {
    label:       'Yearly',
    amount:      20000,
    durationMs:  365 * 24 * 60 * 60 * 1000,
    freeBoostMs: 7 * 24 * 60 * 60 * 1000,
  },
  boost: {
    label:       'Weekly Boost',
    amount:      3000,
    durationMs:  7 * 24 * 60 * 60 * 1000,
  },
};

const stillActive = (expiry) => expiry && new Date(expiry) > new Date();

// {PREFIX}-{uuid_v4} — per the router's contract, NEVER the app's own DB
// _id (the router only reads the prefix; the uuid just needs to be unique).
const makeCheckoutReference = () => `${ROUTING_PREFIX}-${crypto.randomUUID()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Helper: activate a plan on the user document.
//
// Extends from the existing expiry when it's still active, rather than
// always resetting to "now + duration" — renewing/topping-up before expiry
// would otherwise throw away whatever time was left.
// ─────────────────────────────────────────────────────────────────────────────
const activatePlan = async (userId, plan) => {
  const cfg = PLANS[plan];
  const now = Date.now();
  const current = await User.findById(userId).select('subscriptionExpiry boostExpiry');

  let fields = {};

  if (plan === 'boost') {
    const base = stillActive(current?.boostExpiry) ? new Date(current.boostExpiry).getTime() : now;
    fields = {
      isBoosted:   true,
      boostExpiry: new Date(base + cfg.durationMs),
      isVerified:  true,
    };
  } else {
    const subBase = stillActive(current?.subscriptionExpiry) ? new Date(current.subscriptionExpiry).getTime() : now;
    fields = {
      isSubscribed:       true,
      subscriptionExpiry: new Date(subBase + cfg.durationMs),
      subscriptionPlan:   plan,
      isVerified:         true,
    };
    if (plan === 'yearly') {
      const boostBase = stillActive(current?.boostExpiry) ? new Date(current.boostExpiry).getTime() : now;
      fields.isBoosted   = true;
      fields.boostExpiry = new Date(boostBase + cfg.freeBoostMs);
    }
  }

  return User.findByIdAndUpdate(userId, fields, { new: true })
    .select('-password -otp -otpExpires -resetPasswordToken -resetPasswordExpires');
};

// ─────────────────────────────────────────────────────────────────────────────
// Mark a transaction 'success' exactly once and activate its plan.
//
// Both the webhook and the manual-verify endpoint call this. The
// findOneAndUpdate's `{ status: { $ne: 'success' } }` filter is what makes
// this safe under retries and races: KoraPay retries charge.success
// webhooks for up to 72h, and the shared router retries up to 3x on top of
// that, so the same event can arrive more than once — and the webhook and
// a user tapping "I've Completed Payment" can both land at nearly the same
// moment. Mongo only lets ONE caller's atomic update match a still-pending
// document; every other (duplicate) caller gets null back and skips
// activation, so a subscription can never be double-extended by the same
// payment.
// ─────────────────────────────────────────────────────────────────────────────
const markSuccessAndActivate = async (checkoutReference) => {
  const txn = await Transaction.findOneAndUpdate(
    { checkoutReference, status: { $ne: 'success' } },
    { $set: { status: 'success' } },
    { new: true }
  );
  if (!txn) return null; // already processed (or never existed) — nothing to do

  const user = await activatePlan(txn.user, txn.plan);
  return { txn, user };
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: expire stale subscription / boost fields on demand
// ─────────────────────────────────────────────────────────────────────────────
const expireIfNeeded = async (userId) => {
  const user = await User.findById(userId).select(
    'isSubscribed subscriptionExpiry isBoosted boostExpiry isVerified'
  );
  if (!user) return;

  const updates = {};

  if (user.isSubscribed && !stillActive(user.subscriptionExpiry)) {
    updates.isSubscribed = false;
    console.log(`⏰ [Expiry] Subscription expired for ${userId}`);
  }
  if (user.isBoosted && !stillActive(user.boostExpiry)) {
    updates.isBoosted = false;
    if (!user.isSubscribed || !stillActive(user.subscriptionExpiry)) {
      updates.isVerified = false;
    }
    console.log(`⏰ [Expiry] Boost expired for ${userId}`);
  }

  if (Object.keys(updates).length) {
    await User.findByIdAndUpdate(userId, updates);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/initialize
// Creates a KoraPay hosted-checkout link and returns it to the app.
// Body: { plan: 'monthly' | 'yearly' | 'boost' }
// ─────────────────────────────────────────────────────────────────────────────
exports.initializePayment = async (req, res) => {
  let transaction;
  try {
    const { plan = 'monthly' } = req.body;
    if (!PLANS[plan]) {
      return res.status(400).json({ success: false, message: 'Invalid plan.' });
    }
    if (!KORAPAY_SECRET) {
      console.error('❌ [KoraPay] KORAPAY_SECRET_KEY is not set in .env');
      return res.status(500).json({ success: false, message: 'Payment service not configured.' });
    }

    const cfg      = PLANS[plan];
    const user      = await User.findById(req.user._id).select('email name');
    const reference = makeCheckoutReference();

    // Record the attempt BEFORE calling KoraPay — the webhook/verify step
    // looks a payer up by this reference, so it must exist first.
    transaction = await Transaction.create({
      user:     req.user._id,
      checkoutReference: reference,
      plan,
      amount:   cfg.amount,
      currency: 'NGN',
      status:   'pending',
    });

    console.log(`💳 [KoraPay] Initializing plan="${plan}" amount=₦${cfg.amount} for user=${req.user._id} reference=${reference}`);

    const { data } = await axios.post(
      `${KORAPAY_BASE}/merchant/api/v1/charges/initialize`,
      {
        amount:       cfg.amount,
        currency:     'NGN',
        reference,
        redirect_url: 'https://heartlink.app/payment/callback',
        customer: {
          email: user.email,
          name:  user.name,
        },
        // NOTE: notification_url intentionally omitted — the KoraPay
        // dashboard's webhook URL (pointed at the shared router) is the
        // only webhook destination that matters here. Setting a
        // per-transaction notification_url would bypass the router and
        // this app's router-secret check entirely.
        metadata: {
          userId: req.user._id.toString(),
          plan,
        },
      },
      { headers: korapayHeaders() }
    );

    if (!data.status || !data.data?.checkout_url) {
      throw new Error(data.message || 'KoraPay initialization did not return a checkout URL.');
    }

    res.json({
      success:      true,
      payment_link: data.data.checkout_url,
      reference,
      amount:       cfg.amount,
      plan,
    });
  } catch (err) {
    // Initialization never reached/succeeded with KoraPay — don't leave a
    // dangling 'pending' Transaction the user can never complete.
    if (transaction) await Transaction.deleteOne({ _id: transaction._id }).catch(() => {});

    const detail = err.response?.data || err.message;
    console.error('❌ [KoraPay] Initialize error:', JSON.stringify(detail));
    res.status(500).json({ success: false, message: err.response?.data?.message || 'Could not start payment.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/verify
// Verifies a checkout reference with KoraPay and activates the plan.
// Body: { reference }
//
// Plan/amount are looked up from THIS app's own Transaction record (created
// during /initialize), never trusted from the client — a client could
// otherwise call this with any reference + claim any plan.
// ─────────────────────────────────────────────────────────────────────────────
exports.verifyPayment = async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) {
      return res.status(400).json({ success: false, message: 'reference is required.' });
    }

    const txn = await Transaction.findOne({ checkoutReference: reference, user: req.user._id });
    if (!txn) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }

    // Already activated (e.g. the webhook beat this call to it) — idempotent,
    // just report current status instead of calling KoraPay again.
    if (txn.status === 'success') {
      const user = await User.findById(req.user._id)
        .select('-password -otp -otpExpires -resetPasswordToken -resetPasswordExpires');
      return res.json({
        success: true,
        message: 'Payment already confirmed.',
        plan: txn.plan,
        amount: txn.amount,
        subscriptionExpiry: user.subscriptionExpiry || null,
        boostExpiry:        user.boostExpiry        || null,
        user,
      });
    }

    const { data } = await axios.get(
      `${KORAPAY_BASE}/merchant/api/v1/charges/${encodeURIComponent(reference)}`,
      { headers: korapayHeaders() }
    );

    if (!data.status || data.data?.status !== 'success') {
      return res.status(402).json({ success: false, message: 'Payment not completed.' });
    }

    // Guard: amount paid must match what we recorded at initialize time.
    const paid = data.data.amount;
    if (paid < txn.amount) {
      return res.status(402).json({ success: false, message: 'Payment amount mismatch.' });
    }

    const result = await markSuccessAndActivate(reference);
    if (!result) {
      // Lost the race to the webhook between the findOne above and here —
      // still a success from the caller's perspective.
      const user = await User.findById(req.user._id)
        .select('-password -otp -otpExpires -resetPasswordToken -resetPasswordExpires');
      return res.json({ success: true, message: 'Payment already confirmed.', plan: txn.plan, user });
    }

    console.log(`✅ [KoraPay] ${req.user._id} verified & activated plan="${txn.plan}" reference="${reference}"`);

    res.json({
      success: true,
      message: txn.plan === 'yearly'
        ? 'Yearly subscription activated! You also get 1 week of free profile boosting.'
        : txn.plan === 'monthly'
          ? 'Monthly subscription activated!'
          : 'Profile boost activated for 7 days!',
      plan:                txn.plan,
      amount:              txn.amount,
      subscriptionExpiry:  result.user.subscriptionExpiry || null,
      boostExpiry:         result.user.boostExpiry        || null,
      user:                result.user,
    });
  } catch (err) {
    console.error('❌ [KoraPay] Verify error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Payment verification failed.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/webhooks/korapay  (see routes/webhookRoutes.js)
// Called by the shared router, never directly by KoraPay. No auth
// middleware — this is server-to-server (router → app), verified instead
// by signature + optional shared secret below.
// ─────────────────────────────────────────────────────────────────────────────
exports.korapayWebhook = async (req, res) => {
  try {
    // Optional secondary check — the router attaches this header only if
    // ROUTER_FORWARD_SECRET is set on ITS side; skip if unset on ours
    // (the KoraPay signature check below is the real proof of origin
    // either way, per the router's own contract).
    const expectedRouterSecret = process.env.ROUTER_FORWARD_SECRET;
    if (expectedRouterSecret) {
      const incoming = req.headers['x-router-secret'];
      const isValidRouterSecret =
        typeof incoming === 'string' &&
        incoming.length === expectedRouterSecret.length &&
        crypto.timingSafeEqual(Buffer.from(incoming), Buffer.from(expectedRouterSecret));
      if (!isValidRouterSecret) {
        return res.status(401).send('Unauthorized');
      }
    }

    // KoraPay's real signature check: HMAC-SHA256 of JSON.stringify(data),
    // using this app's own secret key. Confirmed against KoraPay's own
    // docs/example — this hashes the PARSED `data` object, not raw bytes,
    // so (unlike the old Flutterwave webhook) no raw-body middleware is
    // needed ahead of express.json() for this route.
    const incomingSignature = req.headers['x-korapay-signature'];
    const { event, data } = req.body || {};
    const expectedSignature = data
      ? crypto.createHmac('sha256', KORAPAY_SECRET).update(JSON.stringify(data)).digest('hex')
      : null;
    const isValidSignature =
      !!expectedSignature &&
      typeof incomingSignature === 'string' &&
      incomingSignature.length === expectedSignature.length &&
      crypto.timingSafeEqual(Buffer.from(incomingSignature), Buffer.from(expectedSignature));

    if (!isValidSignature) {
      return res.status(401).send('Unauthorized');
    }

    if (event !== 'charge.success' || data.status !== 'success') {
      return res.sendStatus(200); // ack — nothing to do for this event type
    }

    const result = await markSuccessAndActivate(data.reference);
    if (!result) {
      console.log(`🪝 [Webhook] Ignored (already processed or unknown) reference="${data.reference}"`);
      return res.sendStatus(200);
    }

    console.log(`🪝 [Webhook] Activated plan="${result.txn.plan}" for user=${result.txn.user} reference="${data.reference}"`);
    res.sendStatus(200); // respond fast — no slow downstream work after this point
  } catch (err) {
    console.error('❌ [Webhook] Error:', err.message);
    res.sendStatus(500); // 5xx → router/KoraPay will retry
  }
};

// NOTE: the old `subscribe` / `boostProfile` direct-activation handlers were
// removed (2026-08-24 audit fix). They bypassed the payment provider
// entirely and only activated a plan for `req.user._id` (the caller) —
// which meant (a) they were reachable by any logged-in user with just
// `protect`, letting anyone grant themselves free Premium, and (b) even
// admin-gated they couldn't do what an admin actually needs (grant/adjust a
// *specific customer's* subscription), since they always targeted the
// caller, not a target userId.
// For manually granting/adjusting a user's subscription (support cases,
// promo grants, etc.), use the existing admin tool instead:
//   PATCH /api/admin/subscriptions/:id   (adminController.updateSubscription)
// which already takes an explicit target user id and is adminProtect-gated.

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payment/top-profiles
// ─────────────────────────────────────────────────────────────────────────────
exports.getTopProfiles = async (req, res) => {
  try {
    const now   = new Date();
    const users = await User.find({
      isBoosted:       true,
      boostExpiry:     { $gt: now },
      _id:             { $ne: req.user._id },
      isActive:        true,
      isBanned:        false,
      isProfileHidden: false,
    })
      .select('name dateOfBirth city country profession profilePicture photos isVerified isBoosted isOnline interests boostExpiry')
      .sort({ boostExpiry: -1 })
      .limit(20)
      .lean();
    res.json({ success: true, users });
  } catch (err) {
    console.error('❌ [Payment] TopProfiles error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payment/status
// ─────────────────────────────────────────────────────────────────────────────
exports.getPaymentStatus = async (req, res) => {
  try {
    await expireIfNeeded(req.user._id);

    const user = await User.findById(req.user._id)
      .select('isSubscribed subscriptionExpiry subscriptionPlan isBoosted boostExpiry');

    const isSubscribed = !!(user.isSubscribed && stillActive(user.subscriptionExpiry));
    const isBoosted    = !!(user.isBoosted    && stillActive(user.boostExpiry));

    const daysUntil = (date) => {
      if (!date) return null;
      const diff = new Date(date) - new Date();
      return diff > 0 ? Math.ceil(diff / 86400000) : 0;
    };

    res.json({
      success:              true,
      isSubscribed,
      subscriptionPlan:     user.subscriptionPlan || null,
      subscriptionExpiry:   user.subscriptionExpiry,
      subscriptionDaysLeft: daysUntil(user.subscriptionExpiry),
      isBoosted,
      boostExpiry:          user.boostExpiry,
      boostDaysLeft:        daysUntil(user.boostExpiry),
    });
  } catch (err) {
    console.error('❌ [Payment] Status error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/run-expiry
// ─────────────────────────────────────────────────────────────────────────────
exports.runExpiryCheck = async (req, res) => {
  try {
    const now     = new Date();
    const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    const expiredSubs = await User.updateMany(
      { isSubscribed: true, subscriptionExpiry: { $lte: now } },
      { $set: { isSubscribed: false } }
    );

    const expiredBoosts = await User.find({
      isBoosted: true, boostExpiry: { $lte: now },
    }).select('_id isSubscribed subscriptionExpiry');

    for (const u of expiredBoosts) {
      const keepVerified = u.isSubscribed && stillActive(u.subscriptionExpiry);
      await User.findByIdAndUpdate(u._id, {
        isBoosted: false,
        ...(keepVerified ? {} : { isVerified: false }),
      });
    }

    const soonExpiring = await User.find({
      isSubscribed:       true,
      subscriptionExpiry: { $gt: now, $lte: in3Days },
      'pushTokens.0':     { $exists: true }, // has at least one registered device
    }).select('pushTokens name subscriptionExpiry');

    let notified = 0;
    for (const u of soonExpiring) {
      const daysLeft = Math.ceil((new Date(u.subscriptionExpiry) - now) / 86400000);
      await sendPushNotification(
        u.pushTokens,
        '⚠️ Subscription Expiring Soon',
        `${u.name?.split(' ')[0]}, your HeartLink Premium expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Renew now to keep messaging!`,
        { screen: 'Profile', action: 'renew_subscription' }
      );
      notified++;
    }

    console.log(`⏰ [Expiry] Expired subs: ${expiredSubs.modifiedCount} | Expired boosts: ${expiredBoosts.length} | Notified: ${notified}`);
    res.json({ success: true, expiredSubs: expiredSubs.modifiedCount, expiredBoosts: expiredBoosts.length, notified });
  } catch (err) {
    console.error('❌ [Expiry] runExpiryCheck error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.PLANS = PLANS;
