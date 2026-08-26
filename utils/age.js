/**
 * Shared age calculation — used wherever a dateOfBirth needs the 18+ check
 * enforced server-side (registration, and profile updates that touch
 * dateOfBirth, e.g. Google-onboarding profile completion).
 *
 * Previously this rule only existed in the mobile app's form validator
 * (heartlink-app/src/screens/auth/RegistrationScreen.js) — trivially
 * bypassed by calling the API directly. Mirrors the same 365.25-day-year
 * approximation the client uses so client/server never disagree right at
 * the 18th-birthday boundary.
 */
function calculateAge(dateOfBirth) {
  return Math.floor((Date.now() - new Date(dateOfBirth)) / (365.25 * 24 * 60 * 60 * 1000));
}

const MIN_AGE = 18;

/**
 * Returns an error message string if dateOfBirth fails validation, or null
 * if it's valid. Doesn't throw — callers decide how to respond.
 */
function validateMinAge(dateOfBirth) {
  if (!dateOfBirth || isNaN(new Date(dateOfBirth).getTime())) {
    return 'A valid date of birth is required.';
  }
  const age = calculateAge(dateOfBirth);
  if (age < MIN_AGE) return `You must be at least ${MIN_AGE} years old to use HeartLink.`;
  if (age > 100)     return 'Enter a valid date of birth.';
  return null;
}

module.exports = { calculateAge, validateMinAge, MIN_AGE };
