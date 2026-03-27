const express = require('express');
const router  = express.Router();
const {
  likeUser,
  passUser,
  getMatches,
  unmatch,
  getLikes,
} = require('../controllers/matchController');
const { protect } = require('../middleware/authMiddleware');

router.post('/like/:userId',    protect, likeUser);
router.post('/pass/:userId',    protect, passUser);
router.get('/',                 protect, getMatches);
router.get('/likes',            protect, getLikes);
router.delete('/:matchId',      protect, unmatch);

module.exports = router;