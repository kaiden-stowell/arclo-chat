'use strict';

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

/**
 * Load or generate VAPID keys and configure web-push. Keys are persisted so
 * they stay stable across restarts — regenerating them would invalidate every
 * existing push subscription.
 */
function setupPush(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'vapid.json');

  let keys;
  if (fs.existsSync(file)) {
    keys = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(file, JSON.stringify(keys, null, 2));
  }

  webpush.setVapidDetails('mailto:admin@arclo-chat.local', keys.publicKey, keys.privateKey);
  return keys;
}

module.exports = { setupPush, webpush };
