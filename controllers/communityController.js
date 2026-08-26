const Post = require('../models/Post');
const User = require('../models/User');

const POST_EXPIRY_HOURS = 24;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/community/posts
// Create a new post. Only boosted users are allowed.
// ─────────────────────────────────────────────────────────────────────────────
exports.createPost = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('isSubscribed subscriptionExpiry isBoosted boostExpiry');

    const isSubscribed = user.isSubscribed && (!user.subscriptionExpiry || user.subscriptionExpiry > new Date());
    const isBoosted    = user.isBoosted    && user.boostExpiry > new Date();

    if (!isSubscribed && !isBoosted) {
      return res.status(403).json({
        success: false,
        message: 'Subscribe to HeartLink Premium to post in the Community.',
        requiresSubscription: true,
      });
    }

    const { mediaUrl, mediaType, caption, prompt } = req.body;
    if (!mediaUrl || !mediaType) {
      return res.status(400).json({ success: false, message: 'mediaUrl and mediaType are required.' });
    }
    if (!['video', 'image'].includes(mediaType)) {
      return res.status(400).json({ success: false, message: 'mediaType must be "video" or "image".' });
    }

    const expiresAt = new Date(Date.now() + POST_EXPIRY_HOURS * 60 * 60 * 1000);

    const post = await Post.create({
      author: req.user._id,
      mediaUrl,
      mediaType,
      caption:   caption  || '',
      prompt:    prompt   || '',
      expiresAt,
    });

    const populated = await post.populate('author', 'name profilePicture city country isVerified isBoosted');

    console.log(`✅ [Community] Post created by ${req.user._id}, expires ${expiresAt.toISOString()}`);
    res.status(201).json({ success: true, post: populated });
  } catch (err) {
    console.error('❌ [Community] createPost:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create post.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/community/feed?page=1&limit=10
// Smart feed: nearby users first → similar interests → recent posts
// ─────────────────────────────────────────────────────────────────────────────
exports.getFeed = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(20, parseInt(req.query.limit) || 10);
    const skip  = (page - 1) * limit;
    const now   = new Date();

    // Get current user for smart ranking
    const me = await User.findById(req.user._id).select('country interests');

    const filter = {
      isActive:  true,
      expiresAt: { $gt: now },
      // own posts included — frontend renders them with owner UI (analytics bar, delete)
    };

    const posts = await Post.find(filter)
      .populate('author', 'name profilePicture city country isVerified isBoosted')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Smart-rank: same country first, then shared interests, then rest
    const ranked = posts.sort((a, b) => {
      const aScore = smartScore(a, me);
      const bScore = smartScore(b, me);
      return bScore - aScore;
    });

    // Add isLiked flag for current user
    const result = ranked.map((p) => ({
      ...p,
      likeCount: p.likes?.length || 0,
      isLiked:   p.likes?.some((l) => l.user?.toString() === req.user._id.toString()) || false,
      timeLeft:  Math.max(0, p.expiresAt - now), // ms remaining
    }));

    const total = await Post.countDocuments(filter);

    res.status(200).json({
      success: true,
      posts:   result,
      page,
      total,
      hasMore: skip + posts.length < total,
    });
  } catch (err) {
    console.error('❌ [Community] getFeed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch feed.' });
  }
};

function smartScore(post, me) {
  let score = 0;
  if (me?.country && post.author?.country === me.country) score += 10;
  if (me?.interests?.length && post.author?.interests?.length) {
    const shared = post.author.interests.filter((i) => me.interests.includes(i));
    score += shared.length * 3;
  }
  // Recency bonus: posts under 6 hours get +5
  const ageHours = (Date.now() - new Date(post.createdAt)) / 3600000;
  if (ageHours < 6) score += 5;
  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/community/posts/:id/like
// Toggle like on a post
// ─────────────────────────────────────────────────────────────────────────────
exports.toggleLike = async (req, res) => {
  try {
    const post = await Post.findOne({
      _id:      req.params.id,
      isActive:  true,
      expiresAt: { $gt: new Date() },
    });

    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found or expired.' });
    }

    const userId   = req.user._id.toString();
    const likeIdx  = post.likes.findIndex((l) => l.user?.toString() === userId);
    const isLiked  = likeIdx === -1;

    if (isLiked) {
      post.likes.push({ user: req.user._id });
    } else {
      post.likes.splice(likeIdx, 1);
    }
    await post.save();

    res.status(200).json({
      success:   true,
      isLiked,
      likeCount: post.likes.length,
    });
  } catch (err) {
    console.error('❌ [Community] toggleLike:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update like.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/community/posts/:id/view
// Increment view count (called when post becomes visible in feed)
// ─────────────────────────────────────────────────────────────────────────────
exports.recordView = async (req, res) => {
  try {
    await Post.findByIdAndUpdate(req.params.id, { $inc: { viewCount: 1 } });
    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/community/posts/:id
// Delete own post
// ─────────────────────────────────────────────────────────────────────────────
exports.deletePost = async (req, res) => {
  try {
    const post = await Post.findOne({ _id: req.params.id, author: req.user._id });
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found.' });
    }
    await post.deleteOne();
    res.status(200).json({ success: true, message: 'Post deleted.' });
  } catch (err) {
    console.error('❌ [Community] deletePost:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete post.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/community/posts/mine
// Get current user's own posts (for profile page)
// ─────────────────────────────────────────────────────────────────────────────
exports.getMyPosts = async (req, res) => {
  try {
    const now   = new Date();
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip  = (page - 1) * limit;

    const filter = { author: req.user._id, expiresAt: { $gt: now } };

    const [posts, total] = await Promise.all([
      Post.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Post.countDocuments(filter),
    ]);

    const result = posts.map((p) => ({
      ...p,
      likeCount: p.likes?.length || 0,
      timeLeft:  Math.max(0, p.expiresAt - now),
    }));

    res.status(200).json({
      success: true,
      posts: result,
      page,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + posts.length < total,
    });
  } catch (err) {
    console.error('❌ [Community] getMyPosts:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch posts.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/community/posts/user/:userId
// Get another user's active posts (shown on their profile)
// ─────────────────────────────────────────────────────────────────────────────
exports.getUserPosts = async (req, res) => {
  try {
    const now   = new Date();
    const posts = await Post.find({
      author:    req.params.userId,
      isActive:  true,
      expiresAt: { $gt: now },
    })
      .sort({ createdAt: -1 })
      .lean();

    const result = posts.map((p) => ({
      ...p,
      likeCount: p.likes?.length || 0,
      isLiked:   p.likes?.some((l) => l.user?.toString() === req.user._id.toString()) || false,
      timeLeft:  Math.max(0, p.expiresAt - now),
    }));

    res.status(200).json({ success: true, posts: result });
  } catch (err) {
    console.error('❌ [Community] getUserPosts:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch posts.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup job — call periodically to mark expired posts as inactive
// ─────────────────────────────────────────────────────────────────────────────
exports.cleanupExpiredPosts = async () => {
  try {
    const result = await Post.updateMany(
      { isActive: true, expiresAt: { $lte: new Date() } },
      { $set: { isActive: false } }
    );
    if (result.modifiedCount > 0) {
      console.log(`🧹 [Community] Marked ${result.modifiedCount} expired posts as inactive`);
    }
  } catch (err) {
    console.error('❌ [Community] cleanup error:', err.message);
  }
};
