const express    = require('express');
const router     = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl       = require('../controllers/communityController');

router.get('/feed',                   protect, ctrl.getFeed);
router.post('/posts',                 protect, ctrl.createPost);
router.post('/posts/:id/like',        protect, ctrl.toggleLike);
router.post('/posts/:id/view',        protect, ctrl.recordView);
router.delete('/posts/:id',           protect, ctrl.deletePost);
router.get('/posts/mine',             protect, ctrl.getMyPosts);
router.get('/posts/user/:userId',     protect, ctrl.getUserPosts);

module.exports = router;
