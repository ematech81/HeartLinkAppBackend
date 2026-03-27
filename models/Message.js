const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    sender:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    matchId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Match' },
    content:  { type: String, required: true, maxlength: 2000, trim: true },
    type:     { type: String, enum: ['text', 'image', 'voice'], default: 'text' },
    isRead:   { type: Boolean, default: false },
    readAt:   { type: Date, default: null },
    isDeleted:{ type: Boolean, default: false },
  },
  { timestamps: true }
);

// Index for fast conversation queries
messageSchema.index({ sender: 1, receiver: 1, createdAt: -1 });
messageSchema.index({ receiver: 1, isRead: 1 });

module.exports = mongoose.model('Message', messageSchema);