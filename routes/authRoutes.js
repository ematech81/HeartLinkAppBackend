
const express = require('express');
const router = express.Router();
const {
  register,
  login,
  getMe,
  sendOtp,
  verifyOtp,
  verifyEmailOtp,
  resendEmailOtp,
  forgotPassword,
  resetPassword,
  googleAuth,
} = require('../controllers/AuthController');
const { protect } = require('../middleware/authMiddleware');
const { authLimiter, otpLimiter, passwordResetLimiter } = require('../middleware/rateLimiter');

// ── Public routes ─────────────────────────────────────────────────────────────
router.post('/register',          authLimiter,         register);
router.post('/login',             authLimiter,         login);
router.post('/google',            authLimiter,         googleAuth);
router.post('/send-otp',          otpLimiter,          sendOtp);
router.post('/verify-otp',        otpLimiter,          verifyOtp);
router.post('/verify-email-otp',  otpLimiter,          verifyEmailOtp);
router.post('/resend-email-otp',  otpLimiter,          resendEmailOtp);
router.post('/forgot-password',   passwordResetLimiter, forgotPassword);
router.post('/reset-password',    passwordResetLimiter, resetPassword);

// ── Protected routes ──────────────────────────────────────────────────────────
router.get('/me', protect, getMe);

module.exports = router;