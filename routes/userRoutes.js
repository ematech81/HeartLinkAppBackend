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
} = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');

// NOTE: /blocked and /me must be registered before the /:id catch-all route
// below, otherwise Express would match them as an :id param.
router.get('/search',        protect, searchUsers);
router.get('/blocked',       protect, getBlockedUsers);
router.delete('/me',         protect, deleteMe); // self-service account deletion
router.put('/push-token',    protect, savePushToken);
router.delete('/push-token', protect, removePushToken); // deregister on logout
router.put('/profile',       protect, updateProfile);
router.get('/:id',           protect, getUserById);
router.post('/:id/block',    protect, blockUser);
router.delete('/:id/block',  protect, unblockUser);
router.post('/:id/report',   protect, reportUser);

module.exports = router;