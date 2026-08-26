const crypto = require('crypto');

/**
 * Shared OTP generation — used for both the phone/SMS OTP flow
 * (AuthController.sendOtp/verifyOtp) and the email password-reset code
 * (AuthController.forgotPassword), so both channels share one format and
 * one expiry policy.
 *
 * Alphanumeric, not purely numeric (e.g. "OT34K6") — per your standing
 * convention across apps: a 6-digit numeric code matches the shape mobile
 * carriers (Nigerian telcos especially) filter/throttle as "transactional
 * OTP" traffic unless the sender ID is separately registered for that
 * category. Alphanumeric codes fall outside that classification.
 */

const OTP_LENGTH  = 6;
const OTP_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const OTP_EXPIRES_MINUTES = parseInt(process.env.OTP_EXPIRES_MINUTES, 10) || 10;

const generateOtp = (length = OTP_LENGTH) => {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += OTP_CHARSET[crypto.randomInt(OTP_CHARSET.length)];
  }
  return code;
};

const otpExpiryDate = () => new Date(Date.now() + OTP_EXPIRES_MINUTES * 60 * 1000);

module.exports = { generateOtp, otpExpiryDate, OTP_EXPIRES_MINUTES };
