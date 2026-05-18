'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { getLanInterface, normalizeIp, ipInSubnet } = require('./src/network');
const { store } = require('./src/store');

const PORT = Number(process.env.PORT) || 4040;
const lan = getLanInterface();
// Bind to the LAN interface so the server is not reachable beyond the local
// network. HOST can override (e.g. 0.0.0.0) but the subnet check below still applies.
const HOST = process.env.HOST || (lan && lan.address) || '127.0.0.1';

/**
 * Same-network gate: a connection is allowed only from loopback or from an
 * address inside this machine's LAN subnet. This is the "subnet allowlist"
 * half of the protection; binding to HOST is the other half.
 */
function isSameNetwork(rawIp) {
  const ip = normalizeIp(rawIp);
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (!lan) return false;
  return ipInSubnet(ip, lan.address, lan.netmask);
}

const app = express();
app.use(express.json({ limit: '64kb' }));

// Reject anything not on the same network before it reaches any route.
app.use((req, res, next) => {
  if (!isSameNetwork(req.socket.remoteAddress)) {
    return res.status(403).json({ error: 'Forbidden: arclo-chat only accepts connections from the same network.' });
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

// --- WebSocket API ---------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  if (!isSameNetwork(req.socket.remoteAddress)) {
    ws.send(JSON.stringify({ type: 'error', error: 'Forbidden: not on the same network.' }));
    ws.close();
    return;
  }

  ws.user = 'anonymous';
  ws.channel = 'general';
  ws.send(JSON.stringify({ type: 'channels', channels: store.listChannels() }));
  ws.send(JSON.stringify({ type: 'history', channel: ws.channel, messages: store.getMessages(ws.channel) }));

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    switch (data.type) {
      case 'identify':
        ws.user = String(data.user || ws.user).slice(0, 60);
        break;
      case 'join':
        if (store.hasChannel(data.channel)) {
          ws.channel = data.channel;
          ws.send(JSON.stringify({ type: 'history', channel: data.channel, messages: store.getMessages(data.channel) }));
        }
        break;
      case 'create-channel':
        if (data.name) store.createChannel(data.name);
        break;
      case 'message':
        store.addMessage(data.channel || ws.channel, {
          user: data.user || ws.user,
          text: data.text,
          source: data.source,
        });
        break;
      default:
        break;
    }
  });
});

// Fan out store events to connected WebSocket clients.
store.on('message', (message) => {
  const payload = JSON.stringify({ type: 'message', message });
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.channel === message.channel) client.send(payload);
  }
});

store.on('channels', (channels) => {
  const payload = JSON.stringify({ type: 'channels', channels });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`arclo-chat listening on http://${HOST}:${PORT}`);
  if (lan) {
    console.log(`Same-network access: anyone on ${lan.address}/${lan.netmask} — others are rejected.`);
  } else {
    console.log('No LAN interface found — only loopback connections will be accepted.');
  }
});
