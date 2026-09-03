
const express = require('express');
const router = express.Router();
const {
  register,
  login,
  getMe,
  verifyEmailOtp,
  resendEmailOtp,
  forgotPassword,
  resetPassword,
} = require('../controllers/AuthController');
const { protect } = require('../middleware/authMiddleware');
const { authLimiter, otpLimiter, passwordResetLimiter } = require('../middleware/rateLimiter');

// ── Public routes ─────────────────────────────────────────────────────────────
// Google Sign-In (/google) and phone/OTP login+registration (/send-otp,
// /verify-otp) are disabled (2026-09-03) — Google wasn't working, and
// BulkSMS was only delivering OTPs after 10am daily, making phone login
// unreliable. Email/password is now the only account path. The controller
// functions themselves (sendOtp, verifyOtp, googleAuth) are left intact in
// AuthController.js, just unrouted here — re-add the three lines below to
// bring a path back once its underlying issue is actually fixed.
//   router.post('/google',     authLimiter, googleAuth);
//   router.post('/send-otp',   otpLimiter,  sendOtp);
//   router.post('/verify-otp', otpLimiter,  verifyOtp);
router.post('/register',          authLimiter,         register);
router.post('/login',             authLimiter,         login);
router.post('/verify-email-otp',  otpLimiter,          verifyEmailOtp);
router.post('/resend-email-otp',  otpLimiter,          resendEmailOtp);
router.post('/forgot-password',   passwordResetLimiter, forgotPassword);
router.post('/reset-password',    passwordResetLimiter, resetPassword);

// ── Protected routes ──────────────────────────────────────────────────────────
router.get('/me', protect, getMe);

module.exports = router;