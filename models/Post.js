const mongoose = require('mongoose');

const postSchema = new mongoose.Schema(
  {
    author: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true,
    },
    mediaUrl:  { type: String, required: true },
    mediaType: { type: String, enum: ['video', 'image'], required: true },
    caption:   { type: String, trim: true, maxlength: 300, default: '' },
    prompt:    { type: String, trim: true, default: '' },
    expiresAt: { type: Date, required: true, index: true },
    likes: [
      {
        user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    viewCount: { type: Number, default: 0 },
    isActive:  { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

// Compound index for feed query: active, not expired, sorted by recency
postSchema.index({ isActive: 1, expiresAt: 1, createdAt: -1 });
postSchema.index({ author: 1, expiresAt: 1 });

module.exports = mongoose.model('Post', postSchema);
