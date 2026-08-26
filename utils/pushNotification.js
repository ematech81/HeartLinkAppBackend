/**
 * HeartLink — Push Notification Utility
 * Sends Expo push notifications via the Expo Push API.
 *
 * Expo's push API is two-phase: sendPushNotificationsAsync returns TICKETS,
 * which only confirm Expo *accepted* the push for delivery — they do not
 * mean it was delivered. A dead/uninstalled token surfaces later as a
 * DeviceNotRegistered error on a separate RECEIPT fetch
 * (getPushNotificationReceiptsAsync), typically minutes after sending.
 * This queues every accepted ticket and sweeps for receipts periodically,
 * clearing the token off whichever user owns it once Expo confirms it's dead.
 *
 * Multi-device: `pushToken` accepts either a single token string or an
 * array of tokens (a user's `pushTokens` field) — every user-facing
 * notification (new match, new message, etc.) now reaches all of a user's
 * registered devices, not just whichever one last overwrote a single field.
 */

const { Expo } = require('expo-server-sdk');
const User = require('../models/User');

const expo = new Expo();

// { ticketId, pushToken }[] — populated by every send, drained by sweepReceipts.
const pendingReceipts = [];

/**
 * Send a push notification to one user's device(s).
 * @param {string|string[]} pushTokenOrTokens - Expo push token(s) (ExponentPushToken[...])
 * @param {string} title  - Notification title
 * @param {string} body   - Notification body text
 * @param {object} data   - Extra data for navigation (type, userId, etc.)
 */
const sendPushNotification = async (pushTokenOrTokens, title, body, data = {}) => {
  const tokens = (Array.isArray(pushTokenOrTokens) ? pushTokenOrTokens : [pushTokenOrTokens])
    .filter((t) => t && Expo.isExpoPushToken(t));

  if (tokens.length === 0) {
    console.log(`⚠️ [Push] No valid token(s): ${JSON.stringify(pushTokenOrTokens)}`);
    return;
  }

  try {
    const messages = tokens.map((to) => ({
      to, sound: 'default', title, body, data, priority: 'high', badge: 1,
    }));

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      // Expo guarantees tickets come back in the same order as the messages
      // in the chunk it was given, so index-pairing back to the token is safe.
      tickets.forEach((ticket, i) => {
        const pushToken = chunk[i].to;
        if (ticket.status === 'error') {
          console.error('❌ [Push] Ticket error:', ticket.message);
          // Rare, but Expo can reject a token as dead immediately rather
          // than waiting for the receipt phase — handle both paths.
          if (ticket.details?.error === 'DeviceNotRegistered') {
            clearDeadToken(pushToken).catch(() => {});
          }
          return;
        }
        if (ticket.id) pendingReceipts.push({ ticketId: ticket.id, pushToken });
      });
    }

    console.log(`📲 [Push] Sent "${title}" → ${tokens.length} device(s)`);
  } catch (err) {
    console.error('❌ [Push] Failed to send notification:', err.message);
  }
};

// ── Clear a dead token off whichever user currently owns it ────────────────
// Matches by token value rather than a passed-in userId, since by the time a
// receipt comes back (minutes later) the caller's userId reference is long
// gone — the token itself is still the right lookup key. $pull rather than a
// $set:null, since a user can have several tokens and only this one device
// is dead.
const clearDeadToken = async (pushToken) => {
  const result = await User.updateOne({ pushTokens: pushToken }, { $pull: { pushTokens: pushToken } });
  if (result.modifiedCount > 0) {
    console.log(`🧹 [Push] Cleared dead token: ${pushToken.substring(0, 30)}...`);
  }
};

// ── Periodic receipt sweep ──────────────────────────────────────────────────
// Resolves queued tickets against Expo's receipt API and clears any token
// Expo reports as DeviceNotRegistered. Runs every 30 minutes — Expo
// recommends waiting at least several minutes after sending before a
// receipt is ready, so this isn't checked synchronously per-send.
const sweepReceipts = async () => {
  if (pendingReceipts.length === 0) return;

  const batch = pendingReceipts.splice(0, pendingReceipts.length);
  const idChunks = expo.chunkPushNotificationReceiptIds(batch.map((b) => b.ticketId));

  for (const chunk of idChunks) {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk);
      for (const [ticketId, receipt] of Object.entries(receipts)) {
        if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
          const entry = batch.find((b) => b.ticketId === ticketId);
          if (entry) await clearDeadToken(entry.pushToken).catch(() => {});
        } else if (receipt.status === 'error') {
          console.error('❌ [Push] Receipt error:', receipt.message);
        }
      }
    } catch (err) {
      console.error('❌ [Push] Receipt sweep error:', err.message);
    }
  }
};

setInterval(sweepReceipts, 30 * 60 * 1000).unref(); // don't hold the process open for this alone

module.exports = { sendPushNotification };
