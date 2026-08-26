const Message = require('../models/Message');
const { Match } = require('../models/Match');
const User = require('../models/User');
const { sendPushNotification } = require('../utils/pushNotification');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/messages/conversations
// Returns the latest message per match, sorted by most recent
// ─────────────────────────────────────────────────────────────────────────────
exports.getConversations = async (req, res) => {
  try {
    const userId = req.user._id;

    // Get all active matches for this user
    const matches = await Match.find({
      users: { $in: [userId] },
      isActive: true,
    })
      .populate('users', 'name profilePicture photos isOnline lastSeen isVerified city country')
      .lean();

    if (matches.length === 0) {
      return res.status(200).json({ success: true, conversations: [] });
    }

    const otherUserByMatchId = new Map();
    const otherUserIds = [];
    for (const match of matches) {
      const otherUser = match.users.find((u) => u._id.toString() !== userId.toString());
      if (!otherUser) continue; // shouldn't happen now that deletion anonymizes rather than removing the User doc, but stay defensive
      otherUserByMatchId.set(match._id.toString(), otherUser);
      otherUserIds.push(otherUser._id);
    }

    // Previously this ran 2 queries PER match (last message + unread count)
    // — for a user with N matches that's 2N+1 round-trips on a screen that
    // loads every time MessagesScreen opens. One aggregation now computes
    // both, grouped by conversation partner, in a single round-trip.
    const perPartner = await Message.aggregate([
      {
        $match: {
          isDeleted: false,
          $or: [
            { sender: userId, receiver: { $in: otherUserIds } },
            { receiver: userId, sender: { $in: otherUserIds } },
          ],
        },
      },
      { $addFields: { otherParty: { $cond: [{ $eq: ['$sender', userId] }, '$receiver', '$sender'] } } },
      { $sort: { createdAt: -1 } }, // must precede $group so $first below is the most recent
      {
        $group: {
          _id:         '$otherParty',
          lastMessage: { $first: '$$ROOT' },
          unreadCount: {
            $sum: {
              $cond: [{ $and: [{ $eq: ['$receiver', userId] }, { $eq: ['$isRead', false] }] }, 1, 0],
            },
          },
        },
      },
    ]);
    const byOtherParty = new Map(perPartner.map((p) => [p._id.toString(), p]));

    const conversations = matches
      .map((match) => {
        const otherUser = otherUserByMatchId.get(match._id.toString());
        if (!otherUser) return null;

        const agg         = byOtherParty.get(otherUser._id.toString());
        const lastMessage = agg?.lastMessage;
        const unreadCount = agg?.unreadCount || 0;

        return {
          matchId:   match._id,
          user:      otherUser,
          lastMessage: lastMessage
            ? {
                content:   lastMessage.content,
                createdAt: lastMessage.createdAt,
                isRead:    lastMessage.isRead,
                isMine:    lastMessage.sender.toString() === userId.toString(),
                type:      lastMessage.type,
              }
            : null,
          unreadCount,
          isActive: unreadCount > 0,
        };
      })
      .filter(Boolean);

    // Sort: conversations with messages first, then by recency
    conversations.sort((a, b) => {
      const aTime = a.lastMessage?.createdAt || 0;
      const bTime = b.lastMessage?.createdAt || 0;
      return new Date(bTime) - new Date(aTime);
    });

    console.log(`✅ [Conversations] Found ${conversations.length} for ${userId}`);
    res.status(200).json({ success: true, conversations });

  } catch (error) {
    console.error('❌ [Conversations] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/messages/:userId
// Get paginated messages between current user and another user
// ─────────────────────────────────────────────────────────────────────────────
exports.getMessages = async (req, res) => {
  try {
    const currentUserId = req.user._id;
    const otherUserId   = req.params.userId;
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 30;

    // Subscribed users can view messages with anyone (Community direct-message feature)
    const [reqUser, otherUser] = await Promise.all([
      User.findById(currentUserId).select('isSubscribed subscriptionExpiry blockedUsers'),
      User.findById(otherUserId).select('blockedUsers'),
    ]);
    const isSubscribed = reqUser?.isSubscribed && (!reqUser.subscriptionExpiry || reqUser.subscriptionExpiry > new Date());

    // Block check runs regardless of subscription status — the "message
    // anyone" premium perk must never let a subscriber read/send around a
    // block in either direction.
    const isBlocked =
      (reqUser?.blockedUsers   || []).some((id) => id.toString() === otherUserId) ||
      (otherUser?.blockedUsers || []).some((id) => id.toString() === currentUserId.toString());
    if (isBlocked) {
      return res.status(403).json({ success: false, message: 'Unable to load this conversation.' });
    }

    const match = await Match.findOne({
      users:    { $all: [currentUserId, otherUserId] },
      isActive: true,
    });

    if (!match && !isSubscribed) {
      return res.status(403).json({
        success: false,
        message: 'You must be matched to view messages.',
      });
    }

    const total = await Message.countDocuments({
      $or: [
        { sender: currentUserId, receiver: otherUserId },
        { sender: otherUserId,   receiver: currentUserId },
      ],
      isDeleted: false,
    });

    const messages = await Message.find({
      $or: [
        { sender: currentUserId, receiver: otherUserId },
        { sender: otherUserId,   receiver: currentUserId },
      ],
      isDeleted: false,
    })
      .sort({ createdAt: -1 }) // newest first for pagination
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Reverse so oldest is first (chat display order)
    const ordered = messages.reverse();

    // Mark unread messages as read
    await Message.updateMany(
      { sender: otherUserId, receiver: currentUserId, isRead: false },
      { isRead: true, readAt: new Date() }
    );

    console.log(`✅ [GetMessages] ${ordered.length} messages between ${currentUserId} and ${otherUserId}`);

    res.status(200).json({
      success: true,
      messages: ordered,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      hasMore: page * limit < total,
    });

  } catch (error) {
    console.error('❌ [GetMessages] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/messages/:receiverId
// Send a message — matched users, OR subscribed users (Community direct-message)
// ─────────────────────────────────────────────────────────────────────────────
exports.sendMessage = async (req, res) => {
  try {
    const senderId   = req.user._id;
    const receiverId = req.params.receiverId;
    const { content, type = 'text' } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, message: 'Message content is required.' });
    }

    // Verify receiver exists
    const receiver = await User.findById(receiverId);
    if (!receiver) {
      return res.status(404).json({ success: false, message: 'Receiver not found.' });
    }

    // Subscribed users can message anyone (Community direct-message is a paid feature)
    const senderUser  = await User.findById(senderId).select('isSubscribed subscriptionExpiry blockedUsers');
    const isSubscribed = senderUser?.isSubscribed && (!senderUser.subscriptionExpiry || senderUser.subscriptionExpiry > new Date());

    // Block check runs regardless of subscription status — see getMessages
    // for why this can't be skipped for premium "message anyone" users.
    const isBlocked =
      (senderUser?.blockedUsers || []).some((id) => id.toString() === receiverId) ||
      (receiver.blockedUsers    || []).some((id) => id.toString() === senderId.toString());
    if (isBlocked) {
      return res.status(403).json({ success: false, message: 'Unable to send message to this user.' });
    }

    const match = await Match.findOne({
      users:    { $all: [senderId, receiverId] },
      isActive: true,
    });

    if (!match && !isSubscribed) {
      return res.status(403).json({
        success: false,
        message: 'You must be matched to send messages.',
      });
    }

    // Create message (matchId is optional — absent when messaging via Community)
    const message = await Message.create({
      sender:   senderId,
      receiver: receiverId,
      ...(match ? { matchId: match._id } : {}),
      content:  content.trim(),
      type,
    });

    console.log(`✅ [SendMessage] ${senderId} → ${receiverId}: "${content.substring(0, 30)}..."`);

    // ── Push notification to all of the receiver's registered devices ─────
    if (receiver.pushTokens?.length) {
      const sender = await User.findById(senderId).select('name');
      const preview = content.length > 60 ? content.substring(0, 60) + '…' : content;
      sendPushNotification(
        receiver.pushTokens,
        sender.name.split(' ')[0],
        preview,
        { type: 'message', senderId: senderId.toString() }
      );
    }

    res.status(201).json({ success: true, message });

  } catch (error) {
    console.error('❌ [SendMessage] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/messages/:messageId/read
// Mark a single message as read
// ─────────────────────────────────────────────────────────────────────────────
exports.markAsRead = async (req, res) => {
  try {
    const message = await Message.findOneAndUpdate(
      { _id: req.params.messageId, receiver: req.user._id },
      { isRead: true, readAt: new Date() },
      { new: true }
    );

    if (!message) {
      return res.status(404).json({ success: false, message: 'Message not found.' });
    }

    res.status(200).json({ success: true, message });

  } catch (error) {
    console.error('❌ [MarkRead] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/messages/:messageId
// Soft delete a message (only sender can delete)
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteMessage = async (req, res) => {
  try {
    const message = await Message.findOneAndUpdate(
      { _id: req.params.messageId, sender: req.user._id },
      { isDeleted: true },
      { new: true }
    );

    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found or you are not the sender.',
      });
    }

    res.status(200).json({ success: true, message: 'Message deleted.' });

  } catch (error) {
    console.error('❌ [DeleteMessage] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/messages/unread/count
// Get total unread message count for the current user (for badge)
// ─────────────────────────────────────────────────────────────────────────────
exports.getUnreadCount = async (req, res) => {
  try {
    const count = await Message.countDocuments({
      receiver:  req.user._id,
      isRead:    false,
      isDeleted: false,
    });

    res.status(200).json({ success: true, count });

  } catch (error) {
    console.error('❌ [UnreadCount] Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};