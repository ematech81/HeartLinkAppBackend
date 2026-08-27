const mongoose = require('mongoose');

/**
 * Tracks a KoraPay checkout attempt, keyed by `checkoutReference` — the
 * value sent to KoraPay as the transaction reference (format:
 * `{PREFIX}-{uuid_v4}`, e.g. `HRT-...`). Per the shared webhook router's
 * contract, this reference is an opaque random UUID (never the app's own
 * User _id), so both the webhook handler and the manual-verify endpoint
 * look the payer up by this field, not by _id.
 *
 * Didn't exist before this migration — the old Flutterwave flow generated
 * a tx_ref on the fly and never persisted it, so there was no payment
 * history at all, just the User document's current subscription state.
 */
const transactionSchema = new mongoose.Schema(
  {
    user:              { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    checkoutReference: { type: String, required: true, unique: true },
    plan:              { type: String, enum: ['monthly', 'sixMonth', 'boost'], required: true },
    amount:            { type: Number, required: true },
    currency:          { type: String, default: 'NGN' },
    // 'pending' → 'success' is the only transition that should ever trigger
    // plan activation — see the atomic findOneAndUpdate guard in
    // paymentController's korapayWebhook/verifyPayment, which uses
    // { status: { $ne: 'success' } } so a duplicate webhook delivery (the
    // router retries up to 3x, and KoraPay itself retries for 72h) can
    // never double-extend a subscription.
    status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending', index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Transaction', transactionSchema);
