'use strict';

const $ = (sel) => document.querySelector(sel);

let ws;
let channels = [];
let current = 'general';
let username = localStorage.getItem('arclo-user') || '';

$('#username').value = username;

function setStatus(text, state) {
  const el = $('#status');
  el.textContent = text;
  el.className = state || '';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderChannels() {
  const ul = $('#channels');
  ul.innerHTML = '';
  for (const ch of channels) {
    const li = document.createElement('li');
    li.textContent = `#${ch.name}`;
    li.dataset.id = ch.id;
    if (ch.id === current) li.classList.add('active');
    li.addEventListener('click', () => joinChannel(ch.id));
    ul.appendChild(li);
  }
}

function appendMessage(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg';
  const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const agentTag = msg.source === 'agent' ? '<span class="agent-tag">agent</span>' : '';
  wrap.innerHTML =
    `<div class="meta"><span class="user">${escapeHtml(msg.user)}</span>${agentTag}` +
    `<span class="time">${time}</span></div>` +
    `<div class="text">${escapeHtml(msg.text)}</div>`;
  const list = $('#messages');
  list.appendChild(wrap);
  list.scrollTop = list.scrollHeight;
}

function renderMessages(messages) {
  $('#messages').innerHTML = '';
  for (const msg of messages) appendMessage(msg);
}

function joinChannel(id) {
  current = id;
  const ch = channels.find((c) => c.id === id);
  $('#channel-header').textContent = `#${ch ? ch.name : id}`;
  $('#input').placeholder = `Message #${ch ? ch.name : id}`;
  $('#messages').innerHTML = '';
  renderChannels();
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'join', channel: id }));
}

function handle(data) {
  if (data.type === 'channels') {
    channels = data.channels;
    renderChannels();
  } else if (data.type === 'history' && data.channel === current) {
    renderMessages(data.messages);
  } else if (data.type === 'message' && data.message.channel === current) {
    appendMessage(data.message);
  } else if (data.type === 'error') {
    setStatus(data.error, 'bad');
  }
}

function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => {
    setStatus('connected', 'ok');
    if (username) ws.send(JSON.stringify({ type: 'identify', user: username }));
    if (current !== 'general') ws.send(JSON.stringify({ type: 'join', channel: current }));
  };
  ws.onclose = () => {
    setStatus('disconnected — retrying…', 'bad');
    setTimeout(connect, 2000);
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

$('#username').addEventListener('change', (e) => {
  username = e.target.value.trim() || 'anonymous';
  localStorage.setItem('arclo-user', username);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'identify', user: username }));
});

$('#add-channel').addEventListener('click', () => {
  const name = prompt('New channel name:');
  if (name && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'create-channel', name }));
  }
});

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#input');
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'message', channel: current, user: username || 'anonymous', text }));
  input.value = '';
});

connect();
