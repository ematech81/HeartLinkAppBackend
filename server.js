const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const dotenv     = require('dotenv');
const jwt        = require('jsonwebtoken');
const mongoose   = require('mongoose');
const connectDB  = require('./config/db');
const User       = require('./models/User');

dotenv.config();
connectDB();

// ── Run a startup task only once Mongo is actually connected ─────────────────
// Both cron jobs below used to fire on a flat timer (or immediately) with no
// regard for whether connectDB() had actually finished yet — on a cold boot,
// or any time Atlas connect is slow, they'd race ahead of it, throwing
// "buffering timed out" (queries queued with nowhere to go) instead of
// running cleanly a few seconds later. mongoose.connection is a singleton,
// so this doesn't open a second connection — it just waits on the same one
// config/db.js already establishes.
const runWhenDbReady = (fn) => {
  if (mongoose.connection.readyState === 1) fn();
  else mongoose.connection.once('connected', fn);
};

// ── Daily expiry check (runs every 6 hours) ───────────────────────────────────
const { runExpiryCheck } = require('./controllers/paymentController');
const runDailyExpiry = async () => {
  try {
    const fakeReq = {};
    // status() must be chainable (return the mock itself) — runExpiryCheck's
    // own catch block calls res.status(500).json(...), and a mock missing
    // .status() turned every real error inside it into a second, misleading
    // "res.status is not a function" TypeError that masked the actual cause.
    const fakeRes = {
      status: () => fakeRes,
      json:   (d) => console.log('⏰ [Cron] Expiry result:', d),
    };
    await runExpiryCheck(fakeReq, fakeRes);
  } catch (err) {
    console.error('❌ [Cron] Expiry check failed:', err.message);
  }
};
// Run once on startup (as soon as Mongo is ready, not a guessed delay), then every 6 hours
runWhenDbReady(runDailyExpiry);
setInterval(runDailyExpiry, 6 * 60 * 60 * 1000);

const app    = express();
const server = http.createServer(app);

// Trust the first hop (Railway's edge proxy) so req.ip reflects the real
// client IP instead of the proxy's. Required for express-rate-limit to key
// limits per-client rather than lumping every user together — and without
// it, express-rate-limit v8 refuses requests that carry an X-Forwarded-For
// header at all once a limiter is mounted.
app.set('trust proxy', 1);

// ── Socket.io ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin:  process.env.NODE_ENV === 'development' ? '*' : process.env.CLIENT_URL,
    methods: ['GET', 'POST'],
  },
  pingTimeout:  60000,
  pingInterval: 25000,
});

// Make io accessible in controllers
app.set('io', io);

// ── Track online users ────────────────────────────────────────────────────────
const onlineUsers = new Map(); // userId → socketId

// ── Socket auth middleware ──────────────────────────────────────────────────
// Every connection MUST present the same JWT issued by /api/auth/*. Without
// this, any client could `emit('user:join', someoneElseId)` and receive that
// person's messages / send messages under their name — there was previously
// NO verification at all that a connecting socket owned the userId it claimed.
// The client sends the token via `io(url, { auth: { token } })`.
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required.'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('isBanned isActive isDeleted');
    if (!user)            return next(new Error('User no longer exists.'));
    if (user.isBanned)    return next(new Error('Account suspended.'));
    if (user.isDeleted)   return next(new Error('Account deleted.'));
    if (!user.isActive)   return next(new Error('Account inactive.'));

    // Identity is now bound to the socket itself — nothing emitted by the
    // client can override who this connection is allowed to act as.
    socket.userId = decoded.id;
    next();
  } catch (err) {
    next(new Error('Invalid or expired token.'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.userId; // authenticated identity — trust this, not client payloads
  console.log(`🔌 Socket connected: ${socket.id} (user ${userId})`);

  // ── Mark online + join personal room ──────────────────────────────────────
  onlineUsers.set(userId, socket.id);
  socket.join(userId);
  console.log(`✅ [Socket] ${userId} online (${onlineUsers.size} total)`);
  socket.broadcast.emit('user:online', { userId });

  // Kept as a no-op for backward compatibility with clients still emitting it
  // on reconnect — joining/marking-online now happens automatically above,
  // driven by the verified token, not by whatever userId the client sends.
  socket.on('user:join', () => {});

  // ── Join a chat room ───────────────────────────────────────────────────────
  socket.on('chat:join', ({ otherUserId }) => {
    if (!otherUserId) return;
    const roomId = getRoomId(userId, otherUserId);
    socket.join(roomId);
    console.log(`💬 [Socket] ${userId} joined room ${roomId}`);
  });

  // ── Send message ───────────────────────────────────────────────────────────
  socket.on('message:send', async (data) => {
    const { receiverId, message, tempId } = data || {};
    if (!receiverId || !message) return;

    // Mirror the block check the REST endpoint enforces (messageController.
    // sendMessage) — without this, a blocked user's message would still
    // flash live in the recipient's chat even though it can never be
    // persisted, which is a confusing and unsafe inconsistency.
    const [me, them] = await Promise.all([
      User.findById(userId).select('blockedUsers'),
      User.findById(receiverId).select('blockedUsers'),
    ]);
    const isBlocked =
      (me?.blockedUsers   || []).some((id) => id.toString() === receiverId) ||
      (them?.blockedUsers || []).some((id) => id.toString() === userId);
    if (isBlocked) return;

    const roomId = getRoomId(userId, receiverId);
    const payload = {
      _id:       tempId || Date.now().toString(),
      content:   message,
      sender:    userId,
      receiver:  receiverId,
      createdAt: new Date().toISOString(),
      isRead:    false,
    };

    // Emit to both users in the room
    io.to(roomId).emit('message:receive', payload);

    // Also notify receiver's personal room (for MessagesScreen badge update)
    io.to(receiverId).emit('conversation:update', {
      senderId:    userId,
      lastMessage: message,
      timestamp:   payload.createdAt,
    });

    console.log(`📨 [Socket] ${userId} → ${receiverId}: "${message.substring(0, 30)}"`);
  });

  // ── Typing indicators ──────────────────────────────────────────────────────
  socket.on('typing:start', ({ receiverId } = {}) => {
    if (!receiverId) return;
    socket.to(getRoomId(userId, receiverId)).emit('typing:start', { senderId: userId });
  });

  socket.on('typing:stop', ({ receiverId } = {}) => {
    if (!receiverId) return;
    socket.to(getRoomId(userId, receiverId)).emit('typing:stop', { senderId: userId });
  });

  // ── Mark messages as read ──────────────────────────────────────────────────
  socket.on('message:read', ({ senderId } = {}) => {
    if (!senderId) return;
    socket.to(senderId).emit('message:read', { readerId: userId });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (onlineUsers.get(userId) === socket.id) {
      onlineUsers.delete(userId);
      socket.broadcast.emit('user:offline', { userId });
      console.log(`❌ [Socket] ${userId} offline`);
    }
  });
});

// ── Helper: consistent room ID for two users ──────────────────────────────────
function getRoomId(userId1, userId2) {
  return [userId1, userId2].sort().join('_');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin:  process.env.NODE_ENV === 'development' ? '*' : process.env.CLIENT_URL,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
// NOTE: the old Flutterwave webhook needed a raw-body pre-parse here (its
// hash covers the exact raw bytes). KoraPay's signature instead covers
// JSON.stringify(req.body.data) — the PARSED data object — confirmed
// against KoraPay's own docs, so the webhook route (routes/webhookRoutes.js)
// works fine on top of normal express.json() below; no special mount needed.

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({ success: true, message: 'HeartLink API is running', onlineUsers: onlineUsers.size })
);

// ── Routes ────────────────────────────────────────────────────────────────────
const authRoutes      = require('./routes/authRoutes');
const userRoutes      = require('./routes/userRoutes');
const matchRoutes     = require('./routes/matchRoutes');
const messageRoutes   = require('./routes/messageRoutes');
const uploadRoutes    = require('./routes/uploadRoutes');
const paymentRoutes   = require('./routes/paymentRoutes');
const webhookRoutes   = require('./routes/webhookRoutes');
const communityRoutes = require('./routes/communityRoutes');
const adminRoutes     = require('./routes/adminRoutes');

app.use('/api/auth',      authRoutes);
app.use('/api/users',     userRoutes);
app.use('/api/matches',   matchRoutes);
app.use('/api/messages',  messageRoutes);
app.use('/api/upload',    uploadRoutes);
app.use('/api/payment',   paymentRoutes);
app.use('/api/webhooks',  webhookRoutes); // POST /api/webhooks/korapay — see routes/webhookRoutes.js
app.use('/api/community', communityRoutes);
app.use('/api/admin',     adminRoutes);

// Cleanup expired community posts every hour
const { cleanupExpiredPosts } = require('./controllers/communityController');
setInterval(cleanupExpiredPosts, 60 * 60 * 1000);
runWhenDbReady(cleanupExpiredPosts); // run once on startup, once Mongo is ready

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found.` });
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 HeartLink server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
  console.log(`🔌 Socket.io ready`);
});