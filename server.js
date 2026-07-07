const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-this-before-deploy';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], conversations: [], messages: [] }, null, 2));
}

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    console.error('DB read error:', err);
    return { users: [], conversations: [], messages: [] };
  }
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar,
    about: user.about || 'Hey there! I am using WhatsClone.',
    createdAt: user.createdAt
  };
}

function createToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

function authFromReq(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function findConversation(db, userA, userB) {
  return db.conversations.find(c => c.members.includes(userA) && c.members.includes(userB));
}

function getOrCreateConversation(db, userA, userB) {
  let convo = findConversation(db, userA, userB);
  if (!convo) {
    convo = {
      id: cryptoRandomId('c'),
      members: [userA, userB],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.conversations.push(convo);
  }
  return convo;
}

function cryptoRandomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const onlineUsers = new Map(); // userId -> socketId set

function isOnline(userId) {
  return onlineUsers.has(userId) && onlineUsers.get(userId).size > 0;
}

function emitPresence(userId, online) {
  io.emit('presence:update', { userId, online });
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/signup', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const displayName = String(req.body.displayName || '').trim();
  const password = String(req.body.password || '');

  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters: lowercase letters, numbers, underscore only.' });
  }
  if (displayName.length < 2 || displayName.length > 32) {
    return res.status(400).json({ error: 'Display name must be 2-32 characters.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const db = readDb();
  if (db.users.some(u => u.username === username)) {
    return res.status(409).json({ error: 'Username already taken.' });
  }

  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: cryptoRandomId('u'),
    username,
    displayName,
    passwordHash: hash,
    avatar: displayName.slice(0, 1).toUpperCase(),
    about: 'Hey there! I am using WhatsClone.',
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  writeDb(db);

  res.json({ token: createToken(user), user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const db = readDb();
  const user = db.users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'Wrong username or password.' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: createToken(user), user: publicUser(user) });
});

app.get('/api/me', authFromReq, (req, res) => {
  const db = readDb();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

app.get('/api/users/search', authFromReq, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ users: [] });
  const db = readDb();
  const users = db.users
    .filter(u => u.id !== req.user.id)
    .filter(u => u.username.includes(q) || u.displayName.toLowerCase().includes(q))
    .slice(0, 20)
    .map(u => ({ ...publicUser(u), online: isOnline(u.id) }));
  res.json({ users });
});

app.post('/api/conversations/start', authFromReq, (req, res) => {
  const otherUserId = String(req.body.userId || '');
  const db = readDb();
  const me = db.users.find(u => u.id === req.user.id);
  const other = db.users.find(u => u.id === otherUserId);
  if (!me || !other) return res.status(404).json({ error: 'User not found' });
  const convo = getOrCreateConversation(db, me.id, other.id);
  writeDb(db);
  res.json({ conversation: formatConversation(db, convo, me.id) });
});

app.get('/api/conversations', authFromReq, (req, res) => {
  const db = readDb();
  const list = db.conversations
    .filter(c => c.members.includes(req.user.id))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(c => formatConversation(db, c, req.user.id));
  res.json({ conversations: list });
});

app.get('/api/conversations/:id/messages', authFromReq, (req, res) => {
  const db = readDb();
  const convo = db.conversations.find(c => c.id === req.params.id && c.members.includes(req.user.id));
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });
  const messages = db.messages
    .filter(m => m.conversationId === convo.id)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json({ messages });
});

function formatConversation(db, convo, myId) {
  const otherId = convo.members.find(id => id !== myId);
  const other = db.users.find(u => u.id === otherId);
  const convoMessages = db.messages.filter(m => m.conversationId === convo.id);
  const lastMessage = convoMessages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  const unread = convoMessages.filter(m => m.senderId !== myId && !m.readBy.includes(myId)).length;
  return {
    id: convo.id,
    otherUser: { ...publicUser(other), online: isOnline(otherId) },
    lastMessage,
    unread,
    updatedAt: convo.updatedAt
  };
}

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Missing token'));
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socket.id);
  socket.join(`user:${userId}`);
  emitPresence(userId, true);

  socket.on('conversation:join', ({ conversationId }) => {
    const db = readDb();
    const convo = db.conversations.find(c => c.id === conversationId && c.members.includes(userId));
    if (convo) socket.join(`conversation:${conversationId}`);
  });

  socket.on('message:send', ({ conversationId, text }, ack) => {
    const safeText = String(text || '').trim();
    if (!safeText || safeText.length > 2000) {
      if (ack) ack({ ok: false, error: 'Message must be 1-2000 characters.' });
      return;
    }
    const db = readDb();
    const convo = db.conversations.find(c => c.id === conversationId && c.members.includes(userId));
    if (!convo) {
      if (ack) ack({ ok: false, error: 'Conversation not found.' });
      return;
    }
    const message = {
      id: cryptoRandomId('m'),
      conversationId,
      senderId: userId,
      text: safeText,
      readBy: [userId],
      createdAt: new Date().toISOString()
    };
    db.messages.push(message);
    convo.updatedAt = message.createdAt;
    writeDb(db);

    io.to(`conversation:${conversationId}`).emit('message:new', message);
    for (const member of convo.members) io.to(`user:${member}`).emit('conversation:updated', { conversationId });
    if (ack) ack({ ok: true, message });
  });

  socket.on('message:read', ({ conversationId }) => {
    const db = readDb();
    const convo = db.conversations.find(c => c.id === conversationId && c.members.includes(userId));
    if (!convo) return;
    let changed = false;
    for (const msg of db.messages.filter(m => m.conversationId === conversationId)) {
      if (!msg.readBy.includes(userId)) {
        msg.readBy.push(userId);
        changed = true;
      }
    }
    if (changed) writeDb(db);
    for (const member of convo.members) io.to(`user:${member}`).emit('conversation:updated', { conversationId });
  });

  socket.on('typing:start', ({ conversationId }) => {
    socket.to(`conversation:${conversationId}`).emit('typing:update', { conversationId, userId, typing: true });
  });

  socket.on('typing:stop', ({ conversationId }) => {
    socket.to(`conversation:${conversationId}`).emit('typing:update', { conversationId, userId, typing: false });
  });

  socket.on('disconnect', () => {
    const sockets = onlineUsers.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        onlineUsers.delete(userId);
        emitPresence(userId, false);
      }
    }
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => console.log(`WhatsClone running on port ${PORT}`));
