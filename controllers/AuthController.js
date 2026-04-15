const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const { generateOtp, sendOtp } = require('../utils/SendOTP');
const { sendPasswordResetEmail, sendEmail } = require('../utils/SendEmail');
const twilio = require('twilio');
const { OAuth2Client } = require('google-auth-library');
const axios = require('axios');



// // // Initialize Twilio client
// const twilioClient = twilio(
//   process.env.TWILIO_ACCOUNT_SID,
//   process.env.TWILIO_AUTH_TOKEN
// );
 

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
 




// ============================================
// SEND OTP (REFACTORED WITH BYPASS)
// ============================================
 
// /**
//  * Send OTP via SMS or Email
//  * In development: Logs OTP to console instead of sending
//  * @route POST /api/auth/send-otp
//  * @access Public
//  */
// exports.sendOTP = async (req, res) => {
//   try {
//     const { phone, email } = req.body;
 
//     // Validate input - must provide phone OR email
//     if (!phone && !email) {
//       return res.status(400).json({
//         success: false,
//         message: 'Phone number or email is required',
//       });
//     }
 
//     console.log('📱 [SendOTP] Request:', { phone, email });
 
//     // Determine delivery method
//     const deliveryMethod = phone ? 'sms' : 'email';
//     const recipient = phone || email;
 
//     // Check if user exists
//     let user = await User.findOne(
//       phone ? { phoneNumber: phone } : { email: email }
//     );
 
//     if (!user) {
//       // Create new user if doesn't exist
//       user = await User.create({
//         phoneNumber: phone,
//         email: email,
//         registrationMethod: deliveryMethod,
//       });
//       console.log('✅ [SendOTP] New user created:', user._id);
//     }
 
//     // Generate 6-digit OTP
//     const otpCode = crypto.randomInt(100000, 999999).toString();
 
//     // Delete any existing OTPs for this user
//     await OTP.deleteMany({ userId: user._id });
 
//     // Save OTP to database
//     const otp = await OTP.create({
//       userId: user._id,
//       code: otpCode,
//       phoneNumber: phone,
//       email: email,
//       expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
//     });
 
//     console.log('🔐 [SendOTP] OTP generated:', otpCode);
 
//     // ============================================
//     // DELIVERY LOGIC
//     // ============================================
 
//     const isDevelopment = process.env.NODE_ENV !== 'production';
//     const forceConsoleOTP = process.env.FORCE_CONSOLE_OTP === 'true';
 
//     if (deliveryMethod === 'sms') {
//       // ============================================
//       // SMS DELIVERY
//       // ============================================
 
//       if (isDevelopment || forceConsoleOTP) {
//         // 🔧 DEVELOPMENT MODE: Log OTP to console
//         console.log('');
//         console.log('╔════════════════════════════════════╗');
//         console.log('║     🔐 OTP CODE (DEVELOPMENT)     ║');
//         console.log('╠════════════════════════════════════╣');
//         console.log(`║  Phone: ${phone.padEnd(23)} ║`);
//         console.log(`║  Code:  ${otpCode.padEnd(23)} ║`);
//         console.log(`║  Expires: 10 minutes              ║`);
//         console.log('╚════════════════════════════════════╝');
//         console.log('');
 
//         return res.json({
//           success: true,
//           message: 'OTP sent successfully (check backend console)',
//           developmentMode: true,
//           otp: isDevelopment ? otpCode : undefined, // Include OTP in response for dev
//         });
//       }
 
//       // 🚀 PRODUCTION MODE: Send via Twilio
//       try {
//         await twilioClient.messages.create({
//           body: `Your PayFlex verification code is: ${otpCode}. Valid for 10 minutes.`,
//           from: process.env.TWILIO_PHONE_NUMBER,
//           to: phone,
//         });
 
//         console.log('✅ [SendOTP] SMS sent successfully via Twilio');
 
//         return res.json({
//           success: true,
//           message: 'OTP sent successfully to your phone',
//         });
 
//       } catch (twilioError) {
//         console.error('❌ [Twilio Error]:', twilioError.message);
 
//         // Fallback: Send via email if SMS fails
//         if (user.email) {
//           console.log('🔄 [SendOTP] SMS failed, attempting email fallback...');
 
//           try {
//             await sendEmail({
//               to: user.email,
//               subject: 'PayFlex - Your Verification Code',
//               html: `
//                 <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
//                   <h2 style="color: #2196F3;">PayFlex Verification Code</h2>
//                   <p>Your verification code is:</p>
//                   <div style="background: #f5f5f5; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
//                     ${otpCode}
//                   </div>
//                   <p style="color: #666;">This code will expire in 10 minutes.</p>
//                   <p style="color: #666; font-size: 12px;">If you didn't request this code, please ignore this email.</p>
//                 </div>
//               `,
//             });
 
//             console.log('✅ [SendOTP] Email fallback sent successfully');
 
//             return res.json({
//               success: true,
//               message: 'SMS delivery failed. OTP sent to your email instead.',
//               fallbackMethod: 'email',
//             });
 
//           } catch (emailError) {
//             console.error('❌ [Email Fallback Error]:', emailError.message);
//             throw new Error('Failed to send OTP via SMS or email');
//           }
//         }
 
//         // No email fallback available
//         throw twilioError;
//       }
 
//     } else {
//       // ============================================
//       // EMAIL DELIVERY
//       // ============================================
 
//       if (isDevelopment || forceConsoleOTP) {
//         // 🔧 DEVELOPMENT MODE: Log OTP to console
//         console.log('');
//         console.log('╔════════════════════════════════════╗');
//         console.log('║     🔐 OTP CODE (DEVELOPMENT)     ║');
//         console.log('╠════════════════════════════════════╣');
//         console.log(`║  Email: ${email.padEnd(22)} ║`);
//         console.log(`║  Code:  ${otpCode.padEnd(23)} ║`);
//         console.log(`║  Expires: 10 minutes              ║`);
//         console.log('╚════════════════════════════════════╝');
//         console.log('');
 
//         return res.json({
//           success: true,
//           message: 'OTP sent successfully (check backend console)',
//           developmentMode: true,
//           otp: isDevelopment ? otpCode : undefined,
//         });
//       }
 
//       // 🚀 PRODUCTION MODE: Send via email
//       try {
//         await sendEmail({
//           to: email,
//           subject: 'PayFlex - Your Verification Code',
//           html: `
//             <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
//               <h2 style="color: #2196F3;">PayFlex Verification Code</h2>
//               <p>Your verification code is:</p>
//               <div style="background: #f5f5f5; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
//                 ${otpCode}
//               </div>
//               <p style="color: #666;">This code will expire in 10 minutes.</p>
//               <p style="color: #666; font-size: 12px;">If you didn't request this code, please ignore this email.</p>
//             </div>
//           `,
//         });
 
//         console.log('✅ [SendOTP] Email sent successfully');
 
//         return res.json({
//           success: true,
//           message: 'OTP sent successfully to your email',
//         });
 
//       } catch (emailError) {
//         console.error('❌ [Email Error]:', emailError.message);
//         throw emailError;
//       }
//     }
 
//   } catch (error) {
//     console.error('❌ [SendOTP] Error:', error.message);
    
//     res.status(500).json({
//       success: false,
//       message: 'Failed to send OTP. Please try again.',
//       error: process.env.NODE_ENV === 'development' ? error.message : undefined,
//     });
//   }
// };
 
// // ============================================
// // VERIFY OTP (UPDATED)
// // ============================================
 
// /**
//  * Verify OTP and login/register user
//  * @route POST /api/auth/verify-otp
//  * @access Public
//  */
// exports.verifyOTP = async (req, res) => {
//   try {
//     const { phone, email, code } = req.body;
 
//     // Validate input
//     if ((!phone && !email) || !code) {
//       return res.status(400).json({
//         success: false,
//         message: 'Phone/email and OTP code are required',
//       });
//     }
 
//     console.log('🔐 [VerifyOTP] Request:', { phone, email, code });
 
//     // Find user
//     const user = await User.findOne(
//       phone ? { phoneNumber: phone } : { email: email }
//     );
 
//     if (!user) {
//       return res.status(404).json({
//         success: false,
//         message: 'User not found',
//       });
//     }
 
//     // Find OTP
//     const otp = await OTP.findOne({
//       userId: user._id,
//       code: code,
//     });
 
//     if (!otp) {
//       return res.status(401).json({
//         success: false,
//         message: 'Invalid OTP code',
//       });
//     }
 
//     // Check if OTP is expired
//     if (otp.expiresAt < new Date()) {
//       await OTP.deleteOne({ _id: otp._id });
//       return res.status(401).json({
//         success: false,
//         message: 'OTP has expired. Please request a new one.',
//       });
//     }
 
//     // Check if OTP was already used
//     if (otp.isUsed) {
//       return res.status(401).json({
//         success: false,
//         message: 'OTP has already been used',
//       });
//     }
 
//     // Mark OTP as used
//     otp.isUsed = true;
//     await otp.save();
 
//     // Update user verification status
//     if (phone) {
//       user.isPhoneVerified = true;
//     }
//     if (email) {
//       user.isEmailVerified = true;
//     }
//     await user.save();
 
//     // Generate JWT token
//     const token = user.generateAuthToken();
 
//     console.log('✅ [VerifyOTP] Success for user:', user._id);
 
//     res.json({
//       success: true,
//       message: 'OTP verified successfully',
//       token,
//       user: {
//         id: user._id,
//         phoneNumber: user.phoneNumber,
//         email: user.email,
//         firstName: user.firstName,
//         lastName: user.lastName,
//         isPhoneVerified: user.isPhoneVerified,
//         isEmailVerified: user.isEmailVerified,
//       },
//     });
 
//     // Delete used OTP
//     await OTP.deleteOne({ _id: otp._id });
 
//   } catch (error) {
//     console.error('❌ [VerifyOTP] Error:', error.message);
//     res.status(500).json({
//       success: false,
//       message: 'Failed to verify OTP',
//       error: process.env.NODE_ENV === 'development' ? error.message : undefined,
//     });
//   }
// };

 
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





// // controllers/authController.js - COMPLETE WORKING VERSION

// const crypto = require('crypto');
// const bcrypt = require('bcryptjs');
// const jwt = require('jsonwebtoken');
// const User = require('../models/User');
// // const OTP = require('../models/OTP'); // Make sure this model exists!
// const sendEmail = require('../utils/sendEmail');

// // Twilio setup (optional - only if you want SMS in production)
// let twilioClient = null;
// try {
//   if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
//     const twilio = require('twilio');
//     twilioClient = twilio(
//       process.env.TWILIO_ACCOUNT_SID,
//       process.env.TWILIO_AUTH_TOKEN
//     );
//   }
// } catch (error) {
//   console.warn('⚠️ Twilio not configured, SMS disabled');
// }

// // ============================================
// // SEND OTP
// // ============================================

// exports.sendOTP = async (req, res) => {
//   try {
//     const { phone, email } = req.body;

//     // Validate input - must provide phone OR email
//     if (!phone && !email) {
//       return res.status(400).json({
//         success: false,
//         message: 'Phone number or email is required',
//       });
//     }

//     console.log('📱 [SendOTP] Request:', { phone, email });

//     // Determine delivery method
//     const deliveryMethod = phone ? 'sms' : 'email';
//     const recipient = phone || email;

//     // Check if user exists
//     let user = await User.findOne(
//       phone ? { phoneNumber: phone } : { email: email }
//     );

//     if (!user) {
//       // Create new user if doesn't exist
//       user = await User.create({
//         phoneNumber: phone,
//         email: email,
//         registrationMethod: deliveryMethod,
//       });
//       console.log('✅ [SendOTP] New user created:', user._id);
//     }

//     // Generate 6-digit OTP
//     const otpCode = crypto.randomInt(100000, 999999).toString();

//     // Delete any existing OTPs for this user
//     await OTP.deleteMany({ userId: user._id });

//     // Save OTP to database
//     const otp = await OTP.create({
//       userId: user._id,
//       code: otpCode,
//       phoneNumber: phone,
//       email: email,
//       expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
//     });

//     console.log('🔐 [SendOTP] OTP generated:', otpCode);

//     // ============================================
//     // DELIVERY LOGIC
//     // ============================================

//     const isDevelopment = process.env.NODE_ENV !== 'production';
//     const forceConsoleOTP = process.env.FORCE_CONSOLE_OTP === 'true';

//     if (deliveryMethod === 'sms') {
//       // ============================================
//       // SMS DELIVERY
//       // ============================================

//       if (isDevelopment || forceConsoleOTP) {
//         // 🔧 DEVELOPMENT MODE: Log OTP to console
//         console.log('');
//         console.log('╔════════════════════════════════════╗');
//         console.log('║     🔐 OTP CODE (DEVELOPMENT)     ║');
//         console.log('╠════════════════════════════════════╣');
//         console.log(`║  Phone: ${phone.padEnd(23)} ║`);
//         console.log(`║  Code:  ${otpCode.padEnd(23)} ║`);
//         console.log(`║  Expires: 10 minutes              ║`);
//         console.log('╚════════════════════════════════════╝');
//         console.log('');

//         return res.json({
//           success: true,
//           message: 'OTP sent successfully (check backend console)',
//           developmentMode: true,
//           otp: isDevelopment ? otpCode : undefined, // Include OTP in response for dev
//         });
//       }

//       // 🚀 PRODUCTION MODE: Send via Twilio
//       if (twilioClient) {
//         try {
//           await twilioClient.messages.create({
//             body: `Your PayFlex verification code is: ${otpCode}. Valid for 10 minutes.`,
//             from: process.env.TWILIO_PHONE_NUMBER,
//             to: phone,
//           });

//           console.log('✅ [SendOTP] SMS sent successfully via Twilio');

//           return res.json({
//             success: true,
//             message: 'OTP sent successfully to your phone',
//           });

//         } catch (twilioError) {
//           console.error('❌ [Twilio Error]:', twilioError.message);

//           // Fallback: Send via email if SMS fails
//           if (user.email) {
//             console.log('🔄 [SendOTP] SMS failed, attempting email fallback...');

//             try {
//               await sendEmail({
//                 to: user.email,
//                 subject: 'PayFlex - Your Verification Code',
//                 html: `
//                   <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
//                     <h2 style="color: #2196F3;">PayFlex Verification Code</h2>
//                     <p>Your verification code is:</p>
//                     <div style="background: #f5f5f5; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
//                       ${otpCode}
//                     </div>
//                     <p style="color: #666;">This code will expire in 10 minutes.</p>
//                     <p style="color: #666; font-size: 12px;">If you didn't request this code, please ignore this email.</p>
//                   </div>
//                 `,
//               });

//               console.log('✅ [SendOTP] Email fallback sent successfully');

//               return res.json({
//                 success: true,
//                 message: 'SMS delivery failed. OTP sent to your email instead.',
//                 fallbackMethod: 'email',
//               });

//             } catch (emailError) {
//               console.error('❌ [Email Fallback Error]:', emailError.message);
//               throw new Error('Failed to send OTP via SMS or email');
//             }
//           }

//           // No email fallback available
//           throw twilioError;
//         }
//       } else {
//         // No Twilio configured - log to console
//         console.log('⚠️ Twilio not configured, logging OTP to console');
//         console.log('');
//         console.log('╔════════════════════════════════════╗');
//         console.log('║     🔐 OTP CODE (NO SMS)          ║');
//         console.log('╠════════════════════════════════════╣');
//         console.log(`║  Phone: ${phone.padEnd(23)} ║`);
//         console.log(`║  Code:  ${otpCode.padEnd(23)} ║`);
//         console.log('╚════════════════════════════════════╝');
//         console.log('');

//         return res.json({
//           success: true,
//           message: 'OTP sent successfully (check backend console)',
//           developmentMode: true,
//           otp: otpCode,
//         });
//       }

//     } else {
//       // ============================================
//       // EMAIL DELIVERY
//       // ============================================

//       if (isDevelopment || forceConsoleOTP) {
//         // 🔧 DEVELOPMENT MODE: Log OTP to console
//         console.log('');
//         console.log('╔════════════════════════════════════╗');
//         console.log('║     🔐 OTP CODE (DEVELOPMENT)     ║');
//         console.log('╠════════════════════════════════════╣');
//         console.log(`║  Email: ${email.padEnd(22)} ║`);
//         console.log(`║  Code:  ${otpCode.padEnd(23)} ║`);
//         console.log(`║  Expires: 10 minutes              ║`);
//         console.log('╚════════════════════════════════════╝');
//         console.log('');

//         return res.json({
//           success: true,
//           message: 'OTP sent successfully (check backend console)',
//           developmentMode: true,
//           otp: isDevelopment ? otpCode : undefined,
//         });
//       }

//       // 🚀 PRODUCTION MODE: Send via email
//       try {
//         await sendEmail({
//           to: email,
//           subject: 'PayFlex - Your Verification Code',
//           html: `
//             <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
//               <h2 style="color: #2196F3;">PayFlex Verification Code</h2>
//               <p>Your verification code is:</p>
//               <div style="background: #f5f5f5; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
//                 ${otpCode}
//               </div>
//               <p style="color: #666;">This code will expire in 10 minutes.</p>
//               <p style="color: #666; font-size: 12px;">If you didn't request this code, please ignore this email.</p>
//             </div>
//           `,
//         });

//         console.log('✅ [SendOTP] Email sent successfully');

//         return res.json({
//           success: true,
//           message: 'OTP sent successfully to your email',
//         });

//       } catch (emailError) {
//         console.error('❌ [Email Error]:', emailError.message);
//         throw emailError;
//       }
//     }

//   } catch (error) {
//     console.error('❌ [SendOTP] Error:', error.message);
    
//     res.status(500).json({
//       success: false,
//       message: 'Failed to send OTP. Please try again.',
//       error: process.env.NODE_ENV === 'development' ? error.message : undefined,
//     });
//   }
// };

// // ============================================
// // VERIFY OTP
// // ============================================

// exports.verifyOTP = async (req, res) => {
//   try {
//     const { phone, email, code } = req.body;

//     // Validate input
//     if ((!phone && !email) || !code) {
//       return res.status(400).json({
//         success: false,
//         message: 'Phone/email and OTP code are required',
//       });
//     }

//     console.log('🔐 [VerifyOTP] Request:', { phone, email, code });

//     // Find user
//     const user = await User.findOne(
//       phone ? { phoneNumber: phone } : { email: email }
//     );

//     if (!user) {
//       return res.status(404).json({
//         success: false,
//         message: 'User not found',
//       });
//     }

//     // Find OTP
//     const otp = await OTP.findOne({
//       userId: user._id,
//       code: code,
//     });

//     if (!otp) {
//       return res.status(401).json({
//         success: false,
//         message: 'Invalid OTP code',
//       });
//     }

//     // Check if OTP is expired
//     if (otp.expiresAt < new Date()) {
//       await OTP.deleteOne({ _id: otp._id });
//       return res.status(401).json({
//         success: false,
//         message: 'OTP has expired. Please request a new one.',
//       });
//     }

//     // Check if OTP was already used
//     if (otp.isUsed) {
//       return res.status(401).json({
//         success: false,
//         message: 'OTP has already been used',
//       });
//     }

//     // Mark OTP as used
//     otp.isUsed = true;
//     await otp.save();

//     // Update user verification status
//     if (phone) {
//       user.isPhoneVerified = true;
//     }
//     if (email) {
//       user.isEmailVerified = true;
//     }
//     await user.save();

//     // Generate JWT token
//     const token = user.generateAuthToken();

//     console.log('✅ [VerifyOTP] Success for user:', user._id);

//     res.json({
//       success: true,
//       message: 'OTP verified successfully',
//       token,
//       user: {
//         id: user._id,
//         phoneNumber: user.phoneNumber,
//         email: user.email,
//         firstName: user.firstName,
//         lastName: user.lastName,
//         isPhoneVerified: user.isPhoneVerified,
//         isEmailVerified: user.isEmailVerified,
//       },
//     });

//     // Delete used OTP
//     await OTP.deleteOne({ _id: otp._id });

//   } catch (error) {
//     console.error('❌ [VerifyOTP] Error:', error.message);
//     res.status(500).json({
//       success: false,
//       message: 'Failed to verify OTP',
//       error: process.env.NODE_ENV === 'development' ? error.message : undefined,
//     });
//   }
// };

// // ============================================
// // EMAIL/PASSWORD REGISTER
// // ============================================

// exports.register = async (req, res) => {
//   try {
//     const { email, password, firstName, lastName, phoneNumber } = req.body;

//     // Validate required fields
//     if (!email || !password) {
//       return res.status(400).json({
//         success: false,
//         message: 'Email and password are required',
//       });
//     }

//     // Check if user exists
//     const existingUser = await User.findOne({ email });
//     if (existingUser) {
//       return res.status(400).json({
//         success: false,
//         message: 'User already exists with this email',
//       });
//     }

//     // Create user
//     const user = await User.create({
//       email,
//       password, // Will be hashed by pre-save hook
//       firstName,
//       lastName,
//       phoneNumber,
//       isEmailVerified: false,
//       registrationMethod: 'email',
//     });

//     // Generate token
//     const token = user.generateAuthToken();

//     res.status(201).json({
//       success: true,
//       message: 'Registration successful',
//       token,
//       user: {
//         id: user._id,
//         email: user.email,
//         firstName: user.firstName,
//         lastName: user.lastName,
//         phoneNumber: user.phoneNumber,
//       },
//     });

//   } catch (error) {
//     console.error('❌ Register Error:', error.message);
//     res.status(500).json({
//       success: false,
//       message: 'Registration failed',
//       error: process.env.NODE_ENV === 'development' ? error.message : undefined,
//     });
//   }
// };

// // ============================================
// // EMAIL/PASSWORD LOGIN
// // ============================================

// exports.login = async (req, res) => {
//   try {
//     const { email, password } = req.body;

//     // Validate input
//     if (!email || !password) {
//       return res.status(400).json({
//         success: false,
//         message: 'Email and password are required',
//       });
//     }

//     // Find user with password field
//     const user = await User.findOne({ email }).select('+password');

//     if (!user) {
//       return res.status(401).json({
//         success: false,
//         message: 'Invalid email or password',
//       });
//     }

//     // Check password
//     const isPasswordValid = await user.comparePassword(password);

//     if (!isPasswordValid) {
//       return res.status(401).json({
//         success: false,
//         message: 'Invalid email or password',
//       });
//     }

//     // Generate token
//     const token = user.generateAuthToken();

//     res.json({
//       success: true,
//       message: 'Login successful',
//       token,
//       user: {
//         id: user._id,
//         email: user.email,
//         firstName: user.firstName,
//         lastName: user.lastName,
//         phoneNumber: user.phoneNumber,
//         isEmailVerified: user.isEmailVerified,
//         isPhoneVerified: user.isPhoneVerified,
//       },
//     });

//   } catch (error) {
//     console.error('❌ Login Error:', error.message);
//     res.status(500).json({
//       success: false,
//       message: 'Login failed',
//       error: process.env.NODE_ENV === 'development' ? error.message : undefined,
//     });
//   }
// };

// // ============================================
// // GET CURRENT USER
// // ============================================

// exports.getMe = async (req, res) => {
//   try {
//     const user = await User.findById(req.user._id);

//     res.json({
//       success: true,
//       user: {
//         id: user._id,
//         email: user.email,
//         phoneNumber: user.phoneNumber,
//         firstName: user.firstName,
//         lastName: user.lastName,
//         isEmailVerified: user.isEmailVerified,
//         isPhoneVerified: user.isPhoneVerified,
//         walletBalance: user.walletBalance,
//       },
//     });

//   } catch (error) {
//     console.error('❌ GetMe Error:', error.message);
//     res.status(500).json({
//       success: false,
//       message: 'Failed to get user',
//     });
//   }
// };

// // ============================================
// // LOGOUT
// // ============================================

// exports.logout = async (req, res) => {
//   try {
//     // In JWT-based auth, logout is handled client-side by removing the token
//     res.json({
//       success: true,
//       message: 'Logged out successfully',
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: 'Logout failed',
//     });
//   }
// };

// module.exports = {
//   sendOTP: exports.sendOTP,
//   verifyOTP: exports.verifyOTP,
//   register: exports.register,
//   login: exports.login,
//   getMe: exports.getMe,
//   logout: exports.logout,
// };

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
// Verify a Google ID token, then find-or-create the user.
// Body: { idToken: string }
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

    const { id: googleId, email, name, picture } = googleUser;

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