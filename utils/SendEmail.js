const axios = require('axios');

// ─────────────────────────────────────────────────────────────────────────────
// Brevo transactional email (v3) — replaces SendGrid.
// Endpoint/auth/body shape confirmed against developers.brevo.com's own API
// reference before implementing: POST https://api.brevo.com/v3/smtp/email,
// header `api-key` (not Bearer — Brevo's own convention), body
// { sender, to, subject, htmlContent, textContent }.
// ─────────────────────────────────────────────────────────────────────────────
const BREVO_API_URL   = 'https://api.brevo.com/v3/smtp/email';
const BREVO_API_KEY   = process.env.BREVO_API_KEY || '';
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL;
const BREVO_FROM_NAME  = process.env.BREVO_FROM_NAME || 'HeartLink';

const isConfigured = () => !!BREVO_API_KEY;

const sendViaBrevo = async ({ to, toName, subject, html, text }) => {
  await axios.post(
    BREVO_API_URL,
    {
      sender:  { email: BREVO_FROM_EMAIL, name: BREVO_FROM_NAME },
      to:      [{ email: to, ...(toName && { name: toName }) }],
      subject,
      htmlContent: html,
      ...(text && { textContent: text }),
    },
    {
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 15000,
    }
  );
};

/**
 * Send a password reset / email-verification code via Brevo.
 * `resetCode` is the same alphanumeric OTP format used for SMS (see
 * utils/otp.js) — not a numeric-only code.
 */
const sendPasswordResetEmail = async (to, resetCode, name) => {
  if (!isConfigured()) {
    console.log(`⚠️  [Email] Brevo not configured — skipping reset email to ${to}`);
    console.log(`🔑 [Email] Reset code for ${to}: ${resetCode}`);
    return;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <h1 style="color:#FF4D6D;text-align:center">♥ HeartLink</h1>
      <div style="background:#fff;border-radius:12px;padding:30px;border:1px solid #F3F4F6">
        <h2 style="color:#1F2937">Reset Your Password</h2>
        <p style="color:#6B7280">Hi <strong>${name}</strong>,</p>
        <p style="color:#6B7280">Enter the code below in the HeartLink app to reset your password.</p>
        <div style="text-align:center;margin:30px 0">
          <div style="display:inline-block;background:#FFF1F3;border:2px solid #FF4D6D;border-radius:12px;padding:20px 40px">
            <p style="margin:0;font-size:13px;color:#6B7280;letter-spacing:1px;text-transform:uppercase">Reset Code</p>
            <p style="margin:8px 0 0;font-size:40px;font-weight:900;color:#FF4D6D;letter-spacing:8px">${resetCode}</p>
          </div>
        </div>
        <p style="color:#9CA3AF;font-size:14px;text-align:center">Expires in <strong>${process.env.OTP_EXPIRES_MINUTES || 10} minutes</strong>. Do not share this code.</p>
      </div>
    </div>
  `;
  const text = `Hi ${name},\n\nYour password reset code is: ${resetCode}\n\nEnter this code in the app to reset your password. It expires in ${process.env.OTP_EXPIRES_MINUTES || 10} minutes.\n\nIf you did not request this, ignore this email.\n\nHeartLink Team`;

  try {
    await sendViaBrevo({ to, toName: name, subject: 'Your HeartLink Password Reset Code', html, text });
    console.log(`✅ [Email] Reset email sent to ${to}`);
  } catch (error) {
    console.error(`❌ [Email] Failed to send to ${to}:`, error.response?.data?.message || error.message);
    throw new Error('Failed to send reset email. Please try again.');
  }
};

/**
 * Send a welcome email after registration.
 */
const sendEmail = async (to, name) => {
  if (!isConfigured()) {
    console.log(`⚠️  [Email] Brevo not configured — skipping welcome email to ${to}`);
    return; // Non-critical — just skip
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <h1 style="color:#FF4D6D;text-align:center">♥ HeartLink</h1>
      <div style="background:#fff;border-radius:12px;padding:30px;border:1px solid #F3F4F6">
        <h2 style="color:#1F2937">Welcome, ${name}! 🎉</h2>
        <p style="color:#6B7280">Your account has been created. You're now part of the HeartLink community — where love finds its way.</p>
      </div>
    </div>
  `;

  try {
    await sendViaBrevo({ to, toName: name, subject: 'Welcome to HeartLink 💕', html });
    console.log(`✅ [Email] Welcome email sent to ${to}`);
  } catch (error) {
    // Non-critical — log but don't throw
    console.error(`⚠️  [Email] Welcome email failed for ${to}:`, error.response?.data?.message || error.message);
  }
};

module.exports = { sendPasswordResetEmail, sendEmail };
