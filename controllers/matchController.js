const { Like, Match } = require('../models/Match');
const User = require('../models/User');
const { sendPushNotification } = require('../utils/pushNotification');

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

    // Blocking is one-directional in storage but blocks interaction both ways
    const iBlockedThem = (req.user.blockedUsers || []).some((id) => id.toString() === receiverId);
    const theyBlockedMe = (receiver.blockedUsers || []).some((id) => id.toString() === senderId.toString());
    if (iBlockedThem || theyBlockedMe) {
      return res.status(403).json({ success: false, message: 'You cannot interact with this user.' });
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

        // ── Notify both users of the new match (all of each user's devices) ─
        const [userA, userB] = await Promise.all([
          User.findById(senderId).select('name pushTokens'),
          User.findById(receiverId).select('name pushTokens'),
        ]);
        if (userB?.pushTokens?.length) {
          sendPushNotification(
            userB.pushTokens,
            "It's a Match! 💕",
            `You and ${userA.name.split(' ')[0]} have liked each other. Say hello!`,
            { type: 'match', matchId: match._id.toString() }
          );
        }
        if (userA?.pushTokens?.length) {
          sendPushNotification(
            userA.pushTokens,
            "It's a Match! 💕",
            `You and ${userB.name.split(' ')[0]} have liked each other. Say hello!`,
            { type: 'match', matchId: match._id.toString() }
          );
        }
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
    // Previously unpaginated — a user with hundreds of matches got them all
    // in one response. Defaults to a generous limit so existing callers
    // (which don't pass page/limit yet) aren't surprised by a small page.
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip  = (page - 1) * limit;

    const filter = { users: { $in: [req.user._id] }, isActive: true };

    const [matches, total] = await Promise.all([
      Match.find(filter)
        .populate('users', 'name profilePicture photos city country profession isOnline lastSeen isVerified')
        .sort({ matchedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Match.countDocuments(filter),
    ]);

    // Format: return the OTHER user's info alongside match id
    const formatted = matches
      .map((match) => {
        const otherUser = match.users.find(
          (u) => u._id?.toString() !== req.user._id.toString()
        );
        return { matchId: match._id, matchedAt: match.matchedAt, user: otherUser };
      })
      .filter((m) => m.user != null); // defensive — shouldn't trigger now that deletion anonymizes rather than removing the User doc

    console.log(`✅ [GetMatches] Found ${formatted.length} matches for ${req.user._id} (page ${page})`);
    res.status(200).json({
      success: true,
      matches: formatted,
      page,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + matches.length < total,
    });
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
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip  = (page - 1) * limit;

    const filter = { receiver: req.user._id, isPassed: { $ne: true } };

    const [likes, total] = await Promise.all([
      Like.find(filter)
        .populate('sender', 'name profilePicture city country profession isVerified')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Like.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      likes,
      count: likes.length, // kept for backward compat — count of THIS page, not total
      page,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + likes.length < total,
    });
  } catch (error) {
    console.error('❌ [GetLikes] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/matches/likes/:likeId
// Dismiss / remove a like from your received list
// ─────────────────────────────────────────────────────────────────────────────
exports.removeLike = async (req, res) => {
  try {
    const like = await Like.findOne({ _id: req.params.likeId, receiver: req.user._id });
    if (!like) return res.status(404).json({ success: false, message: 'Like not found.' });

    await like.deleteOne();
    res.status(200).json({ success: true, message: 'Like removed.' });
  } catch (error) {
    console.error('❌ [RemoveLike] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};