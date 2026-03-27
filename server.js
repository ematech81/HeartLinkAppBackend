const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
require('dotenv').config();

const connectDB = require('./config/db');
const authRoutes  = require('./routes/authRoutes');
const userRoutes  = require('./routes/userRoutes');
const matchRoutes = require('./routes/matchRoutes');
const messageRoutes = require('./routes/messageRoutes');

// ── Connect to MongoDB ────────────────────────────────────────────────────────
connectDB();

const app = express();

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

// Stricter limiter for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many attempts. Please wait 15 minutes.' },
});

app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Logging (dev only) ────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',    authRoutes);
app.use('/api/users',   userRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/messages', messageRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'HeartLink API is running',
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found.` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message || 'Internal server error.',
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 HeartLink server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
});





// const express = require('express');
// const cors = require('cors');
// const helmet = require('helmet');
// const rateLimit = require('express-rate-limit');
// const morgan = require('morgan');
// require('dotenv').config();

// const connectDB = require('./config/Db');
// const authRoutes = require('./routes/AuthRoutes');
// const userRoutes  = require('./routes/userRoutes');
// const matchRoutes = require('./routes/matchRoutes');
 
// // ── Connect to MongoDB ────────────────────────────────────────────────────────
// connectDB();
 
// const app = express();
 
// // ── Security middleware ───────────────────────────────────────────────────────
// app.use(helmet());
// app.use(cors({
//   origin: process.env.CLIENT_URL || '*',
//   methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
//   allowedHeaders: ['Content-Type', 'Authorization'],
// }));
 
// // ── Rate limiting ─────────────────────────────────────────────────────────────
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100,
//   message: { success: false, message: 'Too many requests. Please try again later.' },
// });
 
// // Stricter limiter for auth routes
// const authLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 20,
//   message: { success: false, message: 'Too many attempts. Please wait 15 minutes.' },
// });
 
// app.use('/api/', limiter);
// app.use('/api/auth/', authLimiter);
 
// // ── Body parsing ──────────────────────────────────────────────────────────────
// app.use(express.json({ limit: '10mb' }));
// app.use(express.urlencoded({ extended: true, limit: '10mb' }));
 
// // ── Logging (dev only) ────────────────────────────────────────────────────────
// if (process.env.NODE_ENV === 'development') {
//   app.use(morgan('dev'));
// }
 
// // ── Routes ────────────────────────────────────────────────────────────────────
// app.use('/api/auth',    authRoutes);
// app.use('/api/users',   userRoutes);
// app.use('/api/matches', matchRoutes);
 
// // ── Health check ──────────────────────────────────────────────────────────────
// app.get('/health', (req, res) => {
//   res.status(200).json({
//     success: true,
//     message: 'HeartLink API is running',
//     environment: process.env.NODE_ENV,
//     timestamp: new Date().toISOString(),
//   });
// });
 
// // ── 404 handler ───────────────────────────────────────────────────────────────
// app.use((req, res) => {
//   res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found.` });
// });
 
// // ── Global error handler ──────────────────────────────────────────────────────
// app.use((err, req, res, next) => {
//   console.error('Unhandled error:', err);
//   res.status(err.statusCode || 500).json({
//     success: false,
//     message: err.message || 'Internal server error.',
//   });
// });
 
// // ── Start server ──────────────────────────────────────────────────────────────
// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => {
//   console.log(`🚀 HeartLink server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
// });