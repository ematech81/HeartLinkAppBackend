
const express = require('express');
const router = express.Router();
const {
  register,
  login,
  getMe,
  sendOtp,
  verifyOtp,
  forgotPassword,
  resetPassword,
  googleAuth,
} = require('../controllers/AuthController');
const { protect } = require('../middleware/AuthMiddleware');

// ── Public routes ─────────────────────────────────────────────────────────────
router.post('/register',        register);
router.post('/login',           login);
router.post('/google',          googleAuth);
router.post('/send-otp',    sendOtp);
router.post('/verify-otp',  verifyOtp);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password',  resetPassword);

// ── Protected routes ──────────────────────────────────────────────────────────
router.get('/me', protect, getMe);

module.exports = router;