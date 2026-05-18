'use strict';

const { EventEmitter } = require('events');

const MAX_HISTORY = 500;

function slug(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'channel';
}

/**
 * In-memory chat state: channels, each with a bounded message history.
 * Emits `message` and `channels` events that the server fans out to clients.
 */
class Store extends EventEmitter {
  constructor() {
    super();
    this.channels = new Map();
    this.createChannel('general');
    this.createChannel('random');
  }

  createChannel(name) {
    const id = slug(name);
    if (!this.channels.has(id)) {
      this.channels.set(id, { id, name: String(name).trim() || id, messages: [] });
      this.emit('channels', this.listChannels());
    }
    return this.channels.get(id);
  }

  listChannels() {
    return [...this.channels.values()].map((c) => ({ id: c.id, name: c.name }));
  }

  hasChannel(id) {
    return this.channels.has(id);
  }

  getMessages(id) {
    const channel = this.channels.get(id);
    return channel ? channel.messages.slice() : null;
  }

  addMessage(channelId, { user, text, source }) {
    const channel = this.channels.get(channelId);
    if (!channel) return null;

    const clean = String(text == null ? '' : text).trim();
    if (!clean) return null;

    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channel: channelId,
      user: String(user || 'anonymous').slice(0, 60),
      text: clean.slice(0, 4000),
      source: source === 'agent' ? 'agent' : 'user',
      ts: new Date().toISOString(),
    };

    channel.messages.push(message);
    if (channel.messages.length > MAX_HISTORY) channel.messages.shift();
    this.emit('message', message);
    return message;
  }
}

module.exports = { store: new Store(), slug };
