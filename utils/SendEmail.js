const sgMail = require('@sendgrid/mail');

// Only set API key if it looks valid — prevents module crash in dev
const apiKey = process.env.SENDGRID_API_KEY || '';
if (apiKey.startsWith('SG.')) {
  sgMail.setApiKey(apiKey);
}

/**
 * Send a password reset email via SendGrid.
 */
const sendPasswordResetEmail = async (to, resetToken, name) => {
  if (!apiKey.startsWith('SG.')) {
    console.log(`⚠️  [Email] SendGrid not configured — skipping reset email to ${to}`);
    console.log(`🔑 [Email] Reset token for ${to}: ${resetToken}`); // log for dev
    return;
  }

  const resetUrl = `${process.env.CLIENT_URL}/reset-password?token=${resetToken}`;

  const msg = {
    to,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL,
      name:  process.env.SENDGRID_FROM_NAME || 'HeartLink',
    },
    subject: 'Reset Your HeartLink Password',
    text: `Hi ${name},\n\nReset your password here: ${resetUrl}\n\nExpires in 1 hour.\n\nHeartLink Team`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h1 style="color:#FF4D6D;text-align:center">♥ HeartLink</h1>
        <div style="background:#fff;border-radius:12px;padding:30px;border:1px solid #F3F4F6">
          <h2 style="color:#1F2937">Reset Your Password</h2>
          <p style="color:#6B7280">Hi <strong>${name}</strong>,</p>
          <p style="color:#6B7280">Click below to reset your HeartLink password.</p>
          <div style="text-align:center;margin:30px 0">
            <a href="${resetUrl}" style="background:#FF4D6D;color:#fff;padding:14px 32px;text-decoration:none;border-radius:50px;font-weight:bold;font-size:16px;display:inline-block">
              Reset Password
            </a>
          </div>
          <p style="color:#9CA3AF;font-size:14px">This link expires in <strong>1 hour</strong>.</p>
        </div>
      </div>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`✅ [Email] Reset email sent to ${to}`);
  } catch (error) {
    console.error(`❌ [Email] Failed to send to ${to}:`, error.message);
    throw new Error('Failed to send reset email. Please try again.');
  }
};

/**
 * Send a welcome email after registration.
 */
const sendEmail = async (to, name) => {
  if (!apiKey.startsWith('SG.')) {
    console.log(`⚠️  [Email] SendGrid not configured — skipping welcome email to ${to}`);
    return; // Non-critical — just skip
  }

  const msg = {
    to,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL,
      name:  process.env.SENDGRID_FROM_NAME || 'HeartLink',
    },
    subject: 'Welcome to HeartLink 💕',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h1 style="color:#FF4D6D;text-align:center">♥ HeartLink</h1>
        <div style="background:#fff;border-radius:12px;padding:30px;border:1px solid #F3F4F6">
          <h2 style="color:#1F2937">Welcome, ${name}! 🎉</h2>
          <p style="color:#6B7280">Your account has been created. You're now part of the HeartLink community — where love finds its way.</p>
        </div>
      </div>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`✅ [Email] Welcome email sent to ${to}`);
  } catch (error) {
    // Non-critical — log but don't throw
    console.error(`⚠️  [Email] Welcome email failed for ${to}:`, error.message);
  }
};

module.exports = { sendPasswordResetEmail, sendEmail };





// // utils/sendEmail.js

// const nodemailer = require('nodemailer');

// /**
//  * Send email using Nodemailer
//  * @param {Object} options - Email options
//  * @param {string} options.to - Recipient email
//  * @param {string} options.subject - Email subject
//  * @param {string} options.text - Plain text content (optional)
//  * @param {string} options.html - HTML content (optional)
//  */
// const sendEmail = async (options) => {
//   try {
//     // Create transporter
//     const transporter = nodemailer.createTransport({
//       host: process.env.EMAIL_HOST || 'smtp.gmail.com',
//       port: process.env.EMAIL_PORT || 587,
//       secure: process.env.EMAIL_PORT == 465, // true for 465, false for other ports
//       auth: {
//         user: process.env.EMAIL_USER,
//         pass: process.env.EMAIL_PASSWORD,
//       },
//     });

//     // Email options
//     const mailOptions = {
//       from: `${process.env.EMAIL_FROM_NAME || 'PayFlex'} <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
//       to: options.to,
//       subject: options.subject,
//       text: options.text,
//       html: options.html,
//     };

//     // Send email
//     const info = await transporter.sendMail(mailOptions);

//     console.log('✅ Email sent:', info.messageId);
//     return info;

//   } catch (error) {
//     console.error('❌ Email error:', error.message);
//     throw error;
//   }
// };

// module.exports = sendEmail;