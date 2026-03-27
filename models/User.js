const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    // ── Step 1: Basic Info ─────────────────────────────────────────────────
    name: {
      type: String, required: [true, 'Full name is required'],
      trim: true, minlength: 2, maxlength: 60,
    },
    email: {
      type: String, unique: true, sparse: true,
      lowercase: true, trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email'],
    },
    phone:    { type: String, unique: true, sparse: true, trim: true },
    password: { type: String, required: true, minlength: 8, select: false },

    // ── Step 2: Personal Info ──────────────────────────────────────────────
    gender: {
      type: String, enum: ['male', 'female'],
      required: [true, 'Gender is required'],
    },
    dateOfBirth: { type: Date, required: [true, 'Date of birth is required'] },
    country:     { type: String, required: true, trim: true },
    city:        { type: String, required: true, trim: true },
    relationshipType: {
      type: String,
      enum: ['single', 'single_mother', 'single_father'],
      required: true,
    },

    // ── Step 3: Looking For ────────────────────────────────────────────────
    lookingFor: {
      type: String,
      enum: ['male', 'female', 'both'],
      default: 'both',
    },

    // ── Step 4: Education ──────────────────────────────────────────────────
    education: {
      type: String,
      enum: ['high_school', 'diploma', 'bachelors', 'masters', 'phd', 'vocational', 'none'],
    },

    // ── Step 5: Kids (single parents) ─────────────────────────────────────
    numberOfKids: { type: Number, min: 0 },
    kidsAges:     [{ type: String }],

    // ── Step 6: Lifestyle ──────────────────────────────────────────────────
    drink: {
      type: String,
      enum: ['never', 'socially', 'occasionally', 'regularly'],
    },
    smoke: {
      type: String,
      enum: ['never', 'occasionally', 'regularly', 'quitting'],
    },

    // ── Step 7: Religion ───────────────────────────────────────────────────
    religion: { type: String },

    // ── Step 8: About ──────────────────────────────────────────────────────
    bio:       { type: String, maxlength: 500 },
    height:    { type: Number, min: 100, max: 250 }, // in cm
    interests: [{ type: String }],
    profession:{ type: String, trim: true },

    // ── Step 9: Media ──────────────────────────────────────────────────────
    profilePicture: { type: String, default: null },
    photos: {
      type: [String],
      validate: { validator: (a) => a.length <= 6, message: 'Max 6 photos' },
    },
    introVideo: { type: String, default: null },

    // ── Verification ───────────────────────────────────────────────────────
    isEmailVerified: { type: Boolean, default: false },
    isPhoneVerified: { type: Boolean, default: false },
    isVerified:      { type: Boolean, default: false },

    // ── OTP ────────────────────────────────────────────────────────────────
    otp:        { type: String,  select: false },
    otpExpires: { type: Date,    select: false },

    // ── Password reset ─────────────────────────────────────────────────────
    resetPasswordToken:   { type: String, select: false },
    resetPasswordExpires: { type: Date,   select: false },

    // ── Account status ─────────────────────────────────────────────────────
    isActive:        { type: Boolean, default: true },
    isBanned:        { type: Boolean, default: false },
    isProfileHidden: { type: Boolean, default: false },
    lastSeen:        { type: Date,    default: Date.now },
    role:            { type: String,  enum: ['user', 'admin'], default: 'user' },
  },
  { timestamps: true }
);

// ── Virtual: age ──────────────────────────────────────────────────────────────
userSchema.virtual('age').get(function () {
  if (!this.dateOfBirth) return null;
  return Math.floor((Date.now() - new Date(this.dateOfBirth)) / (365.25 * 24 * 60 * 60 * 1000));
});

// ── Hash password ─────────────────────────────────────────────────────────────
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;       // just return
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  // no next() needed — Mongoose awaits the promise automatically
});



// userSchema.pre('save', async function (next) {
//   if (!this.isModified('password')) return next();
//   const salt = await bcrypt.genSalt(12);
//   this.password = await bcrypt.hash(this.password, salt);
//   next();
// });

userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.isOtpValid = function (otp) {
  return this.otp === otp && this.otpExpires > Date.now();
};

module.exports = mongoose.model('User', userSchema);