const { Like, Match } = require('../models/Match');
const User = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/matches/like/:userId
// Like or super-like a user. Returns match if mutual.
// ─────────────────────────────────────────────────────────────────────────────
exports.likeUser = async (req, res) => {
  try {
    const senderId   = req.user._id;
    const receiverId = req.params.userId;
    const isSuperLike = req.body.isSuperLike || false;

    if (senderId.toString() === receiverId) {
      return res.status(400).json({ success: false, message: 'Cannot like yourself.' });
    }

    // Check receiver exists
    const receiver = await User.findById(receiverId);
    if (!receiver) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Upsert like (avoid duplicate)
    await Like.findOneAndUpdate(
      { sender: senderId, receiver: receiverId },
      { sender: senderId, receiver: receiverId, isSuperLike },
      { upsert: true, new: true }
    );

    console.log(`💕 [Like] ${senderId} liked ${receiverId} (super: ${isSuperLike})`);

    // Check for mutual like
    const mutualLike = await Like.findOne({ sender: receiverId, receiver: senderId });

    let match = null;
    if (mutualLike) {
      // Check if match already exists
      const existing = await Match.findOne({
        users: { $all: [senderId, receiverId] },
        isActive: true,
      });

      if (!existing) {
        match = await Match.create({ users: [senderId, receiverId] });
        match = await match.populate('users', 'name profilePicture photos city country profession');
        console.log(`🎉 [Match] New match: ${senderId} ↔ ${receiverId}`);
      } else {
        match = existing;
      }
    }

    res.status(200).json({
      success: true,
      liked: true,
      isSuperLike,
      match: match
        ? {
            _id:   match._id,
            users: match.users,
          }
        : null,
    });
  } catch (error) {
    console.error('❌ [LikeUser] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/matches/pass/:userId
// Pass (dislike) a user — records so they don't show again
// ─────────────────────────────────────────────────────────────────────────────
exports.passUser = async (req, res) => {
  try {
    const senderId   = req.user._id;
    const receiverId = req.params.userId;

    // Re-use the Like model with a "pass" flag to track who was skipped
    await Like.findOneAndUpdate(
      { sender: senderId, receiver: receiverId },
      { sender: senderId, receiver: receiverId, isPassed: true },
      { upsert: true }
    );

    console.log(`👎 [Pass] ${senderId} passed ${receiverId}`);
    res.status(200).json({ success: true, passed: true });
  } catch (error) {
    console.error('❌ [PassUser] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/matches
// Get all matches for current user
// ─────────────────────────────────────────────────────────────────────────────
exports.getMatches = async (req, res) => {
  try {
    const matches = await Match.find({
      users:    { $in: [req.user._id] },
      isActive: true,
    })
      .populate('users', 'name profilePicture photos city country profession isOnline lastSeen isVerified')
      .sort({ matchedAt: -1 })
      .lean();

    // Format: return the OTHER user's info alongside match id
    const formatted = matches.map((match) => {
      const otherUser = match.users.find(
        (u) => u._id.toString() !== req.user._id.toString()
      );
      return {
        matchId:   match._id,
        matchedAt: match.matchedAt,
        user:      otherUser,
      };
    });

    console.log(`✅ [GetMatches] Found ${formatted.length} matches for ${req.user._id}`);
    res.status(200).json({ success: true, matches: formatted });
  } catch (error) {
    console.error('❌ [GetMatches] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/matches/:matchId
// Unmatch a user
// ─────────────────────────────────────────────────────────────────────────────
exports.unmatch = async (req, res) => {
  try {
    const match = await Match.findOne({
      _id:   req.params.matchId,
      users: { $in: [req.user._id] },
    });

    if (!match) {
      return res.status(404).json({ success: false, message: 'Match not found.' });
    }

    match.isActive = false;
    await match.save();

    console.log(`💔 [Unmatch] Match ${req.params.matchId} deactivated`);
    res.status(200).json({ success: true, message: 'Unmatched successfully.' });
  } catch (error) {
    console.error('❌ [Unmatch] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/matches/likes
// Get users who liked the current user (premium feature preview)
// ─────────────────────────────────────────────────────────────────────────────
exports.getLikes = async (req, res) => {
  try {
    const likes = await Like.find({ receiver: req.user._id, isPassed: { $ne: true } })
      .populate('sender', 'name profilePicture city country profession isVerified')
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({ success: true, likes, count: likes.length });
  } catch (error) {
    console.error('❌ [GetLikes] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};