'use strict';

const $ = (sel) => document.querySelector(sel);
const EMOJIS = ['👍', '❤️', '😄', '🎉', '👀', '✅'];

let ws;
let channels = [];
let dms = [];
let online = [];
let current = 'general';
let username = localStorage.getItem('arclo-user') || '';
const msgEls = new Map(); // message id -> DOM element
const typingTimers = new Map(); // user -> timeout id
let lastTypingSent = 0;

$('#username').value = username;

const me = () => username || 'anonymous';

function setStatus(text, state) {
  const el = $('#status');
  el.textContent = text;
  el.className = state || '';
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// --- sidebar ---------------------------------------------------------------

function channelLabel(id) {
  const ch = channels.find((c) => c.id === id);
  if (ch) return `#${ch.name}`;
  const dm = dms.find((d) => d.id === id);
  if (dm) return `@${dm.withUser}`;
  return id;
}

function renderChannels() {
  const ul = $('#channels');
  ul.innerHTML = '';
  for (const ch of channels) {
    const li = document.createElement('li');
    li.textContent = `# ${ch.name}`;
    if (ch.id === current) li.classList.add('active');
    li.addEventListener('click', () => joinChannel(ch.id));
    ul.appendChild(li);
  }
}

function renderDms() {
  const ul = $('#dms');
  ul.innerHTML = '';
  for (const dm of dms) {
    const li = document.createElement('li');
    li.textContent = `@ ${dm.withUser}`;
    if (dm.id === current) li.classList.add('active');
    li.addEventListener('click', () => joinChannel(dm.id));
    ul.appendChild(li);
  }
}

function renderPresence() {
  const ul = $('#presence');
  ul.innerHTML = '';
  for (const user of online) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    li.appendChild(dot);
    li.appendChild(document.createTextNode(user));
    if (user === me()) {
      li.classList.add('self');
      li.appendChild(document.createTextNode(' (you)'));
    } else {
      li.addEventListener('click', () => {
        send({ type: 'open-dm', user });
        closeNavOnMobile();
      });
    }
    ul.appendChild(li);
  }
}

// --- messages --------------------------------------------------------------

function renderReactions(msg) {
  const row = document.createElement('div');
  row.className = 'reactions';
  for (const [emoji, users] of Object.entries(msg.reactions || {})) {
    if (!users.length) continue;
    const chip = document.createElement('button');
    chip.className = 'reaction' + (users.includes(me()) ? ' mine' : '');
    chip.textContent = `${emoji} ${users.length}`;
    chip.title = users.join(', ');
    chip.addEventListener('click', () => send({ type: 'react', messageId: msg.id, emoji }));
    row.appendChild(chip);
  }
  return row;
}

function renderActions(msg) {
  const bar = document.createElement('div');
  bar.className = 'actions';

  const reactBtn = document.createElement('button');
  reactBtn.textContent = '😀';
  reactBtn.title = 'React';
  reactBtn.addEventListener('click', (e) => openPicker(e, msg.id));
  bar.appendChild(reactBtn);

  if (msg.user === me()) {
    const editBtn = document.createElement('button');
    editBtn.textContent = '✏️';
    editBtn.title = 'Edit';
    editBtn.addEventListener('click', () => startEdit(msg));
    bar.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑️';
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', () => {
      if (confirm('Delete this message?')) send({ type: 'delete', messageId: msg.id });
    });
    bar.appendChild(delBtn);
  }
  return bar;
}

function renderMessage(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg';
  wrap.dataset.id = msg.id;

  const meta = document.createElement('div');
  meta.className = 'meta';

  const userEl = document.createElement('span');
  userEl.className = 'user';
  userEl.textContent = msg.user;
  meta.appendChild(userEl);

  if (msg.source === 'agent') {
    const tag = document.createElement('span');
    tag.className = 'agent-tag';
    tag.textContent = 'agent';
    meta.appendChild(tag);
  }

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.appendChild(time);

  if (msg.edited && !msg.deleted) {
    const ed = document.createElement('span');
    ed.className = 'edited';
    ed.textContent = '(edited)';
    meta.appendChild(ed);
  }
  wrap.appendChild(meta);

  const text = document.createElement('div');
  text.className = 'text';
  if (msg.deleted) {
    text.classList.add('deleted');
    text.textContent = 'message deleted';
  } else {
    text.textContent = msg.text;
  }
  wrap.appendChild(text);

  if (!msg.deleted) {
    wrap.appendChild(renderReactions(msg));
    wrap.appendChild(renderActions(msg));
  }
  return wrap;
}

function renderMessages(list) {
  const box = $('#messages');
  box.innerHTML = '';
  msgEls.clear();
  for (const msg of list) {
    const el = renderMessage(msg);
    msgEls.set(msg.id, el);
    box.appendChild(el);
  }
  box.scrollTop = box.scrollHeight;
}

function upsertMessage(msg) {
  if (msg.channel !== current) return;
  const el = renderMessage(msg);
  const old = msgEls.get(msg.id);
  if (old) {
    old.replaceWith(el);
  } else {
    const box = $('#messages');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    box.appendChild(el);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  msgEls.set(msg.id, el);
}

// --- editing & reactions ---------------------------------------------------

function startEdit(msg) {
  const el = msgEls.get(msg.id);
  if (!el) return;
  const textEl = el.querySelector('.text');
  const input = document.createElement('input');
  input.className = 'edit-input';
  input.value = msg.text;
  textEl.replaceWith(input);
  input.focus();
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const v = input.value.trim();
      if (v) send({ type: 'edit', messageId: msg.id, text: v });
    } else if (ev.key === 'Escape') {
      upsertMessage(msg); // re-render original
    }
  });
}

function openPicker(e, msgId) {
  closePicker();
  const pick = document.createElement('div');
  pick.className = 'emoji-picker';
  pick.id = 'emoji-picker';
  for (const emoji of EMOJIS) {
    const btn = document.createElement('button');
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      send({ type: 'react', messageId: msgId, emoji });
      closePicker();
    });
    pick.appendChild(btn);
  }
  document.body.appendChild(pick);
  pick.style.left = `${Math.min(e.clientX, window.innerWidth - 240)}px`;
  pick.style.top = `${e.clientY + 16}px`;
}

function closePicker() {
  const p = document.getElementById('emoji-picker');
  if (p) p.remove();
}

document.addEventListener(
  'click',
  (e) => {
    const p = document.getElementById('emoji-picker');
    if (p && !p.contains(e.target)) closePicker();
  },
  true
);

// --- typing indicator ------------------------------------------------------

function renderTyping() {
  const users = [...typingTimers.keys()];
  const el = $('#typing');
  if (!users.length) el.textContent = '';
  else if (users.length === 1) el.textContent = `${users[0]} is typing…`;
  else el.textContent = `${users.join(', ')} are typing…`;
}

function showTyping(user) {
  clearTimeout(typingTimers.get(user));
  typingTimers.set(
    user,
    setTimeout(() => {
      typingTimers.delete(user);
      renderTyping();
    }, 3500)
  );
  renderTyping();
}

function clearTyping() {
  for (const t of typingTimers.values()) clearTimeout(t);
  typingTimers.clear();
  renderTyping();
}

// --- navigation ------------------------------------------------------------

function joinChannel(id) {
  closeNavOnMobile();
  if (id === current) return;
  send({ type: 'join', channel: id });
}

function setActiveChannel(id) {
  current = id;
  clearTyping();
  $('#messages').innerHTML = '';
  msgEls.clear();
  const label = channelLabel(id);
  $('#channel-name').textContent = label;
  $('#input').placeholder = `Message ${label}`;
  renderChannels();
  renderDms();
}

// --- websocket -------------------------------------------------------------

function handle(data) {
  switch (data.type) {
    case 'channels':
      channels = data.channels;
      renderChannels();
      break;
    case 'dms':
      dms = data.dms;
      renderDms();
      if ($('#channel-name').textContent === current) $('#channel-name').textContent = channelLabel(current);
      break;
    case 'presence':
      online = data.users;
      renderPresence();
      break;
    case 'active-channel':
      setActiveChannel(data.channel);
      break;
    case 'history':
      if (data.channel === current) renderMessages(data.messages);
      break;
    case 'message':
      upsertMessage(data.message);
      handleIncoming(data.message);
      break;
    case 'message-updated':
      upsertMessage(data.message);
      break;
    case 'typing':
      if (data.channel === current && data.user !== me()) showTyping(data.user);
      break;
    case 'error':
      setStatus(data.error, 'bad');
      break;
    default:
      break;
  }
}

function connect() {
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${wsProto}://${location.host}`);
  ws.onopen = () => {
    setStatus('connected', 'ok');
    if (username) send({ type: 'identify', user: username });
    if (current !== 'general') send({ type: 'join', channel: current });
  };
  ws.onclose = () => {
    setStatus('disconnected — retrying…', 'bad');
    setTimeout(connect, 2000);
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

// --- input wiring ----------------------------------------------------------

$('#username').addEventListener('change', (e) => {
  username = e.target.value.trim();
  localStorage.setItem('arclo-user', username);
  send({ type: 'identify', user: me() });
  registerPush(); // re-associate the push subscription with the new name
});

$('#add-channel').addEventListener('click', () => {
  const name = prompt('New channel name:');
  if (name) send({ type: 'create-channel', name });
});

$('#input').addEventListener('input', () => {
  const now = Date.now();
  if (now - lastTypingSent > 2000) {
    lastTypingSent = now;
    send({ type: 'typing' });
  }
});

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  send({ type: 'message', channel: current, text });
  input.value = '';
});

// --- notifications ---------------------------------------------------------

const BASE_TITLE = 'arclo-chat';
let unread = 0;
let audioCtx = null;
let pushSubscribed = false;

function updateTitle() {
  document.title = unread > 0 ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE;
}

/** Short soft "ping" so a message is noticed even with notifications off. */
function playPing() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.06;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    osc.stop(audioCtx.currentTime + 0.27);
  } catch (e) {
    /* audio unavailable — ignore */
  }
}

function notify(msg) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const popup = new Notification(`${msg.user} · ${channelLabel(msg.channel)}`, {
    body: msg.text.slice(0, 140),
    tag: msg.channel,
    renotify: true,
  });
  popup.onclick = () => {
    window.focus();
    if (msg.channel !== current) joinChannel(msg.channel);
    popup.close();
  };
}

/** Runs for every incoming message — alerts for every message from others. */
function handleIncoming(msg) {
  if (msg.user === me()) return; // never alert about your own messages
  playPing();
  if (!pushSubscribed) notify(msg); // when push is active it shows the popup
  if (!document.hasFocus()) {
    unread += 1;
    updateTitle();
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Register the service worker and subscribe to Web Push for background alerts. */
async function registerPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const keyRes = await fetch('/api/push/key');
    if (!keyRes.ok) return;
    const { key } = await keyRes.json();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub, user: me() }),
    });
    pushSubscribed = true;
  } catch (e) {
    console.warn('push notifications unavailable:', e && e.message);
  }
}

// Browser notification permission and audio must be unlocked by a user gesture.
function enableAlerts() {
  if (typeof Notification !== 'undefined') {
    if (Notification.permission === 'granted') {
      registerPush();
    } else if (Notification.permission === 'default') {
      Notification.requestPermission().then((perm) => {
        if (perm === 'granted') registerPush();
      });
    }
  }
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) {
    /* ignore */
  }
}

document.addEventListener('click', enableAlerts, { once: true });
document.addEventListener('keydown', enableAlerts, { once: true });
window.addEventListener('focus', () => {
  unread = 0;
  updateTitle();
});

// Returning visitor who already granted permission — re-subscribe on load.
if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
  registerPush();
}

// --- responsive sidebar ----------------------------------------------------

function closeNavOnMobile() {
  if (window.innerWidth <= 640) document.body.classList.add('nav-collapsed');
}

// Start collapsed on small screens; open on desktop.
if (window.innerWidth <= 640) document.body.classList.add('nav-collapsed');

$('#nav-toggle').addEventListener('click', () => {
  document.body.classList.toggle('nav-collapsed');
});

$('#backdrop').addEventListener('click', () => {
  document.body.classList.add('nav-collapsed');
});

connect();
