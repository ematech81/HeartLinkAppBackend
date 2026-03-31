/**
 * HeartLink — Push Notification Utility
 * Sends Expo push notifications via the Expo Push API.
 */

const { Expo } = require('expo-server-sdk');

const expo = new Expo();

/**
 * Send a push notification to a single user.
 * @param {string} pushToken  - Expo push token (ExponentPushToken[...])
 * @param {string} title      - Notification title
 * @param {string} body       - Notification body text
 * @param {object} data       - Extra data for navigation (type, userId, etc.)
 */
const sendPushNotification = async (pushToken, title, body, data = {}) => {
  if (!pushToken || !Expo.isExpoPushToken(pushToken)) {
    console.log(`⚠️ [Push] Invalid or missing token: ${pushToken}`);
    return;
  }

  try {
    const messages = [
      {
        to:       pushToken,
        sound:    'default',
        title,
        body,
        data,
        priority: 'high',
        badge:    1,
      },
    ];

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      receipts.forEach((receipt) => {
        if (receipt.status === 'error') {
          console.error('❌ [Push] Receipt error:', receipt.message);
        }
      });
    }

    console.log(`📲 [Push] Sent "${title}" → ${pushToken.substring(0, 30)}...`);
  } catch (err) {
    console.error('❌ [Push] Failed to send notification:', err.message);
  }
};

module.exports = { sendPushNotification };
