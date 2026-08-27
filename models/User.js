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
    // Only required for local (email/phone + password) accounts. This was
    // unconditionally `required: true` before, which meant every first-time
    // Google sign-up (googleAuth's User.create with no password field) threw
    // a ValidationError and failed outright — Google sign-up was completely
    // broken for new users until this fix (2026-08-24).
    password: {
      type: String,
      required: [function () { return this.authProvider === 'local'; }, 'Password is required'],
      minlength: 8,
      select: false,
    },

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

    location: {
      type:        { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] }, // [longitude, latitude]
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
    isEmailVerified:   { type: Boolean, default: false },
    isPhoneVerified:   { type: Boolean, default: false },
    isVerified:        { type: Boolean, default: false },

    // ── Social auth ────────────────────────────────────────────────────────
    authProvider:      { type: String, enum: ['local', 'google'], default: 'local' },
    googleId:          { type: String, default: null },
    isProfileComplete: { type: Boolean, default: true }, // false for new Google sign-in users

    // ── Consent ─────────────────────────────────────────────────────────────
    // Server-stamped (never trust a client-supplied timestamp) the moment the
    // user's "agreedToTerms: true" is accepted, either at registration or at
    // Google-onboarding profile completion. Presence of a value here is the
    // durable proof-of-consent record the audit flagged as missing.
    agreedToTermsAt: { type: Date, default: null },

    // ── OTP (phone login/verification) ─────────────────────────────────────
    otp:        { type: String,  select: false },
    otpExpires: { type: Date,    select: false },

    // ── Email verification OTP ──────────────────────────────────────────────
    // Deliberately separate from otp/otpExpires above — most registrations
    // collect both an email and a phone, so a single shared pair of fields
    // would let a pending phone-OTP request silently clobber a pending
    // email-verification code (or vice versa) if both were ever in flight
    // at once.
    emailOtp:        { type: String, select: false },
    emailOtpExpires: { type: Date,   select: false },

    // ── Password reset ─────────────────────────────────────────────────────
    resetPasswordToken:   { type: String, select: false },
    resetPasswordExpires: { type: Date,   select: false },

    // ── Push notifications ─────────────────────────────────────────────────
    // `pushToken` (singular) is deprecated — kept only so existing documents
    // aren't touched by this migration; nothing reads or writes it anymore.
    // `pushTokens` supports multiple simultaneous devices per account (e.g.
    // a phone and a tablet, or reinstalling without the old token being
    // evicted) — every active user re-registers on next app open (see
    // registerForPushNotifications, called on every authenticated launch),
    // so no manual data migration is needed for existing accounts.
    pushToken:  { type: String, default: null }, // deprecated — do not use in new code
    pushTokens: [{ type: String }],

    // ── Subscription ───────────────────────────────────────────────────────────
    isSubscribed:       { type: Boolean, default: false },
    subscriptionExpiry: { type: Date,    default: null  },
    subscriptionPlan:   { type: String,  enum: ['monthly', 'sixMonth'], default: null },

    // ── Boost ──────────────────────────────────────────────────────────────────
    isBoosted:   { type: Boolean, default: false },
    boostExpiry: { type: Date,    default: null  },

    // ── Account status ─────────────────────────────────────────────────────
    isActive:        { type: Boolean, default: true },
    isBanned:        { type: Boolean, default: false },
    isProfileHidden: { type: Boolean, default: false },
    lastSeen:        { type: Date,    default: Date.now },
    role:            { type: String,  enum: ['user', 'admin'], default: 'user' },

    // ── Account deletion ────────────────────────────────────────────────────
    // Deletion is implemented as anonymization, not a hard document delete —
    // the User document is kept (as a scrubbed stub) so Messages/Matches/
    // Likes/Reports that reference this id via populate() keep resolving
    // instead of leaving dangling references. isActive is also set false on
    // deletion, which is what actually blocks login/protect/socket auth —
    // isDeleted/deletedAt exist for admin visibility and to distinguish
    // "user deleted their own account" from "banned"/"deactivated".
    // See userController.anonymizeUser.
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date,    default: null  },

    // ── Blocking ────────────────────────────────────────────────────────────
    // Users this account has blocked. One-directional by design (A blocking B
    // doesn't imply B blocked A) — enforcement everywhere checks both
    // "did I block them" and "did they block me" by querying this field from
    // both sides. See userController.blockUser/unblockUser.
    blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
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



userSchema.methods.comparePassword = async function (candidate) {
  // Google-only accounts have no password hash — bcrypt.compare would throw
  // on a non-hash string instead of just returning false, which surfaced as
  // a 500 (instead of a clean 401) if a Google user ever tried the
  // email/password login form. Treat "no password set" as "never matches".
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.isOtpValid = function (otp) {
  return this.otp === otp && this.otpExpires > Date.now();
};

userSchema.methods.isEmailOtpValid = function (otp) {
  return this.emailOtp === otp && this.emailOtpExpires > Date.now();
};



// ── Indexes ───────────────────────────────────────────────────────────────────
userSchema.index({ location: '2dsphere' });
userSchema.index({ blockedUsers: 1 }); // fast "who has blocked me" reverse lookup


module.exports = mongoose.model('User', userSchema);