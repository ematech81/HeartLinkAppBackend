const axios = require('axios');
const User  = require('../models/User');
const sendPushNotification = require('../utils/pushNotification');

// ─────────────────────────────────────────────────────────────────────────────
// Flutterwave config
// ─────────────────────────────────────────────────────────────────────────────
const FLW_SECRET      = process.env.FLW_SECRET_KEY;
const FLW_WEBHOOK_HASH = process.env.FLW_WEBHOOK_HASH;
const FLW_BASE        = 'https://api.flutterwave.com/v3';

const flwHeaders = () => ({
  Authorization: `Bearer ${FLW_SECRET}`,
  'Content-Type': 'application/json',
});

// ─────────────────────────────────────────────────────────────────────────────
// Plans — amounts in Naira (Flutterwave uses actual amount, not kobo)
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

const stillActive    = (expiry) => expiry && new Date(expiry) > new Date();
const makeTxRef      = (userId) => `HL-${userId}-${Date.now()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Helper: activate a plan on the user document
// ─────────────────────────────────────────────────────────────────────────────
const activatePlan = async (userId, plan) => {
  const cfg = PLANS[plan];
  const now = Date.now();
  let fields = {};

  if (plan === 'boost') {
    fields = {
      isBoosted:   true,
      boostExpiry: new Date(now + cfg.durationMs),
      isVerified:  true,
    };
  } else {
    fields = {
      isSubscribed:       true,
      subscriptionExpiry: new Date(now + cfg.durationMs),
      subscriptionPlan:   plan,
      isVerified:         true,
    };
    if (plan === 'yearly') {
      fields.isBoosted   = true;
      fields.boostExpiry = new Date(now + cfg.freeBoostMs);
    }
  }

  return User.findByIdAndUpdate(userId, fields, { new: true })
    .select('-password -otp -otpExpires -resetPasswordToken -resetPasswordExpires');
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
// Creates a Flutterwave hosted-checkout link and returns it to the app.
// Body: { plan: 'monthly' | 'yearly' | 'boost' }
// ─────────────────────────────────────────────────────────────────────────────
exports.initializePayment = async (req, res) => {
  try {
    const { plan = 'monthly' } = req.body;
    if (!PLANS[plan]) {
      return res.status(400).json({ success: false, message: 'Invalid plan.' });
    }
    if (!FLW_SECRET) {
      console.error('❌ [Flutterwave] FLW_SECRET_KEY is not set in .env');
      return res.status(500).json({ success: false, message: 'Payment service not configured.' });
    }

    const cfg    = PLANS[plan];
    const user   = await User.findById(req.user._id).select('email name');
    const tx_ref = makeTxRef(req.user._id);

    console.log(`💳 [FLW] Initializing plan="${plan}" amount=₦${cfg.amount} for user=${req.user._id} tx_ref=${tx_ref}`);

    const { data } = await axios.post(
      `${FLW_BASE}/payments`,
      {
        tx_ref,
        amount:       cfg.amount,
        currency:     'NGN',
        redirect_url: 'https://heartlink.app/payment/callback',
        customer: {
          email: user.email,
          name:  user.name,
        },
        customizations: {
          title:       `HeartLink ${cfg.label}`,
          description: `${cfg.label} plan — ₦${cfg.amount.toLocaleString()}`,
        },
        meta: {
          userId: req.user._id.toString(),
          plan,
        },
      },
      { headers: flwHeaders() }
    );

    if (data.status !== 'success') {
      return res.status(502).json({ success: false, message: 'Flutterwave initialization failed.' });
    }

    res.json({
      success:      true,
      payment_link: data.data.link,
      tx_ref,
      amount:       cfg.amount,
      plan,
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('❌ [FLW] Initialize error:', JSON.stringify(detail));
    res.status(500).json({ success: false, message: err.response?.data?.message || 'Could not start payment.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/verify
// Verifies the tx_ref with Flutterwave and activates the plan.
// Body: { tx_ref, plan }
// ─────────────────────────────────────────────────────────────────────────────
exports.verifyPayment = async (req, res) => {
  try {
    const { tx_ref, plan } = req.body;
    if (!tx_ref || !plan) {
      return res.status(400).json({ success: false, message: 'tx_ref and plan are required.' });
    }
    if (!PLANS[plan]) {
      return res.status(400).json({ success: false, message: 'Invalid plan.' });
    }

    const { data } = await axios.get(
      `${FLW_BASE}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(tx_ref)}`,
      { headers: flwHeaders() }
    );

    if (data.status !== 'success' || data.data?.status !== 'successful') {
      return res.status(402).json({ success: false, message: 'Payment not completed.' });
    }

    // Guard: amount paid must match plan price
    const paid     = data.data.amount;
    const expected = PLANS[plan].amount;
    if (paid < expected) {
      return res.status(402).json({ success: false, message: 'Payment amount mismatch.' });
    }

    const user = await activatePlan(req.user._id, plan);
    console.log(`✅ [FLW] ${req.user._id} verified & activated plan="${plan}" tx_ref="${tx_ref}"`);

    const cfg = PLANS[plan];
    res.json({
      success: true,
      message: plan === 'yearly'
        ? 'Yearly subscription activated! You also get 1 week of free profile boosting.'
        : plan === 'monthly'
          ? 'Monthly subscription activated!'
          : 'Profile boost activated for 7 days!',
      plan,
      amount:             cfg.amount,
      subscriptionExpiry: user.subscriptionExpiry || null,
      boostExpiry:        user.boostExpiry        || null,
      user,
    });
  } catch (err) {
    console.error('❌ [FLW] Verify error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Payment verification failed.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/webhook  (Flutterwave → backend, hash-verified)
// Set the same FLW_WEBHOOK_HASH in your Flutterwave dashboard under
// Settings → Webhooks → Secret Hash.
// ─────────────────────────────────────────────────────────────────────────────
exports.flutterwaveWebhook = async (req, res) => {
  try {
    // Verify the request is genuinely from Flutterwave
    const incomingHash = req.headers['verif-hash'];
    if (!incomingHash || incomingHash !== FLW_WEBHOOK_HASH) {
      return res.status(401).send('Unauthorized');
    }

    const { event, data } = req.body;
    if (event !== 'charge.completed') return res.sendStatus(200);
    if (data?.status !== 'successful')  return res.sendStatus(200);

    const { userId, plan } = data.meta || {};
    if (!userId || !plan || !PLANS[plan]) return res.sendStatus(200);

    await activatePlan(userId, plan);
    console.log(`🪝 [Webhook] Activated plan="${plan}" for user=${userId} tx_ref="${data.tx_ref}"`);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ [Webhook] Error:', err.message);
    res.sendStatus(500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/subscribe  (kept for internal/admin use)
// ─────────────────────────────────────────────────────────────────────────────
exports.subscribe = async (req, res) => {
  try {
    const { plan = 'monthly' } = req.body;
    if (!PLANS[plan] || plan === 'boost') {
      return res.status(400).json({ success: false, message: 'Invalid plan.' });
    }
    const user = await activatePlan(req.user._id, plan);
    console.log(`✅ [Payment] ${req.user._id} subscribed (${plan}) until ${user.subscriptionExpiry}`);
    res.json({
      success: true,
      message: plan === 'yearly' ? 'Yearly subscription activated! You also get 1 week of free profile boosting.' : 'Monthly subscription activated!',
      plan,
      amount:             PLANS[plan].amount,
      subscriptionExpiry: user.subscriptionExpiry,
      boostExpiry:        user.boostExpiry || null,
      user,
    });
  } catch (err) {
    console.error('❌ [Payment] Subscribe error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/boost  (kept for internal/admin use)
// ─────────────────────────────────────────────────────────────────────────────
exports.boostProfile = async (req, res) => {
  try {
    const user = await activatePlan(req.user._id, 'boost');
    console.log(`⚡ [Payment] ${req.user._id} boosted until ${user.boostExpiry}`);
    res.json({
      success:     true,
      message:     'Profile boosted for 7 days! You now appear at the top.',
      amount:      PLANS.boost.amount,
      boostExpiry: user.boostExpiry,
      user,
    });
  } catch (err) {
    console.error('❌ [Payment] Boost error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

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
      pushToken:          { $ne: null },
    }).select('pushToken name subscriptionExpiry');

    let notified = 0;
    for (const u of soonExpiring) {
      const daysLeft = Math.ceil((new Date(u.subscriptionExpiry) - now) / 86400000);
      await sendPushNotification(
        u.pushToken,
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
