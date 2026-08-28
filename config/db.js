const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      // Default is 30s if unset — LONGER than the mobile app's own 15s
      // request timeout (see ApiServices.js axios instance). That mismatch
      // means every time Atlas connectivity hiccups, the client always
      // gives up first with a generic "Network Error", while the server
      // silently keeps trying for another 15+ seconds behind the scenes —
      // and may still complete the write during that window, leaving a
      // real account/record behind that the client never learns about
      // (the exact "ghost success" pattern already hit during registration
      // testing). Failing server-side well inside the client's timeout
      // means a real hiccup now surfaces as an actual error response
      // instead of a silent race the client always loses.
      serverSelectionTimeoutMS: 8000,
      // Guards individual operations after the initial connection succeeds
      // (a query/write that stalls mid-flight, not just initial connect).
      socketTimeoutMS: 12000,
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);

    // Visibility for future connectivity hiccups — the actual root cause
    // (network instability between this machine and Atlas) isn't something
    // code can fix, but knowing exactly when a drop/recovery happened makes
    // it possible to correlate against "was this in-flight during a
    // specific failed request" instead of guessing from a bare error line.
    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️  MongoDB disconnected — attempting to reconnect...');
    });
    mongoose.connection.on('reconnected', () => {
      console.log('✅ MongoDB reconnected');
    });
    mongoose.connection.on('error', (err) => {
      console.error(`❌ MongoDB connection error: ${err.message}`);
    });
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
