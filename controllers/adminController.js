const axios   = require('axios');
const User    = require('../models/User');
const Post    = require('../models/Post');
const Report  = require('../models/Report');
const Message = require('../models/Message');

// Safely import Match models (file exports { Like, Match })
let Like, MatchModel;
try {
  const m = require('../models/Match');
  Like       = m.Like  || m;
  MatchModel = m.Match || m;
} catch (_) {}

// ── Overview Stats ────────────────────────────────────────────────────────────
exports.getStats = async (req, res) => {
  try {
    const now     = new Date();
    const dayAgo  = new Date(now - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now - 7  * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      activeToday,
      newThisWeek,
      totalMatches,
      totalMessages,
      postsToday,
      boostedUsers,
      subscribedUsers,
      pendingReports,
      bannedUsers,
    ] = await Promise.all([
      User.countDocuments({ role: 'user' }),
      User.countDocuments({ role: 'user', lastSeen: { $gte: dayAgo } }),
      User.countDocuments({ role: 'user', createdAt: { $gte: weekAgo } }),
      MatchModel ? MatchModel.countDocuments() : 0,
      Message.countDocuments(),
      Post.countDocuments({ createdAt: { $gte: dayAgo } }),
      User.countDocuments({ role: 'user', isBoosted: true }),
      User.countDocuments({ role: 'user', isSubscribed: true }),
      Report.countDocuments({ status: 'pending' }),
      User.countDocuments({ role: 'user', isBanned: true }),
    ]);

    res.json({
      totalUsers, activeToday, newThisWeek, totalMatches,
      totalMessages, postsToday, boostedUsers, subscribedUsers,
      pendingReports, bannedUsers,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── User growth (last 30 days, by day) ───────────────────────────────────────
exports.getUserGrowth = async (req, res) => {
  try {
    const days  = parseInt(req.query.days) || 30;
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const data = await User.aggregate([
      { $match: { createdAt: { $gte: start }, role: 'user' } },
      {
        $group: {
          _id:   { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { date: '$_id', count: 1, _id: 0 } },
    ]);

    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Analytics ─────────────────────────────────────────────────────────────────
exports.getAnalytics = async (req, res) => {
  try {
    const now      = new Date();
    const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const [genderDist, subscriptionDist, locationDist, postActivity] = await Promise.all([
      User.aggregate([
        { $match: { role: 'user' } },
        { $group: { _id: '$gender', count: { $sum: 1 } } },
      ]),
      User.aggregate([
        { $match: { role: 'user' } },
        {
          $group: {
            _id: {
              $cond: [
                '$isSubscribed', 'subscribed',
                { $cond: ['$isBoosted', 'boosted', 'free'] },
              ],
            },
            count: { $sum: 1 },
          },
        },
      ]),
      User.aggregate([
        { $match: { role: 'user', city: { $ne: null } } },
        { $group: { _id: '$city', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
        { $project: { city: '$_id', count: 1, _id: 0 } },
      ]),
      Post.aggregate([
        { $match: { createdAt: { $gte: monthAgo } } },
        {
          $group: {
            _id:   { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            posts: { $sum: 1 },
            likes: { $sum: { $size: { $ifNull: ['$likes', []] } } },
            views: { $sum: { $ifNull: ['$viewCount', 0] } },
          },
        },
        { $sort: { _id: 1 } },
        { $project: { date: '$_id', posts: 1, likes: 1, views: 1, _id: 0 } },
      ]),
    ]);

    const totalUsers       = await User.countDocuments({ role: 'user' });
    const subscribedCount  = await User.countDocuments({ role: 'user', isSubscribed: true });
    const conversionRate   = totalUsers ? ((subscribedCount / totalUsers) * 100).toFixed(1) : 0;

    res.json({ genderDist, subscriptionDist, locationDist, postActivity, conversionRate });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Users ─────────────────────────────────────────────────────────────────────
exports.getUsers = async (req, res) => {
  try {
    const {
      page   = 1,
      limit  = 20,
      search = '',
      status,       // 'active' | 'banned'
      plan,         // 'free' | 'subscribed' | 'boosted'
      gender,
      sort   = '-createdAt',
    } = req.query;

    const filter = { role: 'user' };

    if (search) {
      filter.$or = [
        { name:  { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }
    if (status === 'active')  filter.isBanned = false;
    if (status === 'banned')  filter.isBanned = true;
    if (plan === 'subscribed') filter.isSubscribed = true;
    if (plan === 'boosted')   filter.isBoosted = true;
    if (plan === 'free')      { filter.isSubscribed = false; filter.isBoosted = false; }
    if (gender)               filter.gender = gender;

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await User.countDocuments(filter);

    const users = await User.find(filter)
      .select('-password -otp -otpExpires -resetPasswordToken -resetPasswordExpires')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      users,
      total,
      page:       parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password -otp -otpExpires -resetPasswordToken -resetPasswordExpires');
    if (!user) return res.status(404).json({ message: 'User not found' });

    const [matchCount, messageCount, postCount, reportCount] = await Promise.all([
      MatchModel ? MatchModel.countDocuments({ users: req.params.id }) : 0,
      Message.countDocuments({ $or: [{ sender: req.params.id }, { receiver: req.params.id }] }),
      Post.countDocuments({ author: req.params.id }),
      Report.countDocuments({ reported: req.params.id }),
    ]);

    res.json({ user, stats: { matchCount, messageCount, postCount, reportCount } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const allowed = [
      'isBanned', 'isActive', 'isSubscribed', 'subscriptionPlan',
      'subscriptionExpiry', 'isBoosted', 'boostExpiry', 'role', 'isVerified',
    ];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true })
      .select('-password -otp -otpExpires -resetPasswordToken -resetPasswordExpires');

    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User updated', user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Community Posts ───────────────────────────────────────────────────────────
exports.getCommunityPosts = async (req, res) => {
  try {
    const {
      page  = 1,
      limit = 20,
      sort  = '-createdAt',  // 'trending' = -likes length, 'recent' = -createdAt
      search = '',
    } = req.query;

    const filter = {};
    if (search) filter.caption = { $regex: search, $options: 'i' };

    const sortMap = {
      recent:   '-createdAt',
      trending: '-viewCount',
      liked:    '-likeCount',
    };
    const sortStr = sortMap[sort] || sort;

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Post.countDocuments(filter);

    const posts = await Post.find(filter)
      .populate('author', 'name profilePicture email')
      .sort(sortStr)
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      posts,
      total,
      page:       parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.deletePost = async (req, res) => {
  try {
    const post = await Post.findByIdAndDelete(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });
    res.json({ message: 'Post deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.featurePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });
    post.isFeatured = !post.isFeatured;
    await post.save();
    res.json({ message: `Post ${post.isFeatured ? 'featured' : 'unfeatured'}`, post });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Reports ───────────────────────────────────────────────────────────────────
exports.getReports = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;

    const filter = {};
    if (status) filter.status = status;

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Report.countDocuments(filter);

    const reports = await Report.find(filter)
      .populate('reporter', 'name email profilePicture')
      .populate('reported', 'name email profilePicture isBanned')
      .sort('-createdAt')
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      reports,
      total,
      page:       parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.handleReport = async (req, res) => {
  try {
    const { status, adminNote, actionTaken } = req.body;
    const report = await Report.findById(req.params.id);
    if (!report) return res.status(404).json({ message: 'Report not found' });

    report.status      = status      || report.status;
    report.adminNote   = adminNote   || report.adminNote;
    report.actionTaken = actionTaken || report.actionTaken;
    await report.save();

    // Apply action to the reported user
    if (actionTaken === 'banned') {
      await User.findByIdAndUpdate(report.reported, { isBanned: true, isActive: false });
    } else if (actionTaken === 'suspended') {
      await User.findByIdAndUpdate(report.reported, { isActive: false });
    }

    res.json({ message: 'Report handled', report });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Subscriptions ─────────────────────────────────────────────────────────────
exports.getSubscriptions = async (req, res) => {
  try {
    const { page = 1, limit = 20, plan } = req.query;

    const filter = { role: 'user', $or: [{ isSubscribed: true }, { isBoosted: true }] };
    if (plan) filter.subscriptionPlan = plan;

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await User.countDocuments(filter);

    const users = await User.find(filter)
      .select('name email profilePicture isSubscribed subscriptionPlan subscriptionExpiry isBoosted boostExpiry createdAt')
      .sort('-createdAt')
      .skip(skip)
      .limit(parseInt(limit));

    // Revenue estimate (simple — based on plan counts)
    const [monthly, yearly] = await Promise.all([
      User.countDocuments({ role: 'user', isSubscribed: true, subscriptionPlan: 'monthly' }),
      User.countDocuments({ role: 'user', isSubscribed: true, subscriptionPlan: 'yearly' }),
    ]);
    const estimatedMonthlyRevenue = (monthly * 2500) + (yearly * 18000 / 12);

    res.json({
      users,
      total,
      page:       parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      revenue: { monthly, yearly, estimatedMonthlyRevenue },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateSubscription = async (req, res) => {
  try {
    const { isSubscribed, subscriptionPlan, subscriptionExpiry, isBoosted, boostExpiry } = req.body;
    const update = {};
    if (isSubscribed  !== undefined) update.isSubscribed      = isSubscribed;
    if (subscriptionPlan)            update.subscriptionPlan  = subscriptionPlan;
    if (subscriptionExpiry)          update.subscriptionExpiry = new Date(subscriptionExpiry);
    if (isBoosted     !== undefined) update.isBoosted         = isBoosted;
    if (boostExpiry)                 update.boostExpiry        = new Date(boostExpiry);

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true })
      .select('name email isSubscribed subscriptionPlan subscriptionExpiry isBoosted boostExpiry');

    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'Subscription updated', user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Broadcast Notification ────────────────────────────────────────────────────
exports.broadcastNotification = async (req, res) => {
  try {
    const { target = 'all', title, body: notifBody, type = 'push' } = req.body;
    if (!title || !notifBody) return res.status(400).json({ message: 'title and body are required' });

    let filter = { pushToken: { $ne: null }, isActive: true, isBanned: false };
    if (target === 'boosted')  { filter.isBoosted    = true; }
    if (target === 'premium')  { filter.isSubscribed = true; }
    if (target === 'inactive') {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      filter.lastSeen = { $lt: weekAgo };
    }

    const users  = await User.find(filter).select('pushToken');
    const tokens = users.map(u => u.pushToken).filter(Boolean);

    if (tokens.length === 0) return res.json({ message: 'No devices to notify', sent: 0 });

    // Batch into chunks of 100 (Expo limit)
    const chunkSize = 100;
    let sent = 0;
    for (let i = 0; i < tokens.length; i += chunkSize) {
      const chunk    = tokens.slice(i, i + chunkSize);
      const messages = chunk.map(token => ({
        to: token, title, body: notifBody, sound: 'default',
      }));
      try {
        await axios.post('https://exp.host/--/api/v2/push/send', messages, {
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        });
        sent += chunk.length;
      } catch (e) {
        console.error('Push batch error:', e.message);
      }
    }

    res.json({ message: `Notification sent to ${sent} devices`, sent, total: tokens.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Matches overview ──────────────────────────────────────────────────────────
exports.getMatchesOverview = async (req, res) => {
  try {
    const totalMatches = MatchModel ? await MatchModel.countDocuments() : 0;
    const totalLikes   = Like       ? await Like.countDocuments()       : 0;

    const now     = new Date();
    const dayAgo  = new Date(now - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const recentMatches = MatchModel
      ? await MatchModel.countDocuments({ createdAt: { $gte: weekAgo } })
      : 0;
    const recentMessages = await Message.countDocuments({ createdAt: { $gte: dayAgo } });

    res.json({ totalMatches, totalLikes, recentMatches, recentMessages });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
