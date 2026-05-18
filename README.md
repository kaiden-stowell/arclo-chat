# arclo-chat

A lightweight, Slack-style chat server. Messages live in channels, are delivered
in real time over WebSocket, and **only devices on the same network can connect** —
Agent Hub or any other client reaches it through an HTTP/WebSocket API.

## Why "same network only"

arclo-chat enforces the network boundary two ways at once:

1. **LAN bind** — the server binds to the machine's LAN interface, so it is not
   listening on any address reachable from outside the local network.
2. **Subnet allowlist** — every HTTP request and WebSocket connection is checked
   against the host's subnet. Anything from another subnet gets `403 Forbidden`
   (or an immediate WS close), even if a port were exposed.

Loopback (`127.0.0.1`) is always allowed so you can use the server locally.

## Quick start

```bash
npm install
npm start
```

The console prints the address to open, e.g. `http://192.168.1.20:4040`.
Open it from any device on the same Wi-Fi/LAN and start chatting.

### Configuration

| Env var | Default            | Purpose                                  |
|---------|--------------------|------------------------------------------|
| `PORT`  | `4040`             | Listening port                           |
| `HOST`  | detected LAN IPv4  | Bind address (e.g. `0.0.0.0` to override) |

The subnet check applies regardless of `HOST`.

## HTTP API (for Agent Hub)

| Method | Path                              | Body                              | Description            |
|--------|-----------------------------------|-----------------------------------|------------------------|
| GET    | `/api/health`                     | —                                 | Server + network info  |
| GET    | `/api/channels`                   | —                                 | List channels          |
| POST   | `/api/channels`                   | `{ "name": "…" }`                 | Create a channel       |
| GET    | `/api/channels/:id/messages`      | —                                 | Channel history        |
| POST   | `/api/channels/:id/messages`      | `{ "user", "text", "source" }`    | Send a message         |

A message posted over REST is broadcast live to every connected WebSocket client.
Set `"source": "agent"` so it shows an **agent** badge in the UI.

```bash
curl -X POST http://192.168.1.20:4040/api/channels/general/messages \
  -H 'Content-Type: application/json' \
  -d '{"user":"agent-hub","text":"deploy finished","source":"agent"}'
```

## WebSocket API

Connect to `ws://<host>:<port>`. All frames are JSON.

**Client → server**

| `type`           | Fields                          |
|------------------|---------------------------------|
| `identify`       | `user`                          |
| `join`           | `channel`                       |
| `create-channel` | `name`                          |
| `message`        | `channel`, `text`, `source?`    |

**Server → client**

| `type`     | Fields                  |
|------------|-------------------------|
| `channels` | `channels[]`            |
| `history`  | `channel`, `messages[]` |
| `message`  | `message`               |
| `error`    | `error`                 |

## Agent Hub example

`examples/agent-hub-client.js` shows an agent posting over REST and listening
over WebSocket. Run it on the same network as the server:

```bash
CHAT_URL=http://192.168.1.20:4040 npm run agent-example
```

## Notes & limits

- Messages and channels are kept in memory (last 500 per channel) — restarting
  the server clears history. Swap `src/store.js` for a database to persist.
- The network boundary is the only access control. Add an API key /
  authentication layer before using on an untrusted LAN.
