'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const Database = require('better-sqlite3');

const MAX_HISTORY = 1000;
const MAX_TEXT = 4000;

function slug(name) {
  return (
    String(name || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'channel'
  );
}

/** Deterministic id for the DM channel between two users. */
function dmId(userA, userB) {
  const [x, y] = [String(userA), String(userB)].sort();
  return `dm:${encodeURIComponent(x)}|${encodeURIComponent(y)}`;
}

function newMessageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * SQLite-backed chat state: channels, DM channels, messages, reactions.
 * Emits `message`, `message-updated`, and `channels` events that the server
 * fans out to connected clients.
 */
class Store extends EventEmitter {
  constructor(dbPath) {
    super();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this._migrate();
    this._seed();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL DEFAULT 'channel',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id TEXT NOT NULL,
        user       TEXT NOT NULL,
        PRIMARY KEY (channel_id, user)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        user       TEXT NOT NULL,
        text       TEXT NOT NULL,
        source     TEXT NOT NULL DEFAULT 'user',
        edited     INTEGER NOT NULL DEFAULT 0,
        deleted    INTEGER NOT NULL DEFAULT 0,
        ts         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, ts);
      CREATE TABLE IF NOT EXISTS reactions (
        message_id TEXT NOT NULL,
        user       TEXT NOT NULL,
        emoji      TEXT NOT NULL,
        PRIMARY KEY (message_id, user, emoji)
      );
    `);
  }

  _seed() {
    const { c } = this.db.prepare("SELECT COUNT(*) c FROM channels WHERE type='channel'").get();
    if (c === 0) {
      this.createChannel('general');
      this.createChannel('random');
    }
  }

  // --- channels ------------------------------------------------------------

  getChannel(id) {
    return this.db.prepare('SELECT id, name, type FROM channels WHERE id = ?').get(id) || null;
  }

  hasChannel(id) {
    return !!this.getChannel(id);
  }

  listChannels() {
    return this.db
      .prepare("SELECT id, name FROM channels WHERE type = 'channel' ORDER BY created_at ASC")
      .all();
  }

  createChannel(name) {
    const id = slug(name);
    if (!this.hasChannel(id)) {
      this.db
        .prepare('INSERT INTO channels (id, name, type, created_at) VALUES (?, ?, ?, ?)')
        .run(id, String(name).trim() || id, 'channel', new Date().toISOString());
      this.emit('channels', this.listChannels());
    }
    return this.getChannel(id);
  }

  getOrCreateDM(userA, userB) {
    const id = dmId(userA, userB);
    if (!this.hasChannel(id)) {
      const now = new Date().toISOString();
      const name = [userA, userB].sort().join(', ');
      const tx = this.db.transaction(() => {
        this.db
          .prepare('INSERT INTO channels (id, name, type, created_at) VALUES (?, ?, ?, ?)')
          .run(id, name, 'dm', now);
        const insMember = this.db.prepare(
          'INSERT OR IGNORE INTO channel_members (channel_id, user) VALUES (?, ?)'
        );
        insMember.run(id, userA);
        insMember.run(id, userB);
      });
      tx();
    }
    return this.getChannel(id);
  }

  /** DM channels a given user is a member of, with the other participant's name. */
  listDMsFor(user) {
    const rows = this.db
      .prepare(
        `SELECT c.id FROM channels c
           JOIN channel_members m ON m.channel_id = c.id
          WHERE c.type = 'dm' AND m.user = ?`
      )
      .all(user);
    return rows.map((r) => {
      const other = this.db
        .prepare('SELECT user FROM channel_members WHERE channel_id = ? AND user <> ? LIMIT 1')
        .get(r.id, user);
      return { id: r.id, withUser: other ? other.user : user };
    });
  }

  /** True when the user may read/post to a channel (DMs are member-only). */
  canAccess(channelId, user) {
    const channel = this.getChannel(channelId);
    if (!channel) return false;
    if (channel.type !== 'dm') return true;
    return !!this.db
      .prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user = ?')
      .get(channelId, user);
  }

  // --- messages ------------------------------------------------------------

  _shape(row) {
    const reactions = {};
    for (const r of this.db
      .prepare('SELECT user, emoji FROM reactions WHERE message_id = ?')
      .all(row.id)) {
      (reactions[r.emoji] = reactions[r.emoji] || []).push(r.user);
    }
    return {
      id: row.id,
      channel: row.channel_id,
      user: row.user,
      text: row.deleted ? '' : row.text,
      source: row.source,
      edited: !!row.edited,
      deleted: !!row.deleted,
      ts: row.ts,
      reactions,
    };
  }

  getMessage(id) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? this._shape(row) : null;
  }

  getMessages(channelId) {
    if (!this.hasChannel(channelId)) return null;
    return this.db
      .prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY ts ASC, id ASC')
      .all(channelId)
      .map((row) => this._shape(row));
  }

  _prune(channelId) {
    const stale = this.db
      .prepare(
        'SELECT id FROM messages WHERE channel_id = ? ORDER BY ts DESC, id DESC LIMIT -1 OFFSET ?'
      )
      .all(channelId, MAX_HISTORY);
    if (!stale.length) return;
    const delMsg = this.db.prepare('DELETE FROM messages WHERE id = ?');
    const delRx = this.db.prepare('DELETE FROM reactions WHERE message_id = ?');
    for (const r of stale) {
      delRx.run(r.id);
      delMsg.run(r.id);
    }
  }

  addMessage(channelId, { user, text, source } = {}) {
    if (!this.hasChannel(channelId)) return null;
    const clean = String(text == null ? '' : text).trim();
    if (!clean) return null;

    const id = newMessageId();
    this.db
      .prepare(
        'INSERT INTO messages (id, channel_id, user, text, source, edited, deleted, ts) ' +
          'VALUES (?, ?, ?, ?, ?, 0, 0, ?)'
      )
      .run(
        id,
        channelId,
        String(user || 'anonymous').slice(0, 60),
        clean.slice(0, MAX_TEXT),
        source === 'agent' ? 'agent' : 'user',
        new Date().toISOString()
      );
    this._prune(channelId);

    const message = this.getMessage(id);
    this.emit('message', message);
    return message;
  }

  /** Edit a message — only the original author may do so. */
  editMessage(messageId, user, text) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!row || row.deleted || row.user !== user) return null;
    const clean = String(text == null ? '' : text).trim();
    if (!clean) return null;

    this.db
      .prepare('UPDATE messages SET text = ?, edited = 1 WHERE id = ?')
      .run(clean.slice(0, MAX_TEXT), messageId);
    const message = this.getMessage(messageId);
    this.emit('message-updated', message);
    return message;
  }

  /** Soft-delete a message — only the original author may do so. */
  deleteMessage(messageId, user) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!row || row.deleted || row.user !== user) return null;

    this.db.prepare("UPDATE messages SET deleted = 1, text = '' WHERE id = ?").run(messageId);
    this.db.prepare('DELETE FROM reactions WHERE message_id = ?').run(messageId);
    const message = this.getMessage(messageId);
    this.emit('message-updated', message);
    return message;
  }

  /** Toggle one emoji reaction by one user on one message. */
  toggleReaction(messageId, user, emoji) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!row || row.deleted) return null;
    const e = String(emoji || '').slice(0, 16);
    if (!e) return null;

    const has = this.db
      .prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user = ? AND emoji = ?')
      .get(messageId, user, e);
    if (has) {
      this.db
        .prepare('DELETE FROM reactions WHERE message_id = ? AND user = ? AND emoji = ?')
        .run(messageId, user, e);
    } else {
      this.db
        .prepare('INSERT OR IGNORE INTO reactions (message_id, user, emoji) VALUES (?, ?, ?)')
        .run(messageId, user, e);
    }
    const message = this.getMessage(messageId);
    this.emit('message-updated', message);
    return message;
  }
}

module.exports = { Store, slug, dmId };
