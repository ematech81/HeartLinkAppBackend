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
    }).populate('users', 'name profilePicture photos isOnline lastSeen isVerified city country');

    // For each match, get the last message + unread count
    const conversations = await Promise.all(
      matches.map(async (match) => {
        const otherUser = match.users.find(
          (u) => u._id.toString() !== userId.toString()
        );

        // Last message between these two users
        const lastMessage = await Message.findOne({
          $or: [
            { sender: userId,     receiver: otherUser._id },
            { sender: otherUser._id, receiver: userId },
          ],
          isDeleted: false,
        })
          .sort({ createdAt: -1 })
          .lean();

        // Unread count — messages sent TO current user that are unread
        const unreadCount = await Message.countDocuments({
          sender:   otherUser._id,
          receiver: userId,
          isRead:   false,
          isDeleted: false,
        });

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
    );

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
    const reqUser = await User.findById(currentUserId).select('isSubscribed subscriptionExpiry');
    const isSubscribed = reqUser?.isSubscribed && (!reqUser.subscriptionExpiry || reqUser.subscriptionExpiry > new Date());

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
    const senderUser  = await User.findById(senderId).select('isSubscribed subscriptionExpiry');
    const isSubscribed = senderUser?.isSubscribed && (!senderUser.subscriptionExpiry || senderUser.subscriptionExpiry > new Date());

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

    // ── Push notification to receiver if they have a token ────────────────
    if (receiver.pushToken) {
      const sender = await User.findById(senderId).select('name');
      const preview = content.length > 60 ? content.substring(0, 60) + '…' : content;
      sendPushNotification(
        receiver.pushToken,
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