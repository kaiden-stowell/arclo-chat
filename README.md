# arclo-chat

A lightweight, Slack-style chat server. Messages live in channels and direct
messages, are delivered in real time over WebSocket, persist to SQLite, and
**only devices on the same network can connect** — Agent Hub or any other
client reaches it through an HTTP/WebSocket API.

## Features

- **Channels** — public rooms anyone on the network can join and post to.
- **Direct messages** — private 1-to-1 conversations; only the two members can
  read or post.
- **Presence & typing** — see who is online, and live "X is typing…" hints.
- **Reactions** — toggle emoji reactions on any message.
- **Edit & delete** — change or remove your own messages (others see the update
  instantly; deletes leave a tombstone).
- **Persistent history** — channels, messages, and reactions are stored in a
  SQLite file and survive restarts.
- **Message alerts** — a sound and an unread-count badge for every new message.
  Optional background push notifications are available over HTTPS
  (`ARCLO_HTTPS=1`).

## Why "same network only"

arclo-chat enforces the network boundary two ways at once:

1. **LAN bind** — the server binds to the machine's LAN interface, so it is not
   listening on any address reachable from outside the local network.
2. **Subnet allowlist** — every HTTP request and WebSocket connection is checked
   against the host's subnet. Anything from another subnet gets `403 Forbidden`
   (or an immediate WS close), even if a port were exposed.

Loopback (`127.0.0.1`) is always allowed so you can use the server locally.

## Install

One line — clones the repo and installs dependencies:

```bash
curl -fsSL https://raw.githubusercontent.com/kaiden-stowell/arclo-chat/main/install.sh | bash
```

Installs into `~/arclo-chat` (override with `ARCLO_DIR`). Requires `git` and
Node.js 18+. Then start the server:

```bash
cd ~/arclo-chat && npm start
```

### Manual install

```bash
git clone https://github.com/kaiden-stowell/arclo-chat.git
cd arclo-chat
npm install
npm start
```

The console prints the address to open, e.g. `http://192.168.1.20:4040`.
Open it from any device on the same Wi-Fi/LAN, set a display name, and chat.

### Configuration

| Env var   | Default                   | Purpose                                  |
|-----------|---------------------------|------------------------------------------|
| `PORT`    | `4040`                    | Listening port                           |
| `HOST`    | detected LAN IPv4         | Bind address (e.g. `0.0.0.0` to override) |
| `DB_PATH` | `data/arclo-chat.db`      | SQLite database file                     |

The subnet check applies regardless of `HOST`. The `data/` directory is created
automatically and is git-ignored.

## HTTP API (for Agent Hub)

| Method | Path                          | Body                           | Description           |
|--------|-------------------------------|--------------------------------|-----------------------|
| GET    | `/api/health`                 | —                              | Server + network info |
| GET    | `/api/channels`               | —                              | List channels         |
| POST   | `/api/channels`               | `{ "name": "…" }`              | Create a channel      |
| GET    | `/api/channels/:id/messages`  | —                              | Channel history       |
| POST   | `/api/channels/:id/messages`  | `{ "user", "text", "source" }` | Send a message        |
| GET    | `/api/push/key`               | —                              | VAPID public key      |
| POST   | `/api/push/subscribe`         | `{ "subscription", "user" }`   | Register for push     |

A message posted over REST is broadcast live to every connected WebSocket
client. Set `"source": "agent"` so it shows an **agent** badge in the UI.

```bash
curl -X POST http://192.168.1.20:4040/api/channels/general/messages \
  -H 'Content-Type: application/json' \
  -d '{"user":"agent-hub","text":"deploy finished","source":"agent"}'
```

## WebSocket API

Connect to `ws://<host>:<port>` (`wss://` when running with `ARCLO_HTTPS=1`).
All frames are JSON.

**Client → server**

| `type`           | Fields                       | Notes                                |
|------------------|------------------------------|--------------------------------------|
| `identify`       | `user`                       | Sets your display name / presence    |
| `join`           | `channel`                    | Switch to a channel or DM            |
| `create-channel` | `name`                       |                                      |
| `open-dm`        | `user`                       | Open (creating if needed) a DM       |
| `message`        | `channel`, `text`, `source?` |                                      |
| `typing`         | —                            | Broadcasts a typing hint             |
| `edit`           | `messageId`, `text`          | Author only                          |
| `delete`         | `messageId`                  | Author only                          |
| `react`          | `messageId`, `emoji`         | Toggles the reaction                 |

**Server → client**

| `type`            | Fields                  | Notes                                  |
|-------------------|-------------------------|----------------------------------------|
| `channels`        | `channels[]`            |                                        |
| `dms`             | `dms[]`                 | `{ id, withUser }` for the current user |
| `presence`        | `users[]`               | Display names currently online         |
| `active-channel`  | `channel`               | The channel the server moved you into  |
| `history`         | `channel`, `messages[]` |                                        |
| `message`         | `message`               | New message                            |
| `message-updated` | `message`               | Edit, delete, or reaction change       |
| `typing`          | `channel`, `user`       |                                        |
| `error`           | `error`                 |                                        |

A `message` object looks like:

```json
{
  "id": "1747000000000-ab12cd",
  "channel": "general",
  "user": "alice",
  "text": "hi",
  "source": "user",
  "edited": false,
  "deleted": false,
  "ts": "2026-05-19T10:00:00.000Z",
  "reactions": { "👍": ["bob"] }
}
```

## Agent Hub example

`examples/agent-hub-client.js` shows an agent posting over REST and listening
over WebSocket. Run it on the same network as the server:

```bash
CHAT_URL=http://192.168.1.20:4040 npm run agent-example
```

## Notes & limits

- History is bounded to the most recent 1000 messages per channel.
- By default the server runs over HTTP so any device can connect without a
  certificate warning. Set `ARCLO_HTTPS=1` to serve HTTPS with a self-signed
  certificate, which enables background Web Push — but browsers then show an
  "unsafe" warning each device must click through, and some QR scanners
  refuse the link entirely.
- The network boundary is the only access control — anyone on the LAN can pick
  any display name. Add authentication before using on an untrusted network.
