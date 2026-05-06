const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reported: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type:     { type: String, enum: ['user', 'post'], default: 'user' },
    postId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Post', default: null },
    reason: {
      type: String,
      enum: ['inappropriate_content', 'harassment', 'fake_profile', 'spam', 'other'],
      required: true,
    },
    description: { type: String, maxlength: 500 },
    status: {
      type: String,
      enum: ['pending', 'reviewed', 'actioned', 'ignored'],
      default: 'pending',
    },
    adminNote:  { type: String },
    actionTaken:{ type: String, enum: ['none', 'warned', 'suspended', 'banned', 'deleted'], default: 'none' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Report', reportSchema);
