const express = require('express');
const router  = express.Router();
const {
  searchUsers,
  getUserById,
  updateProfile,
  blockUser,
  reportUser,
} = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');

router.get('/search',      protect, searchUsers);
router.get('/:id',         protect, getUserById);
router.put('/profile',     protect, updateProfile);
router.post('/:id/block',  protect, blockUser);
router.post('/:id/report', protect, reportUser);

module.exports = router;