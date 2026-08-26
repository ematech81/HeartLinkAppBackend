const axios = require('axios');
const { generateOtp } = require('./otp');

// ─────────────────────────────────────────────────────────────────────────────
// BulkSMS Nigeria (api/v2) — replaces Twilio.
// Endpoint/auth/body shape confirmed against bulksmsnigeria.com's own API
// docs before implementing (not guessed): POST {base}/sms, Bearer token,
// { from, to, body }, success signalled by response.data.status === 'success'.
// `gateway` is left unspecified — their docs inconsistently reference an
// "otp" gateway option without documenting what it actually does, so rather
// than guess and risk silently misrouting/failing delivery, this uses
// whichever gateway the account defaults to. Set BULKSMS_GATEWAY if you want
// to pin one once BulkSMS confirms its behavior.
// ─────────────────────────────────────────────────────────────────────────────
const BULKSMS_BASE_URL   = process.env.BULKSMS_BASE_URL || 'https://www.bulksmsnigeria.com/api/v2';
const BULKSMS_API_TOKEN  = process.env.BULKSMS_API_TOKEN;
const BULKSMS_SENDER_ID  = process.env.BULKSMS_SENDER_ID || 'HeartLink';
const BULKSMS_GATEWAY    = process.env.BULKSMS_GATEWAY; // optional

/**
 * Send OTP via BulkSMS Nigeria SMS.
 * @param {string} phone - Recipient phone number (e.g. +2348012345678 or 2348012345678 — both accepted)
 * @param {string} otp   - The 6-character alphanumeric OTP code
 */
const sendOtp = async (phone, otp) => {
  if (!BULKSMS_API_TOKEN) {
    console.error('❌ [BulkSMS] BULKSMS_API_TOKEN is not set in .env');
    throw new Error('SMS service not configured.');
  }

  const message = `Your HeartLink verification code is: ${otp}. This code expires in ${process.env.OTP_EXPIRES_MINUTES || 10} minutes. Do not share it with anyone.`;

  try {
    const { data } = await axios.post(
      `${BULKSMS_BASE_URL}/sms`,
      {
        from: BULKSMS_SENDER_ID,
        to:   phone,
        body: message,
        ...(BULKSMS_GATEWAY && { gateway: BULKSMS_GATEWAY }),
      },
      {
        headers: {
          Authorization: `Bearer ${BULKSMS_API_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 15000,
      }
    );

    if (data?.status !== 'success') {
      throw new Error(data?.message || 'BulkSMS did not confirm delivery.');
    }

    console.log(`✅ [BulkSMS] OTP sent to ${phone}`);
  } catch (error) {
    const detail = error.response?.data?.message || error.message;
    console.error(`❌ [BulkSMS] Failed to send OTP to ${phone}:`, detail);
    throw new Error('Failed to send OTP. Please try again.');
  }
};

module.exports = { generateOtp, sendOtp };
