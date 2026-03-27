const express = require('express');
const router  = express.Router();
const {
  getConversations,
  getMessages,
  sendMessage,
  markAsRead,
  deleteMessage,
  getUnreadCount,
} = require('../controllers/messageController');
const { protect } = require('../middleware/authMiddleware');

// All routes require authentication
router.get('/conversations',          protect, getConversations);
router.get('/unread/count',           protect, getUnreadCount);
router.get('/:userId',                protect, getMessages);
router.post('/:receiverId',           protect, sendMessage);
router.patch('/:messageId/read',      protect, markAsRead);
router.delete('/:messageId',          protect, deleteMessage);

module.exports = router;