const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const { generateOtp, sendOtp } = require('../utils/SendOTP'); // actual BulkSMS sending lives here
const { sendPasswordResetEmail, sendEmail, sendVerificationEmail } = require('../utils/SendEmail'); // actual Brevo sending lives here
const { otpExpiryDate } = require('../utils/otp'); // shared expiry policy (OTP_EXPIRES_MINUTES) for both SMS OTP and the email reset code below
const axios = require('axios');
// Age validation (validateMinAge) now happens in userController.updateProfile,
// where dateOfBirth is actually collected — not here (see register() below).
// NOTE: this file previously also imported `twilio` directly and
// `{ OAuth2Client }` from google-auth-library — both unused (the actual
// SMS client lives in utils/SendOTP.js; googleAuth below verifies via
// Google's userinfo HTTP endpoint rather than OAuth2Client.verifyIdToken,
// which is a valid approach but never used that import). Removed as dead
// code rather than leaving unused imports around.

// ── Console-log OTPs for local testing ──────────────────────────────────────
// The phone OTP path (sendOtp below) already skips real SMS and logs to
// console outside production. Email OTPs (register/resendEmailOtp) never had
// an equivalent — they always went out for real via Brevo only, with no fast
// local-testing path, even though FORCE_CONSOLE_OTP has sat in .env/.env.example
// unused this whole time. This logs *alongside* the real email send (not
// instead of it) whenever not in production, or whenever FORCE_CONSOLE_OTP is
// explicitly set — so you don't have to wait on/check an inbox while testing.
const shouldLogOtpToConsole = () =>
  process.env.NODE_ENV !== 'production' || process.env.FORCE_CONSOLE_OTP === 'true';

// ── Sign JWT ──────────────────────────────────────────────────────────────────
const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });
 
// ── Strip sensitive fields and send response ──────────────────────────────────
const sendTokenResponse = (user, statusCode, res, extra = {}) => {
  const token = signToken(user._id);
  const userObj = user.toObject ? user.toObject() : { ...user };
  delete userObj.password;
  delete userObj.otp;
  delete userObj.otpExpires;
  delete userObj.resetPasswordToken;
  delete userObj.resetPasswordExpires;

  res.status(statusCode).json({ success: true, token, user: userObj, ...extra });
};
 
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────────────────────
exports.register = async (req, res) => {
  try {
    console.log('📥 [Register] Body received:', {
      ...req.body,
      password: req.body.password ? '***' : undefined,
    });
 
    const {
      name, email, phone, password,
      // gender/dateOfBirth/country/city/relationshipType/agreedToTerms are
      // deliberately NOT read here anymore. Registration now happens in two
      // stages (2026-08-27): this endpoint creates a minimal, unverified
      // account from step 1 (name/email/phone/password) alone, sends the
      // verification code immediately, and the remaining profile-detail
      // steps are collected afterward via the authenticated
      // PUT /api/users/profile (updateProfile) — the exact same
      // "create now, complete profile later" shape Google sign-in already
      // uses (isProfileComplete:false → profile-completion screen). The age
      // check and the Terms/Privacy consent stamp both move with
      // dateOfBirth/agreedToTerms to that later step (see
      // userController.updateProfile, which already enforces both).
    } = req.body;

    // 1. Required fields check — step 1 fields only.
    if (!name || !password) {
      const missing = ['name', 'password'].filter(f => !req.body[f]);
      console.log('❌ [Register] Missing fields:', missing);
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missing.join(', ')}`,
      });
    }

    // 2. Must provide email or phone
    if (!email && !phone) {
      return res.status(400).json({
        success: false,
        message: 'Please provide an email address or phone number.',
      });
    }

    // 3. Check existing user
    const query = [];
    if (email) query.push({ email: email.toLowerCase() });
    if (phone) query.push({ phone });
 
    const existing = await User.findOne({ $or: query });
    if (existing) {
      const field = existing.email === email?.toLowerCase() ? 'email address' : 'phone number';
      console.log(`❌ [Register] Already exists: ${field}`);
      return res.status(400).json({
        success: false,
        message: `This ${field} is already registered. Please log in instead.`,
      });
    }
 
    // 4. Create user — minimal record, same shape as the Google new-user
    // path in googleAuth() below. Profile-detail fields (gender, DOB,
    // country/city, relationshipType, etc.) and the Terms/Privacy consent
    // stamp are collected afterward via updateProfile, once the account is
    // verified and authenticated.
    const userData = {
      name, password,
      isProfileComplete: false,
      ...(email && { email: email.toLowerCase() }),
      ...(phone && { phone }),
    };
 
    console.log('💾 [Register] Creating user:', { ...userData, password: '***' });
 
    const user = await User.create(userData);
    console.log('✅ [Register] User created:', user._id);

    // 5. Email/password accounts must verify their email before they can log
    // in — Google accounts are pre-verified by Google, and phone-only
    // accounts have nothing to email. This account is NOT usable yet: no
    // token is issued here — only verifyEmailOtp (below) issues one, after
    // the code is confirmed.
    if (email) {
      const otp = generateOtp();
      user.emailOtp        = otp;
      user.emailOtpExpires = otpExpiryDate();
      await user.save({ validateBeforeSave: false });

      if (shouldLogOtpToConsole()) {
        console.log(`📧 [Register] *** DEV MODE — Email OTP for ${email}: ${otp} ***`);
      }

      try {
        await sendVerificationEmail(email, otp, name);
      } catch (emailErr) {
        // The account already exists at this point — do NOT report this as
        // "registration failed". Retrying registration would just hit
        // "already registered" with no way forward. Tell the truth instead:
        // account created, verification email didn't go out, resend is
        // available. (This mirrors exactly the confusing gap a network
        // hiccup between client and server can otherwise cause — the
        // account silently exists while the client thinks it doesn't.)
        console.error('❌ [Register] Verification email failed to send:', emailErr.message);
        return res.status(201).json({
          success: true,
          requiresEmailVerification: true,
          email: user.email,
          emailSendFailed: true,
          message: 'Account created, but we could not send the verification email. Tap "Resend Code" to try again.',
        });
      }

      console.log(`✅ [Register] Verification email sent, awaiting confirmation: ${user._id}`);
      return res.status(201).json({
        success: true,
        requiresEmailVerification: true,
        email: user.email,
        message: 'Account created. Check your email for a verification code to activate your account.',
      });
    }

    // Phone-only registration — nothing to verify by email, issue the token now.
    sendTokenResponse(user, 201, res);

  } catch (error) {
    console.error('❌ [Register] Error:', error.message);
    console.error(error.stack);
 
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ success: false, message: messages[0] });
    }
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `This ${field} is already registered.`,
      });
    }
    // Atlas connectivity hiccup (see config/db.js — now fails within 8s,
    // inside the client's own 15s timeout, specifically so this branch is
    // reachable instead of the client always giving up first with a bare
    // "Network Error" and no idea what actually happened server-side).
    if (['MongooseServerSelectionError', 'MongoServerSelectionError', 'MongoNetworkError', 'MongoTimeoutError'].includes(error.name)) {
      return res.status(503).json({
        success: false,
        message: 'We\'re having trouble reaching our database right now. Please try again in a moment.',
      });
    }
    res.status(500).json({ success: false, message: error.message || 'Server error.' });
  }
};
 
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    console.log('📥 [Login] Attempt:', { email: req.body.email, phone: req.body.phone });
 
    const { email, phone, password } = req.body;
 
    if ((!email && !phone) || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide your email/phone and password.',
      });
    }
 
    const query = email ? { email: email.toLowerCase() } : { phone };
    const user  = await User.findOne(query).select('+password');
 
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials. Please check your email/phone and password.',
      });
    }
 
    if (user.isBanned) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been suspended. Please contact support.',
      });
    }

    // Email/password accounts must have verified their email — Google
    // accounts are pre-verified, phone-only accounts have no email to gate.
    if (user.authProvider === 'local' && user.email && !user.isEmailVerified) {
      return res.status(403).json({
        success: false,
        requiresEmailVerification: true,
        email: user.email,
        message: 'Please verify your email before logging in.',
      });
    }

    user.lastSeen = Date.now();
    await user.save({ validateBeforeSave: false });

    console.log('✅ [Login] Success:', user._id);
    sendTokenResponse(user, 200, res);
 
  } catch (error) {
    console.error('❌ [Login] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};
 
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────────────────────
exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    res.status(200).json({ success: true, user });
  } catch (error) {
    console.error('❌ [GetMe] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};
 
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// ─────────────────────────────────────────────────────────────────────────────
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email address is required.' });
    }
 
    const user = await User.findOne({ email: email.toLowerCase() });
 
    // Always return success to prevent email enumeration
    if (!user) {
      return res.status(200).json({
        success: true,
        message: 'If this email is registered, a reset link has been sent.',
      });
    }
 
    // Alphanumeric code — same format/expiry policy as the phone OTP (see
    // utils/otp.js). Was a 6-digit numeric code with a 1-hour expiry;
    // unified to match the SMS OTP convention (alphanumeric, OTP_EXPIRES_MINUTES).
    const resetCode = generateOtp();
    user.resetPasswordToken   = crypto.createHash('sha256').update(resetCode).digest('hex');
    user.resetPasswordExpires = otpExpiryDate();
    await user.save({ validateBeforeSave: false });

    if (process.env.NODE_ENV !== 'production') {
      console.log(`🔑 [ResetPassword] DEV MODE — Code for ${email}: ${resetCode}`);
    } else {
      await sendPasswordResetEmail(user.email, resetCode, user.name);
    }

    res.status(200).json({
      success: true,
      message: 'If this email is registered, a reset code has been sent.',
    });
 
  } catch (error) {
    console.error('❌ [ForgotPassword] Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to send reset email.' });
  }
};
 
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// ─────────────────────────────────────────────────────────────────────────────
exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;
 
    if (!token || !password) {
      return res.status(400).json({ success: false, message: 'Token and new password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }
 
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      resetPasswordToken:   hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    }).select('+resetPasswordToken +resetPasswordExpires');
 
    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset token. Please request a new one.',
      });
    }
 
    user.password             = password;
    user.resetPasswordToken   = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();
 
    sendTokenResponse(user, 200, res);
 
  } catch (error) {
    console.error('❌ [ResetPassword] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};
 
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/send-otp
// Send a 6-character alphanumeric OTP to the given phone number via BulkSMS.
// The user must already have an account with that phone number.
//
// DISABLED (2026-09-03) — unrouted in authRoutes.js. BulkSMS was only
// delivering OTPs after 10am daily, making phone login unreliable; this
// function itself is left working in case a more reliable SMS provider
// replaces BulkSMS later.
// ─────────────────────────────────────────────────────────────────────────────
exports.sendOtp = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number is required.' });
    }

    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(404).json({ success: false, message: 'No account found with this phone number.' });
    }

    if (user.isBanned) {
      return res.status(403).json({ success: false, message: 'Your account has been suspended.' });
    }

    const otp        = generateOtp();
    const otpExpires = otpExpiryDate(); // OTP_EXPIRES_MINUTES (default 10)

    user.otp        = otp;
    user.otpExpires = otpExpires;
    await user.save({ validateBeforeSave: false });

    if (process.env.NODE_ENV === 'production') {
      await sendOtp(phone, otp);
    } else {
      // Development: log OTP to console instead of sending SMS
      console.log(`📱 [OTP] *** DEV MODE — OTP for ${phone}: ${otp} ***`);
    }
    res.status(200).json({ success: true, message: 'OTP sent successfully.' });
  } catch (err) {
    console.error('❌ [OTP] sendOtp error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to send OTP.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/verify-otp
// DISABLED (2026-09-03) — unrouted in authRoutes.js, see sendOtp's note above.
// Verify the OTP and return a JWT if valid.
// Body: { phone, otp }
// ─────────────────────────────────────────────────────────────────────────────
exports.verifyOtp = async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) {
      return res.status(400).json({ success: false, message: 'Phone number and OTP are required.' });
    }

    const user = await User.findOne({ phone }).select('+otp +otpExpires');
    if (!user) {
      return res.status(404).json({ success: false, message: 'No account found with this phone number.' });
    }

    if (!user.isOtpValid(otp)) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
    }

    // Clear OTP after successful verification (it's consumed either way,
    // regardless of what happens next)
    user.otp        = undefined;
    user.otpExpires = undefined;
    await user.save({ validateBeforeSave: false });

    // This is a second, independent login path (passwordless, phone OTP) —
    // without this same check, a user with an email/password account and an
    // unverified email could just switch to the phone tab and bypass the
    // verification gate in login() entirely.
    if (user.authProvider === 'local' && user.email && !user.isEmailVerified) {
      return res.status(403).json({
        success: false,
        requiresEmailVerification: true,
        email: user.email,
        message: 'Please verify your email before logging in.',
      });
    }

    console.log(`✅ [OTP] Verified for ${phone}`);
    sendTokenResponse(user, 200, res);
  } catch (err) {
    console.error('❌ [OTP] verifyOtp error:', err.message);
    res.status(500).json({ success: false, message: 'OTP verification failed.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/verify-email-otp
// Verify the email OTP sent at registration. For email/password accounts,
// this is the ONLY place the JWT is issued — /register deliberately
// withholds it until this succeeds.
// Body: { email, otp }
// ─────────────────────────────────────────────────────────────────────────────
exports.verifyEmailOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and verification code are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() }).select('+emailOtp +emailOtpExpires');
    if (!user) {
      return res.status(404).json({ success: false, message: 'No account found with this email.' });
    }

    // Idempotent — a duplicate/late verify request for an already-verified
    // account just logs them in rather than erroring.
    if (user.isEmailVerified) {
      return sendTokenResponse(user, 200, res);
    }

    if (!user.isEmailOtpValid(otp)) {
      return res.status(400).json({ success: false, message: 'Invalid or expired verification code.' });
    }

    user.isEmailVerified = true;
    user.emailOtp        = undefined;
    user.emailOtpExpires = undefined;
    await user.save({ validateBeforeSave: false });

    console.log(`✅ [VerifyEmail] Verified for ${email}`);

    // Welcome email now that the account is confirmed real — non-blocking,
    // a welcome-email hiccup must never block actual account activation.
    sendEmail(user.email, user.name).catch(() => {});

    sendTokenResponse(user, 200, res);
  } catch (err) {
    console.error('❌ [VerifyEmail] Error:', err.message);
    res.status(500).json({ success: false, message: 'Verification failed.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/resend-email-otp
// Body: { email }
// ─────────────────────────────────────────────────────────────────────────────
exports.resendEmailOtp = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ success: false, message: 'No account found with this email.' });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({ success: false, message: 'This email is already verified. Please log in.' });
    }

    const otp = generateOtp();
    user.emailOtp        = otp;
    user.emailOtpExpires = otpExpiryDate();
    await user.save({ validateBeforeSave: false });

    if (shouldLogOtpToConsole()) {
      console.log(`📧 [ResendEmailOtp] *** DEV MODE — Email OTP for ${email}: ${otp} ***`);
    }

    await sendVerificationEmail(user.email, otp, user.name);

    console.log(`✅ [ResendEmailOtp] Sent to ${email}`);
    res.status(200).json({ success: true, message: 'Verification code resent. Check your email.' });
  } catch (err) {
    console.error('❌ [ResendEmailOtp] Error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to resend verification code.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/google
// DISABLED (2026-09-03) — unrouted in authRoutes.js; Google Sign-In wasn't
// working client-side. Email/password is the only account path for now —
// this function is left intact in case Google sign-in is revisited later.
// Verify a Google access token (via Google's userinfo endpoint — Google's
// servers do the actual signature/validity check), then find-or-create the
// user.
// Body: { accessToken: string }
// Returns: { token, user, isNewUser }
// ─────────────────────────────────────────────────────────────────────────────
exports.googleAuth = async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) {
      return res.status(400).json({ success: false, message: 'accessToken is required.' });
    }

    // Verify the token by calling Google's userinfo endpoint
    let googleUser;
    try {
      const { data } = await axios.get('https://www.googleapis.com/userinfo/v2/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      googleUser = data;
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid Google access token.' });
    }

    const { id: googleId, email, name, picture, verified_email: verifiedEmail } = googleUser;

    if (!email) {
      return res.status(401).json({ success: false, message: 'Google account has no email to sign in with.' });
    }
    // Google explicitly tells us when an email isn't verified — previously
    // this was never checked, so isEmailVerified:true was set unconditionally
    // below regardless of what Google actually reported.
    if (verifiedEmail === false) {
      return res.status(401).json({ success: false, message: 'Google email is not verified.' });
    }

    // ── Find existing user by Google ID or email ──────────────────────────────
    let user = await User.findOne({ $or: [{ googleId }, { email: email?.toLowerCase() }] });
    let isNewUser = false;

    if (user) {
      // Existing user — link googleId if not already set
      if (!user.googleId) {
        user.googleId     = googleId;
        user.authProvider = 'google';
        await user.save();
      }
    } else {
      // New user — create a minimal record; profile completion happens in-app
      isNewUser = true;
      user = await User.create({
        name,
        email:             email?.toLowerCase(),
        googleId,
        authProvider:      'google',
        profilePicture:    picture || null,
        isEmailVerified:   true,   // Google emails are verified
        isProfileComplete: false,
        // password not required for Google users
      });
    }

    if (user.isBanned) {
      return res.status(403).json({ success: false, message: 'Your account has been suspended.' });
    }

    console.log(`✅ [Google Auth] ${isNewUser ? 'New' : 'Existing'} user: ${email}`);
    sendTokenResponse(user, 200, res, { isNewUser });
  } catch (err) {
    console.error('❌ [Google Auth] Error:', err.message);
    res.status(500).json({ success: false, message: 'Google authentication failed.' });
  }
};