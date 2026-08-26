const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const { generateOtp, sendOtp } = require('../utils/SendOTP'); // actual Twilio SMS-sending lives here
const { sendPasswordResetEmail, sendEmail } = require('../utils/SendEmail');
const axios = require('axios');
const { validateMinAge } = require('../utils/age');
// NOTE: this file previously also imported `twilio` directly and
// `{ OAuth2Client }` from google-auth-library — both unused (the actual
// Twilio client lives in utils/SendOTP.js; googleAuth below verifies via
// Google's userinfo HTTP endpoint rather than OAuth2Client.verifyIdToken,
// which is a valid approach but never used that import). Removed as dead
// code rather than leaving unused imports around.

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
      gender, dateOfBirth, country, city, relationshipType,
      lookingFor, education, drink, smoke, religion,
      profession, bio, height, interests,
      numberOfKids, kidsAges,
      agreedToTerms,
    } = req.body;

    // 1. Required fields check
    if (!name || !password || !gender || !dateOfBirth || !country || !city || !relationshipType) {
      const missing = ['name','password','gender','dateOfBirth','country','city','relationshipType']
        .filter(f => !req.body[f]);
      console.log('❌ [Register] Missing fields:', missing);
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missing.join(', ')}`,
      });
    }

    // 1b. Age check — the app's registration form already blocks under-18s
    // client-side (and requires an explicit 18+ consent checkbox), but the
    // API itself must not trust that; anyone calling it directly bypassed
    // both checks entirely before this.
    const ageError = validateMinAge(dateOfBirth);
    if (ageError) {
      console.log('❌ [Register] Age check failed:', ageError);
      return res.status(400).json({ success: false, message: ageError });
    }

    // 1c. Consent — must match the app's Terms/Privacy/guidelines agreement
    // modal. Recorded server-side (agreedToTermsAt) as the durable
    // proof-of-consent record; a client-supplied timestamp is never trusted,
    // only the boolean flag as a trigger to stamp "now".
    if (agreedToTerms !== true) {
      return res.status(400).json({
        success: false,
        message: 'You must agree to the Terms & Conditions to create an account.',
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
 
    // 4. Create user
    const userData = {
      name, password,
      gender, dateOfBirth, country, city, relationshipType,
      agreedToTermsAt: new Date(), // stamped server-side, never client-supplied
      ...(email      && { email: email.toLowerCase() }),
      ...(phone      && { phone }),
      ...(lookingFor && { lookingFor }),
      ...(education  && { education }),
      ...(drink      && { drink }),
      ...(smoke      && { smoke }),
      ...(religion   && { religion }),
      ...(profession && { profession }),
      ...(bio        && { bio }),
      ...(height     && { height: Number(height) }),
      ...(interests?.length  && { interests }),
      ...(numberOfKids       && { numberOfKids: Number(numberOfKids) }),
      ...(kidsAges?.length   && { kidsAges }),
    };
 
    console.log('💾 [Register] Creating user:', { ...userData, password: '***' });
 
    const user = await User.create(userData);
    console.log('✅ [Register] User created:', user._id);
 
    // 5. Send welcome email (non-blocking)
    if (email) sendEmail(email, name).catch(() => {});
 
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
 
    // 6-digit code — easy for mobile users to type from email
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetPasswordToken   = crypto.createHash('sha256').update(resetCode).digest('hex');
    user.resetPasswordExpires = Date.now() + 60 * 60 * 1000; // 1 hour
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
// Send a 6-digit OTP to the given phone number via Twilio SMS.
// The user must already have an account with that phone number.
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
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

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

    // Clear OTP after successful verification
    user.otp        = undefined;
    user.otpExpires = undefined;
    await user.save({ validateBeforeSave: false });

    console.log(`✅ [OTP] Verified for ${phone}`);
    sendTokenResponse(user, 200, res);
  } catch (err) {
    console.error('❌ [OTP] verifyOtp error:', err.message);
    res.status(500).json({ success: false, message: 'OTP verification failed.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/google
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