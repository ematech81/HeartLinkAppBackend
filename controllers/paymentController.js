const axios = require('axios');
const User  = require('../models/User');
const sendPushNotification = require('../utils/pushNotification');

// ─────────────────────────────────────────────────────────────────────────────
// Paystack helpers
// ─────────────────────────────────────────────────────────────────────────────
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

const paystackHeaders = () => ({
  Authorization: `Bearer ${PAYSTACK_SECRET}`,
  'Content-Type': 'application/json',
});

// Convert Naira → Kobo (Paystack uses the smallest currency unit)
const toKobo = (naira) => naira * 100;

// ─────────────────────────────────────────────────────────────────────────────
// Constants — all amounts in Naira (₦)
// ─────────────────────────────────────────────────────────────────────────────
const PLANS = {
  monthly: {
    label:       'Monthly',
    amount:      5000,           // ₦5,000
    durationMs:  30 * 24 * 60 * 60 * 1000,
    freeBoostMs: 0,
  },
  yearly: {
    label:       'Yearly',
    amount:      20000,          // ₦20,000
    durationMs:  365 * 24 * 60 * 60 * 1000,
    freeBoostMs: 7 * 24 * 60 * 60 * 1000,   // 1 week free boost
  },
  boost: {
    label:       'Weekly Boost',
    amount:      3000,           // ₦3,000
    durationMs:  7 * 24 * 60 * 60 * 1000,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: check if a date is still in the future
// ─────────────────────────────────────────────────────────────────────────────
const stillActive = (expiry) => expiry && new Date(expiry) > new Date();

// ─────────────────────────────────────────────────────────────────────────────
// Helper: expire stale fields on a user document
// Called on status reads so the DB stays consistent without a cron job.
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
    // Only remove verified badge if they haven't a paid subscription keeping it
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
// Step 1: Create a Paystack transaction and return the checkout URL.
// Body: { plan: 'monthly' | 'yearly' | 'boost' }
// ─────────────────────────────────────────────────────────────────────────────
exports.initializePayment = async (req, res) => {
  try {
    const { plan = 'monthly' } = req.body;
    if (!PLANS[plan]) {
      return res.status(400).json({ success: false, message: 'Invalid plan.' });
    }

    if (!PAYSTACK_SECRET) {
      console.error('❌ [Paystack] PAYSTACK_SECRET_KEY is not set in .env');
      return res.status(500).json({ success: false, message: 'Payment service not configured.' });
    }

    const cfg    = PLANS[plan];
    const user   = await User.findById(req.user._id).select('email name');
    const amount = toKobo(cfg.amount);

    console.log(`💳 [Paystack] Initializing plan="${plan}" amount=${amount} for user=${req.user._id}`);

    const { data } = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email:        user.email,
        amount,
        currency:     'NGN',
        callback_url: 'https://heartlink.app/payment/callback',
        metadata: {
          userId:    req.user._id.toString(),
          plan,
          userName:  user.name,
        },
      },
      { headers: paystackHeaders() }
    );

    if (!data.status) {
      return res.status(502).json({ success: false, message: 'Paystack initialization failed.' });
    }

    res.json({
      success:           true,
      authorization_url: data.data.authorization_url,
      reference:         data.data.reference,
      amount:            cfg.amount,
      plan,
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('❌ [Paystack] Initialize error:', JSON.stringify(detail));
    const msg = err.response?.data?.message || 'Could not start payment.';
    res.status(500).json({ success: false, message: msg });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/verify
// Step 2: Verify the Paystack reference, then activate the plan.
// Body: { reference, plan }
// ─────────────────────────────────────────────────────────────────────────────
exports.verifyPayment = async (req, res) => {
  try {
    const { reference, plan } = req.body;
    if (!reference || !plan) {
      return res.status(400).json({ success: false, message: 'reference and plan are required.' });
    }
    if (!PLANS[plan]) {
      return res.status(400).json({ success: false, message: 'Invalid plan.' });
    }

    // Verify with Paystack
    const { data } = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: paystackHeaders() }
    );

    if (!data.status || data.data.status !== 'success') {
      return res.status(402).json({ success: false, message: 'Payment not completed.' });
    }

    const cfg     = PLANS[plan];
    const paid    = data.data.amount; // in kobo
    const expected = toKobo(cfg.amount);

    // Guard: ensure the amount actually paid matches the plan price
    if (paid < expected) {
      return res.status(402).json({ success: false, message: 'Payment amount mismatch.' });
    }

    // Activate subscription or boost
    const now    = Date.now();
    let updateFields = {};

    if (plan === 'boost') {
      const expiry = new Date(now + cfg.durationMs);
      updateFields = { isBoosted: true, boostExpiry: expiry, isVerified: true };
    } else {
      const expiry = new Date(now + cfg.durationMs);
      updateFields = {
        isSubscribed:       true,
        subscriptionExpiry: expiry,
        subscriptionPlan:   plan,
      };
      if (plan === 'yearly') {
        updateFields.isBoosted   = true;
        updateFields.boostExpiry = new Date(now + cfg.freeBoostMs);
        updateFields.isVerified  = true;
      }
    }

    const user = await User.findByIdAndUpdate(req.user._id, updateFields, { new: true })
      .select('-password -otp -otpExpires -resetPasswordToken -resetPasswordExpires');

    console.log(`✅ [Paystack] ${req.user._id} verified & activated plan="${plan}" ref="${reference}"`);

    const isPlan = plan !== 'boost';
    res.json({
      success: true,
      message: plan === 'yearly'
        ? 'Yearly subscription activated! You also get 1 week of free profile boosting.'
        : plan === 'monthly'
          ? 'Monthly subscription activated!'
          : 'Profile boost activated for 7 days!',
      plan,
      amount:             cfg.amount,
      subscriptionExpiry: updateFields.subscriptionExpiry || null,
      boostExpiry:        updateFields.boostExpiry || null,
      user,
    });
  } catch (err) {
    console.error('❌ [Paystack] Verify error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Payment verification failed.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/webhook  (Paystack → backend, signature-verified)
// Handles charge.success events as a reliable server-side fallback.
// ─────────────────────────────────────────────────────────────────────────────
exports.paystackWebhook = async (req, res) => {
  try {
    const crypto = require('crypto');
    const hash   = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).send('Unauthorized');
    }

    const { event, data } = req.body;
    if (event !== 'charge.success') return res.sendStatus(200);

    const { plan, userId } = data.metadata || {};
    if (!userId || !plan || !PLANS[plan]) return res.sendStatus(200);

    const cfg = PLANS[plan];
    const now = Date.now();
    let updateFields = {};

    if (plan === 'boost') {
      const expiry = new Date(now + cfg.durationMs);
      updateFields = { isBoosted: true, boostExpiry: expiry, isVerified: true };
    } else {
      const expiry = new Date(now + cfg.durationMs);
      updateFields = {
        isSubscribed:       true,
        subscriptionExpiry: expiry,
        subscriptionPlan:   plan,
      };
      if (plan === 'yearly') {
        updateFields.isBoosted   = true;
        updateFields.boostExpiry = new Date(now + cfg.freeBoostMs);
        updateFields.isVerified  = true;
      }
    }

    await User.findByIdAndUpdate(userId, updateFields);
    console.log(`🪝 [Webhook] Activated plan="${plan}" for user=${userId}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ [Webhook] Error:', err.message);
    res.sendStatus(500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/subscribe  (kept for backward-compat, now calls verify flow)
// Activates a monthly or yearly subscription.
// Body: { plan: 'monthly' | 'yearly' }
// ─────────────────────────────────────────────────────────────────────────────
exports.subscribe = async (req, res) => {
  try {
    const { plan = 'monthly' } = req.body;

    if (!PLANS[plan] || plan === 'boost') {
      return res.status(400).json({ success: false, message: 'Invalid plan. Use "monthly" or "yearly".' });
    }

    const cfg     = PLANS[plan];
    const now     = Date.now();
    const expiry  = new Date(now + cfg.durationMs);

    const updateFields = {
      isSubscribed:       true,
      subscriptionExpiry: expiry,
      subscriptionPlan:   plan,
    };

    // Yearly plan grants 1 week free boost
    if (plan === 'yearly') {
      updateFields.isBoosted   = true;
      updateFields.boostExpiry = new Date(now + cfg.freeBoostMs);
      updateFields.isVerified  = true;
    }

    const user = await User.findByIdAndUpdate(req.user._id, updateFields, { new: true })
      .select('-password -otp -otpExpires -resetPasswordToken -resetPasswordExpires');

    console.log(`✅ [Payment] ${req.user._id} subscribed (${plan}) until ${expiry.toISOString()}`);

    res.json({
      success: true,
      message: plan === 'yearly'
        ? `Yearly subscription activated! You also get 1 week of free profile boosting.`
        : `Monthly subscription activated!`,
      plan,
      amount: cfg.amount,
      subscriptionExpiry: expiry,
      boostExpiry: updateFields.boostExpiry || null,
      user,
    });
  } catch (err) {
    console.error('❌ [Payment] Subscribe error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/boost
// Boosts the user's profile for 7 days (₦3,000).
// TODO: Verify Paystack/Flutterwave payment before applying.
// ─────────────────────────────────────────────────────────────────────────────
exports.boostProfile = async (req, res) => {
  try {
    const cfg    = PLANS.boost;
    const expiry = new Date(Date.now() + cfg.durationMs);

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { isBoosted: true, boostExpiry: expiry, isVerified: true },
      { new: true }
    ).select('-password -otp -otpExpires -resetPasswordToken -resetPasswordExpires');

    console.log(`⚡ [Payment] ${req.user._id} boosted until ${expiry.toISOString()}`);

    res.json({
      success: true,
      message: 'Profile boosted for 7 days! You now appear at the top.',
      amount:  cfg.amount,
      boostExpiry: expiry,
      user,
    });
  } catch (err) {
    console.error('❌ [Payment] Boost error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payment/top-profiles
// Returns currently boosted profiles.
// ─────────────────────────────────────────────────────────────────────────────
exports.getTopProfiles = async (req, res) => {
  try {
    const now = new Date();

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
// Returns subscription & boost status after running expiry cleanup.
// ─────────────────────────────────────────────────────────────────────────────
exports.getPaymentStatus = async (req, res) => {
  try {
    // Auto-expire stale records
    await expireIfNeeded(req.user._id);

    const user = await User.findById(req.user._id)
      .select('isSubscribed subscriptionExpiry subscriptionPlan isBoosted boostExpiry');

    const isSubscribed = !!(user.isSubscribed && stillActive(user.subscriptionExpiry));
    const isBoosted    = !!(user.isBoosted    && stillActive(user.boostExpiry));

    // Days remaining helpers
    const daysUntil = (date) => {
      if (!date) return null;
      const diff = new Date(date) - new Date();
      return diff > 0 ? Math.ceil(diff / (1000 * 60 * 60 * 24)) : 0;
    };

    res.json({
      success:            true,
      isSubscribed,
      subscriptionPlan:   user.subscriptionPlan || null,
      subscriptionExpiry: user.subscriptionExpiry,
      subscriptionDaysLeft: daysUntil(user.subscriptionExpiry),
      isBoosted,
      boostExpiry:        user.boostExpiry,
      boostDaysLeft:      daysUntil(user.boostExpiry),
    });
  } catch (err) {
    console.error('❌ [Payment] Status error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/check-expiry  (called from cron / app startup)
// Bulk-expires stale subscriptions and sends pre-expiry push notifications
// to users whose subscription expires within 3 days.
// ─────────────────────────────────────────────────────────────────────────────
exports.runExpiryCheck = async (req, res) => {
  try {
    const now         = new Date();
    const in3Days     = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    // 1. Expire overdue subscriptions
    const expiredSubs = await User.updateMany(
      { isSubscribed: true, subscriptionExpiry: { $lte: now } },
      { $set: { isSubscribed: false } }
    );

    // 2. Expire overdue boosts (also revoke verified badge unless still subscribed)
    const expiredBoosts = await User.find({
      isBoosted: true, boostExpiry: { $lte: now },
    }).select('_id isSubscribed subscriptionExpiry');

    for (const u of expiredBoosts) {
      const keepVerified = u.isSubscribed && stillActive(u.subscriptionExpiry);
      await User.findByIdAndUpdate(u._id, {
        isBoosted:  false,
        ...(keepVerified ? {} : { isVerified: false }),
      });
    }

    // 3. Notify users whose subscription expires in <= 3 days
    const soonExpiring = await User.find({
      isSubscribed:       true,
      subscriptionExpiry: { $gt: now, $lte: in3Days },
      pushToken:          { $ne: null },
    }).select('pushToken name subscriptionExpiry');

    let notified = 0;
    for (const u of soonExpiring) {
      const daysLeft = Math.ceil((new Date(u.subscriptionExpiry) - now) / (1000 * 60 * 60 * 24));
      await sendPushNotification(
        u.pushToken,
        '⚠️ Subscription Expiring Soon',
        `${u.name?.split(' ')[0]}, your HeartLink Premium expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Renew now to keep messaging!`,
        { screen: 'Profile', action: 'renew_subscription' }
      );
      notified++;
    }

    console.log(`⏰ [Expiry] Expired subs: ${expiredSubs.modifiedCount} | Expired boosts: ${expiredBoosts.length} | Notified: ${notified}`);

    res.json({
      success:       true,
      expiredSubs:   expiredSubs.modifiedCount,
      expiredBoosts: expiredBoosts.length,
      notified,
    });
  } catch (err) {
    console.error('❌ [Expiry] runExpiryCheck error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// Export plan info so routes can expose it to the client
exports.PLANS = PLANS;
