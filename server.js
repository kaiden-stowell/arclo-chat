'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const { getLanInterface, normalizeIp, ipInSubnet } = require('./src/network');
const { Store } = require('./src/store');

const PORT = Number(process.env.PORT) || 4040;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'arclo-chat.db');
const lan = getLanInterface();
// Bind to the LAN interface so the server is not reachable beyond the local
// network. HOST can override (e.g. 0.0.0.0) but the subnet check still applies.
const HOST = process.env.HOST || (lan && lan.address) || '127.0.0.1';

const store = new Store(DB_PATH);

// URL a phone on the same network uses — always the LAN address, never loopback.
const chatUrl = `http://${(lan && lan.address) || HOST}:${PORT}`;
let qrSvg = '';

/**
 * Same-network gate: a connection is allowed only from loopback or from an
 * address inside this machine's LAN subnet.
 */
function isSameNetwork(rawIp) {
  const ip = normalizeIp(rawIp);
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (!lan) return false;
  return ipInSubnet(ip, lan.address, lan.netmask);
}

const app = express();
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  if (!isSameNetwork(req.socket.remoteAddress)) {
    return res
      .status(403)
      .json({ error: 'Forbidden: arclo-chat only accepts connections from the same network.' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// --- REST API (used by Agent Hub and any other HTTP client) ----------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, network: lan ? `${lan.address}/${lan.netmask}` : 'offline' });
});

app.get('/api/channels', (req, res) => {
  res.json({ channels: store.listChannels() });
});

app.post('/api/channels', (req, res) => {
  const name = req.body && req.body.name;
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.status(201).json({ channel: store.createChannel(name) });
});

app.get('/api/channels/:id/messages', (req, res) => {
  const messages = store.getMessages(req.params.id);
  if (messages === null) return res.status(404).json({ error: 'unknown channel' });
  res.json({ messages });
});

app.post('/api/channels/:id/messages', (req, res) => {
  if (!store.hasChannel(req.params.id)) return res.status(404).json({ error: 'unknown channel' });
  const { user, text, source } = req.body || {};
  const message = store.addMessage(req.params.id, { user, text, source });
  if (!message) return res.status(400).json({ error: 'text is required' });
  res.status(201).json({ message });
});

// --- QR code (open the chat on a phone on the same network) ----------------

function qrPage(url, svg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>arclo-chat — scan to join</title>
<style>
  body { margin:0; min-height:100vh; box-sizing:border-box; padding:24px;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    text-align:center; background:#1a1d21; color:#e8e8e8;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; }
  p { color:#9b9b9b; margin:0 0 18px; }
  .card { background:#fff; padding:18px; border-radius:14px; }
  .card svg { width:min(280px,72vw); height:auto; display:block; }
  a { color:#4a9eff; margin-top:18px; font-size:15px; text-decoration:none;
    word-break:break-all; }
</style>
</head>
<body>
  <h1>Scan to join arclo-chat</h1>
  <p>Your phone must be on the same Wi-Fi / network.</p>
  <div class="card">${svg}</div>
  <a href="${url}">${url}</a>
</body>
</html>`;
}

app.get('/api/qr.svg', (req, res) => {
  res.type('image/svg+xml').send(qrSvg);
});

app.get('/qr', (req, res) => {
  res.type('html').send(qrPage(chatUrl, qrSvg));
});

// --- WebSocket API ---------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(obj, filter) {
  const payload = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1 && (!filter || filter(client))) client.send(payload);
  }
}

/** Distinct display names of clients that have identified themselves. */
function onlineUsers() {
  const users = new Set();
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.identified && client.user) users.add(client.user);
  }
  return [...users].sort();
}

function broadcastPresence() {
  broadcast({ type: 'presence', users: onlineUsers() });
}

function sendDmList(user) {
  const dms = store.listDMsFor(user);
  broadcast({ type: 'dms', dms }, (c) => c.user === user);
}

/** Move a client into a channel and send it the active-channel + history. */
function joinClient(ws, channelId) {
  ws.channel = channelId;
  send(ws, { type: 'active-channel', channel: channelId });
  send(ws, { type: 'history', channel: channelId, messages: store.getMessages(channelId) });
}

wss.on('connection', (ws, req) => {
  if (!isSameNetwork(req.socket.remoteAddress)) {
    send(ws, { type: 'error', error: 'Forbidden: not on the same network.' });
    ws.close();
    return;
  }

  ws.user = 'anonymous';
  ws.identified = false;
  ws.channel = 'general';

  send(ws, { type: 'channels', channels: store.listChannels() });
  send(ws, { type: 'dms', dms: store.listDMsFor(ws.user) });
  send(ws, { type: 'presence', users: onlineUsers() });
  joinClient(ws, 'general');

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    switch (data.type) {
      case 'identify': {
        ws.user = String(data.user || 'anonymous').slice(0, 60).trim() || 'anonymous';
        ws.identified = true;
        broadcastPresence();
        send(ws, { type: 'dms', dms: store.listDMsFor(ws.user) });
        break;
      }

      case 'join': {
        if (store.canAccess(data.channel, ws.user)) joinClient(ws, data.channel);
        else send(ws, { type: 'error', error: 'No access to that conversation.' });
        break;
      }

      case 'create-channel': {
        if (data.name) store.createChannel(data.name);
        break;
      }

      case 'open-dm': {
        const target = String(data.user || '').slice(0, 60).trim();
        if (!target || target === ws.user) break;
        const dm = store.getOrCreateDM(ws.user, target);
        joinClient(ws, dm.id);
        sendDmList(ws.user);
        sendDmList(target);
        break;
      }

      case 'message': {
        store.addMessage(data.channel || ws.channel, {
          user: ws.user,
          text: data.text,
          source: data.source,
        });
        break;
      }

      case 'typing': {
        broadcast(
          { type: 'typing', channel: ws.channel, user: ws.user },
          (c) => c !== ws && c.channel === ws.channel
        );
        break;
      }

      case 'edit': {
        store.editMessage(data.messageId, ws.user, data.text);
        break;
      }

      case 'delete': {
        store.deleteMessage(data.messageId, ws.user);
        break;
      }

      case 'react': {
        store.toggleReaction(data.messageId, ws.user, data.emoji);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => broadcastPresence());
});

// Fan out store events to the clients viewing the affected channel.
store.on('message', (message) => {
  broadcast({ type: 'message', message }, (c) => c.channel === message.channel);
});

store.on('message-updated', (message) => {
  broadcast({ type: 'message-updated', message }, (c) => c.channel === message.channel);
});

store.on('channels', (channels) => {
  broadcast({ type: 'channels', channels });
});

server.listen(PORT, HOST, async () => {
  console.log(`arclo-chat listening on http://${HOST}:${PORT}`);
  if (lan) {
    console.log(`Same-network access: anyone on ${lan.address}/${lan.netmask} — others are rejected.`);
  } else {
    console.log('No LAN interface found — only loopback connections will be accepted.');
  }
  try {
    qrSvg = await QRCode.toString(chatUrl, { type: 'svg', margin: 1 });
    const terminalQr = await QRCode.toString(chatUrl, { type: 'terminal', small: true });
    console.log(`\nScan with your phone (same network) to open ${chatUrl}\n`);
    console.log(terminalQr);
    console.log(`Or open ${chatUrl}/qr in a browser to show a larger code.\n`);
  } catch (err) {
    console.error('Could not generate QR code:', err.message);
  }
});
