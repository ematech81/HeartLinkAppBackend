const express = require('express');
const router  = express.Router();
const { adminProtect } = require('../middleware/adminMiddleware');
const {
  getStats,
  getUserGrowth,
  getAnalytics,
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
  getCommunityPosts,
  deletePost,
  featurePost,
  getReports,
  handleReport,
  getSubscriptions,
  updateSubscription,
  broadcastNotification,
  getMatchesOverview,
} = require('../controllers/adminController');

// All routes require admin JWT
router.use(adminProtect);

// ── Stats & Analytics ─────────────────────────────────────────────────────────
router.get('/stats',              getStats);
router.get('/analytics/growth',   getUserGrowth);
router.get('/analytics',          getAnalytics);
router.get('/matches',            getMatchesOverview);

// ── Users ─────────────────────────────────────────────────────────────────────
router.get('/users',              getUsers);
router.get('/users/:id',          getUserById);
router.patch('/users/:id',        updateUser);
router.delete('/users/:id',       deleteUser);

// ── Community ─────────────────────────────────────────────────────────────────
router.get('/community',          getCommunityPosts);
router.delete('/community/:id',   deletePost);
router.patch('/community/:id/feature', featurePost);

// ── Reports ───────────────────────────────────────────────────────────────────
router.get('/reports',            getReports);
router.patch('/reports/:id',      handleReport);

// ── Subscriptions ─────────────────────────────────────────────────────────────
router.get('/subscriptions',      getSubscriptions);
router.patch('/subscriptions/:id', updateSubscription);

// ── Broadcast ─────────────────────────────────────────────────────────────────
router.post('/broadcast',         broadcastNotification);

module.exports = router;
