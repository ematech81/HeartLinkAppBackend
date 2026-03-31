const express = require('express');
const router  = express.Router();
const {
  searchUsers,
  getUserById,
  updateProfile,
  blockUser,
  reportUser,
  savePushToken,
} = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');

router.get('/search',        protect, searchUsers);
router.put('/push-token',    protect, savePushToken);
router.put('/profile',       protect, updateProfile);
router.get('/:id',           protect, getUserById);
router.post('/:id/block',    protect, blockUser);
router.post('/:id/report',   protect, reportUser);

module.exports = router;