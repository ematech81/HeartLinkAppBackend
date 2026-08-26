const rateLimit = require('express-rate-limit');

/**
 * Rate limiters for the auth surface.
 *
 * Before this, express-rate-limit was an installed-but-unused dependency —
 * /login, /send-otp, /verify-otp, and /reset-password had no attempt limit
 * at all, so a script could brute-force a password, a 6-digit OTP (10-minute
 * window, ~900,000 combos), or a 6-digit password-reset code with no
 * friction. These limiters key on IP by default (see `app.set('trust proxy', ...)`
 * in server.js — required for the real client IP to be seen behind Railway's
 * proxy instead of limiting everyone as a single caller).
 */

// General login/register/google — generous enough not to bother real users
// switching networks or mistyping a password a few times.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in a few minutes.' },
});

// OTP send/verify guard a 6-digit code — needs to be tight enough that
// brute-forcing the ~900,000-combo keyspace inside the 10-minute OTP expiry
// is infeasible.
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many OTP requests. Please wait a few minutes and try again.' },
});

// Password reset also guards a 6-digit code (see AuthController.resetPassword).
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many reset attempts. Please wait a few minutes and try again.' },
});

module.exports = { authLimiter, otpLimiter, passwordResetLimiter };
