'use strict';

/**
 * Example Agent Hub client for arclo-chat.
 *
 * Demonstrates both connection styles. This must run on the SAME network as
 * the arclo-chat server — connections from other subnets are rejected.
 *
 *   node examples/agent-hub-client.js
 *
 * Override the target with CHAT_URL (HTTP) — the WS URL is derived from it.
 */

const WebSocket = require('ws');

const HTTP_URL = process.env.CHAT_URL || 'http://localhost:4040';
const WS_URL = HTTP_URL.replace(/^http/, 'ws');
const CHANNEL = process.env.CHANNEL || 'general';

async function postViaRest(text) {
  const res = await fetch(`${HTTP_URL}/api/channels/${CHANNEL}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'agent-hub', text, source: 'agent' }),
  });
  console.log('[REST] post status:', res.status);
}

function listenViaWebSocket() {
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('[WS] connected to', WS_URL);
    ws.send(JSON.stringify({ type: 'identify', user: 'agent-hub' }));
    ws.send(JSON.stringify({ type: 'join', channel: CHANNEL }));
    ws.send(JSON.stringify({ type: 'message', channel: CHANNEL, text: 'Agent Hub is online.', source: 'agent' }));
  });

  ws.on('message', (raw) => {
    const data = JSON.parse(raw);
    if (data.type === 'message') {
      const m = data.message;
      console.log(`[WS] #${m.channel} <${m.user}> ${m.text}`);
    } else if (data.type === 'error') {
      console.error('[WS] error:', data.error);
    }
  });

  ws.on('close', () => console.log('[WS] connection closed'));
  ws.on('error', (err) => console.error('[WS] error:', err.message));
}

(async () => {
  await postViaRest('Hello from Agent Hub via REST.');
  listenViaWebSocket();
})();
