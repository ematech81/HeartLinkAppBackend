const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const dotenv     = require('dotenv');
const connectDB  = require('./config/db');

dotenv.config();
connectDB();

// ── Daily expiry check (runs every 6 hours) ───────────────────────────────────
const { runExpiryCheck } = require('./controllers/paymentController');
const runDailyExpiry = async () => {
  try {
    const fakeReq = {};
    const fakeRes = { json: (d) => console.log('⏰ [Cron] Expiry result:', d) };
    await runExpiryCheck(fakeReq, fakeRes);
  } catch (err) {
    console.error('❌ [Cron] Expiry check failed:', err.message);
  }
};
// Run once on startup, then every 6 hours
setTimeout(runDailyExpiry, 5000);
setInterval(runDailyExpiry, 6 * 60 * 60 * 1000);

const app    = express();
const server = http.createServer(app);

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

io.on('connection', (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  // ── User joins — mark online ───────────────────────────────────────────────
  socket.on('user:join', (userId) => {
    if (!userId) return;
    onlineUsers.set(userId, socket.id);
    socket.join(userId); // join personal room
    console.log(`✅ [Socket] ${userId} online (${onlineUsers.size} total)`);

    // Broadcast online status to others
    socket.broadcast.emit('user:online', { userId });
  });

  // ── Join a chat room ───────────────────────────────────────────────────────
  socket.on('chat:join', ({ userId, otherUserId }) => {
    const roomId = getRoomId(userId, otherUserId);
    socket.join(roomId);
    console.log(`💬 [Socket] ${userId} joined room ${roomId}`);
  });

  // ── Send message ───────────────────────────────────────────────────────────
  socket.on('message:send', (data) => {
    const { senderId, receiverId, message, tempId } = data;
    if (!senderId || !receiverId || !message) return;

    const roomId = getRoomId(senderId, receiverId);
    const payload = {
      _id:       tempId || Date.now().toString(),
      content:   message,
      sender:    senderId,
      receiver:  receiverId,
      createdAt: new Date().toISOString(),
      isRead:    false,
    };

    // Emit to both users in the room
    io.to(roomId).emit('message:receive', payload);

    // Also notify receiver's personal room (for MessagesScreen badge update)
    io.to(receiverId).emit('conversation:update', {
      senderId,
      lastMessage: message,
      timestamp:   payload.createdAt,
    });

    console.log(`📨 [Socket] ${senderId} → ${receiverId}: "${message.substring(0, 30)}"`);
  });

  // ── Typing indicators ──────────────────────────────────────────────────────
  socket.on('typing:start', ({ senderId, receiverId }) => {
    socket.to(getRoomId(senderId, receiverId)).emit('typing:start', { senderId });
  });

  socket.on('typing:stop', ({ senderId, receiverId }) => {
    socket.to(getRoomId(senderId, receiverId)).emit('typing:stop', { senderId });
  });

  // ── Mark messages as read ──────────────────────────────────────────────────
  socket.on('message:read', ({ readerId, senderId }) => {
    socket.to(senderId).emit('message:read', { readerId });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    // Find and remove the disconnected user
    for (const [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(userId);
        socket.broadcast.emit('user:offline', { userId });
        console.log(`❌ [Socket] ${userId} offline`);
        break;
      }
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
// Paystack webhook needs the raw body for HMAC verification — mount BEFORE json()
app.use('/api/payment/webhook', express.raw({ type: 'application/json' }), (req, _res, next) => {
  // Parse back to object so the handler can use req.body normally
  if (Buffer.isBuffer(req.body)) req.body = JSON.parse(req.body.toString());
  next();
});

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
const communityRoutes = require('./routes/communityRoutes');

app.use('/api/auth',      authRoutes);
app.use('/api/users',     userRoutes);
app.use('/api/matches',   matchRoutes);
app.use('/api/messages',  messageRoutes);
app.use('/api/upload',    uploadRoutes);
app.use('/api/payment',   paymentRoutes);
app.use('/api/community', communityRoutes);

// Cleanup expired community posts every hour
const { cleanupExpiredPosts } = require('./controllers/communityController');
setInterval(cleanupExpiredPosts, 60 * 60 * 1000);
cleanupExpiredPosts(); // run once on startup

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