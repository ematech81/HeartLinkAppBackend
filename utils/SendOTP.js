const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Generate a 6-digit OTP code.
 */
const generateOtp = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Send OTP via Twilio SMS.
 * @param {string} phone - Recipient phone number (e.g. +2348012345678)
 * @param {string} otp   - The 6-digit OTP code
 */
const sendOtp = async (phone, otp) => {
  const message = `Your HeartLink verification code is: ${otp}. This code expires in 10 minutes. Do not share it with anyone.`;

  try {
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
    });
    console.log(`✅ OTP sent to ${phone}`);
  } catch (error) {
    console.error(`❌ Failed to send OTP to ${phone}:`, error.message);
    throw new Error('Failed to send OTP. Please try again.');
  }
};

module.exports = { generateOtp, sendOtp };