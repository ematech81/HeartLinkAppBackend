const mongoose = require('mongoose');

// ── Like Schema ───────────────────────────────────────────────────────────────
const likeSchema = new mongoose.Schema(
  {
    sender:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    isSuperLike: { type: Boolean, default: false },
    isPassed: { type: Boolean, default: false },
  },
  { timestamps: true }
);
likeSchema.index({ sender: 1, receiver: 1 }, { unique: true });

// ── Match Schema ──────────────────────────────────────────────────────────────
const matchSchema = new mongoose.Schema(
  {
    users:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    isActive:  { type: Boolean, default: true },
    matchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = {
  Like:  mongoose.model('Like',  likeSchema),
  Match: mongoose.model('Match', matchSchema),
};