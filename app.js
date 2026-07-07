const $ = (id) => document.getElementById(id);

let token = localStorage.getItem('wc_token') || '';
let me = JSON.parse(localStorage.getItem('wc_user') || 'null');
let socket = null;
let conversations = [];
let activeConversation = null;
let messages = [];
let typingTimer = null;

const authScreen = $('authScreen');
const app = $('app');
const authError = $('authError');

function showError(message) {
  authError.textContent = message || '';
}

function setAuthMode(mode) {
  const login = mode === 'login';
  $('loginTab').classList.toggle('active', login);
  $('signupTab').classList.toggle('active', !login);
  $('loginForm').classList.toggle('hidden', !login);
  $('signupForm').classList.toggle('hidden', login);
  showError('');
}

$('loginTab').onclick = () => setAuthMode('login');
$('signupTab').onclick = () => setAuthMode('signup');

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('loginUsername').value,
        password: $('loginPassword').value
      })
    });
    saveSession(data);
    startApp();
  } catch (err) {
    showError(err.message);
  }
});

$('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  try {
    const data = await api('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        displayName: $('signupDisplayName').value,
        username: $('signupUsername').value,
        password: $('signupPassword').value
      })
    });
    saveSession(data);
    startApp();
  } catch (err) {
    showError(err.message);
  }
});

function saveSession(data) {
  token = data.token;
  me = data.user;
  localStorage.setItem('wc_token', token);
  localStorage.setItem('wc_user', JSON.stringify(me));
}

$('logoutBtn').onclick = () => {
  localStorage.removeItem('wc_token');
  localStorage.removeItem('wc_user');
  token = '';
  me = null;
  if (socket) socket.disconnect();
  socket = null;
  activeConversation = null;
  conversations = [];
  app.classList.add('hidden');
  authScreen.classList.remove('hidden');
};

async function startApp() {
  authScreen.classList.add('hidden');
  app.classList.remove('hidden');
  $('meAvatar').textContent = me.avatar || '?';
  $('meName').textContent = me.displayName;
  $('meUser').textContent = '@' + me.username;
  connectSocket();
  await loadConversations();
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });

  socket.on('connect_error', () => {
    localStorage.removeItem('wc_token');
    localStorage.removeItem('wc_user');
    location.reload();
  });

  socket.on('presence:update', ({ userId, online }) => {
    conversations = conversations.map(c => {
      if (c.otherUser.id === userId) c.otherUser.online = online;
      return c;
    });
    renderConversations();
    if (activeConversation?.otherUser.id === userId) {
      $('chatStatus').textContent = online ? 'online' : 'offline';
    }
  });

  socket.on('message:new', (message) => {
    if (activeConversation && message.conversationId === activeConversation.id) {
      messages.push(message);
      renderMessages();
      socket.emit('message:read', { conversationId: activeConversation.id });
    }
    loadConversations(false);
  });

  socket.on('conversation:updated', () => loadConversations(false));

  socket.on('typing:update', ({ conversationId, typing }) => {
    if (!activeConversation || conversationId !== activeConversation.id) return;
    $('typingLine').classList.toggle('hidden', !typing);
  });
}

async function loadConversations(showEmpty = true) {
  const data = await api('/api/conversations');
  conversations = data.conversations;
  renderConversations();
  if (!showEmpty && activeConversation) {
    activeConversation = conversations.find(c => c.id === activeConversation.id) || activeConversation;
  }
}

function renderConversations() {
  const list = $('conversationList');
  list.innerHTML = '';
  if (!conversations.length) {
    list.innerHTML = '<div class="row"><div class="row-main"><div class="name">No chats yet</div><div class="last">Search a username to begin.</div></div></div>';
    return;
  }
  conversations.forEach(c => {
    const row = document.createElement('div');
    row.className = 'row' + (activeConversation?.id === c.id ? ' active' : '');
    row.onclick = () => openConversation(c.id);
    row.innerHTML = `
      <div class="avatar-wrap"><div class="avatar">${escapeHtml(c.otherUser.avatar || '?')}</div>${c.otherUser.online ? '<div class="online-dot"></div>' : ''}</div>
      <div class="row-main">
        <div class="row-top"><div class="name">${escapeHtml(c.otherUser.displayName)}</div><div class="time">${formatTime(c.lastMessage?.createdAt || c.updatedAt)}</div></div>
        <div class="row-top"><div class="last">${escapeHtml(c.lastMessage ? c.lastMessage.text : '@' + c.otherUser.username)}</div>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>
      </div>`;
    list.appendChild(row);
  });
}

let searchDelay = null;
$('searchInput').addEventListener('input', () => {
  clearTimeout(searchDelay);
  searchDelay = setTimeout(searchUsers, 250);
});

async function searchUsers() {
  const q = $('searchInput').value.trim();
  const box = $('searchResults');
  if (!q) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const data = await api('/api/users/search?q=' + encodeURIComponent(q));
  box.classList.remove('hidden');
  if (!data.users.length) {
    box.innerHTML = '<div class="row"><div class="row-main"><div class="name">No users found</div><div class="last">Try another username.</div></div></div>';
    return;
  }
  box.innerHTML = '';
  data.users.forEach(u => {
    const row = document.createElement('div');
    row.className = 'row';
    row.onclick = () => startConversation(u.id);
    row.innerHTML = `
      <div class="avatar">${escapeHtml(u.avatar || '?')}</div>
      <div class="row-main"><div class="name">${escapeHtml(u.displayName)}</div><div class="last">@${escapeHtml(u.username)} • ${u.online ? 'online' : 'offline'}</div></div>`;
    box.appendChild(row);
  });
}

async function startConversation(userId) {
  const data = await api('/api/conversations/start', {
    method: 'POST',
    body: JSON.stringify({ userId })
  });
  $('searchInput').value = '';
  $('searchResults').classList.add('hidden');
  await loadConversations(false);
  openConversation(data.conversation.id);
}

async function openConversation(id) {
  activeConversation = conversations.find(c => c.id === id) || activeConversation;
  if (!activeConversation) return;
  $('emptyChat').classList.add('hidden');
  $('activeChat').classList.remove('hidden');
  app.classList.add('chat-open');
  $('chatAvatar').textContent = activeConversation.otherUser.avatar || '?';
  $('chatName').textContent = activeConversation.otherUser.displayName;
  $('chatStatus').textContent = activeConversation.otherUser.online ? 'online' : 'offline';
  socket.emit('conversation:join', { conversationId: id });
  const data = await api(`/api/conversations/${id}/messages`);
  messages = data.messages;
  renderMessages();
  socket.emit('message:read', { conversationId: id });
  renderConversations();
}

$('backBtn').onclick = () => app.classList.remove('chat-open');

$('messageForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('messageInput').value.trim();
  if (!text || !activeConversation) return;
  $('messageInput').value = '';
  socket.emit('typing:stop', { conversationId: activeConversation.id });
  socket.emit('message:send', { conversationId: activeConversation.id, text }, (ack) => {
    if (!ack?.ok) alert(ack?.error || 'Could not send message');
  });
});

$('messageInput').addEventListener('input', () => {
  if (!activeConversation || !socket) return;
  socket.emit('typing:start', { conversationId: activeConversation.id });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    socket.emit('typing:stop', { conversationId: activeConversation.id });
  }, 900);
});

$('emojiBtn').onclick = () => {
  const input = $('messageInput');
  input.value += ' 🙂';
  input.focus();
};

function renderMessages() {
  const box = $('messages');
  box.innerHTML = '';
  messages.forEach(m => {
    const el = document.createElement('div');
    el.className = 'msg ' + (m.senderId === me.id ? 'me' : 'them');
    el.innerHTML = `${linkify(escapeHtml(m.text))}<div class="msg-time">${formatTime(m.createdAt)}${m.senderId === me.id ? ' ✓✓' : ''}</div>`;
    box.appendChild(el);
  });
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function linkify(text) {
  return text.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

(async function boot() {
  if (!token || !me) {
    authScreen.classList.remove('hidden');
    app.classList.add('hidden');
    return;
  }
  try {
    const data = await api('/api/me');
    me = data.user;
    localStorage.setItem('wc_user', JSON.stringify(me));
    startApp();
  } catch {
    localStorage.removeItem('wc_token');
    localStorage.removeItem('wc_user');
    authScreen.classList.remove('hidden');
    app.classList.add('hidden');
  }
})();
