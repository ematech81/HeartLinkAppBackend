const express = require('express');
const router  = express.Router();
const {
  searchUsers,
  getUserById,
  updateProfile,
  blockUser,
  unblockUser,
  getBlockedUsers,
  reportUser,
  savePushToken,
  removePushToken,
  deleteMe,
  getMessagingPinStatus,
  setMessagingPin,
  verifyMessagingPin,
  resetMessagingPin,
} = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');
const { pinLimiter } = require('../middleware/rateLimiter');

// NOTE: /blocked, /me, and /messaging-pin* must be registered before the
// /:id catch-all route below, otherwise Express would match them as an :id param.
router.get('/search',        protect, searchUsers);
router.get('/blocked',       protect, getBlockedUsers);
router.delete('/me',         protect, deleteMe); // self-service account deletion
router.put('/push-token',    protect, savePushToken);
router.delete('/push-token', protect, removePushToken); // deregister on logout
router.put('/profile',       protect, updateProfile);

// ── Messaging PIN (Premium-only chat lock) ──────────────────────────────────
router.get('/messaging-pin/status', protect,             getMessagingPinStatus);
router.post('/messaging-pin',       protect,              setMessagingPin);
router.post('/messaging-pin/verify',protect, pinLimiter,  verifyMessagingPin);
router.post('/messaging-pin/reset', protect, pinLimiter,  resetMessagingPin);

router.get('/:id',           protect, getUserById);
router.post('/:id/block',    protect, blockUser);
router.delete('/:id/block',  protect, unblockUser);
router.post('/:id/report',   protect, reportUser);

module.exports = router;