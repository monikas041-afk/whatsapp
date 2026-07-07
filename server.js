const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret";
const DB_FILE = path.join(__dirname, "db.json");

app.use(express.json());

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], messages: [] }, null, 2));
    }

    const raw = fs.readFileSync(DB_FILE, "utf8").trim();

    if (!raw) {
      return { users: [], messages: [] };
    }

    const db = JSON.parse(raw);
    db.users = db.users || [];
    db.messages = db.messages || [];
    return db;
  } catch (err) {
    console.error("DB read error:", err);
    return { users: [], messages: [] };
  }
}

function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function safeUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    about: user.about || "Hey there! I am using WhatsClone.",
    createdAt: user.createdAt
  };
}

function authFromHeader(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.replace("Bearer ", "");

  if (!token) {
    return res.status(401).json({ error: "No token" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

app.get("/", (req, res) => {
  res.send(html);
});

app.post("/api/signup", async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const displayName = String(req.body.displayName || "").trim();
  const password = String(req.body.password || "");

  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: "Username must be 3-20 letters, numbers, or underscores only." });
  }

  if (displayName.length < 2 || displayName.length > 30) {
    return res.status(400).json({ error: "Display name must be 2-30 characters." });
  }

  if (password.length < 4) {
    return res.status(400).json({ error: "Password must be at least 4 characters." });
  }

  const db = readDB();

  if (db.users.some(u => u.username === username)) {
    return res.status(400).json({ error: "Username already taken." });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = {
    id: makeId(),
    username,
    displayName,
    passwordHash,
    about: "Hey there! I am using WhatsClone.",
    createdAt: Date.now()
  };

  db.users.push(user);
  writeDB(db);

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });

  res.json({ token, user: safeUser(user) });
});

app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  const db = readDB();
  const user = db.users.find(u => u.username === username);

  if (!user) {
    return res.status(400).json({ error: "Wrong username or password." });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);

  if (!ok) {
    return res.status(400).json({ error: "Wrong username or password." });
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });

  res.json({ token, user: safeUser(user) });
});

app.get("/api/me", authFromHeader, (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.id === req.user.id);

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  res.json({ user: safeUser(user) });
});

app.get("/api/users", authFromHeader, (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const db = readDB();

  const users = db.users
    .filter(u => u.id !== req.user.id)
    .filter(u => !q || u.username.includes(q) || u.displayName.toLowerCase().includes(q))
    .map(safeUser);

  res.json({ users });
});

app.get("/api/messages/:userId", authFromHeader, (req, res) => {
  const otherId = req.params.userId;
  const me = req.user.id;
  const db = readDB();

  const messages = db.messages
    .filter(m => {
      return (m.from === me && m.to === otherId) || (m.from === otherId && m.to === me);
    })
    .sort((a, b) => a.createdAt - b.createdAt);

  res.json({ messages });
});

const onlineUsers = new Map();

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    const user = jwt.verify(token, JWT_SECRET);
    socket.user = user;
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});

io.on("connection", socket => {
  onlineUsers.set(socket.user.id, socket.id);
  socket.join(socket.user.id);

  io.emit("onlineUsers", Array.from(onlineUsers.keys()));

  socket.on("sendMessage", data => {
    const text = String(data.text || "").trim();
    const to = String(data.to || "").trim();

    if (!text || !to || text.length > 1000) {
      return;
    }

    const db = readDB();

    const receiverExists = db.users.some(u => u.id === to);
    if (!receiverExists) {
      return;
    }

    const message = {
      id: makeId(),
      from: socket.user.id,
      to,
      text,
      createdAt: Date.now(),
      seen: false
    };

    db.messages.push(message);
    writeDB(db);

    io.to(socket.user.id).emit("newMessage", message);
    io.to(to).emit("newMessage", message);
  });

  socket.on("typing", data => {
    const to = String(data.to || "");
    socket.to(to).emit("typing", { from: socket.user.id });
  });

  socket.on("disconnect", () => {
    onlineUsers.delete(socket.user.id);
    io.emit("onlineUsers", Array.from(onlineUsers.keys()));
  });
});

server.listen(PORT, () => {
  console.log("WhatsClone running on port " + PORT);
});

const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>WhatsClone</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #0b141a;
      color: white;
      height: 100vh;
      overflow: hidden;
    }

    .auth-screen {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background:
        radial-gradient(circle at top left, #00a88455, transparent 30%),
        radial-gradient(circle at bottom right, #25d36633, transparent 30%),
        #0b141a;
      padding: 20px;
    }

    .auth-box {
      width: 100%;
      max-width: 420px;
      background: #111b21;
      border: 1px solid #26343b;
      border-radius: 22px;
      padding: 28px;
      box-shadow: 0 20px 60px #0008;
    }

    .logo {
      width: 60px;
      height: 60px;
      background: linear-gradient(135deg, #25d366, #00a884);
      border-radius: 18px;
      display: grid;
      place-items: center;
      font-size: 30px;
      margin-bottom: 15px;
    }

    h1 {
      margin: 0 0 8px;
      font-size: 30px;
    }

    .muted {
      color: #8696a0;
      font-size: 14px;
    }

    input {
      width: 100%;
      padding: 14px;
      border-radius: 13px;
      border: 1px solid #2a3942;
      background: #202c33;
      color: white;
      outline: none;
      margin-top: 12px;
      font-size: 15px;
    }

    button {
      border: 0;
      border-radius: 13px;
      padding: 13px 16px;
      cursor: pointer;
      font-weight: 700;
      background: #00a884;
      color: #07120f;
      font-size: 15px;
    }

    .full-btn {
      width: 100%;
      margin-top: 14px;
    }

    .switch {
      color: #00a884;
      cursor: pointer;
      font-weight: bold;
    }

    .error {
      color: #ff8a8a;
      min-height: 20px;
      margin-top: 10px;
      font-size: 14px;
    }

    .app {
      height: 100vh;
      display: none;
      background: #0b141a;
    }

    .sidebar {
      width: 360px;
      background: #111b21;
      border-right: 1px solid #26343b;
      display: flex;
      flex-direction: column;
    }

    .side-header, .chat-header {
      height: 66px;
      background: #202c33;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
    }

    .avatar {
      width: 42px;
      height: 42px;
      border-radius: 50%;
      background: linear-gradient(135deg, #00a884, #25d366);
      display: grid;
      place-items: center;
      color: #04251e;
      font-weight: 900;
      flex-shrink: 0;
    }

    .user-title {
      font-weight: bold;
    }

    .small {
      font-size: 12px;
      color: #8696a0;
      margin-top: 2px;
    }

    .logout {
      margin-left: auto;
      background: #2a3942;
      color: white;
      padding: 9px 10px;
      font-size: 12px;
    }

    .search {
      padding: 10px;
      background: #111b21;
    }

    .search input {
      margin: 0;
      background: #202c33;
      border-radius: 10px;
    }

    .user-list {
      overflow: auto;
      flex: 1;
    }

    .user-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 13px 16px;
      border-bottom: 1px solid #1f2c33;
      cursor: pointer;
    }

    .user-row:hover, .user-row.active {
      background: #202c33;
    }

    .main {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .empty-chat {
      flex: 1;
      display: grid;
      place-items: center;
      text-align: center;
      color: #8696a0;
      padding: 30px;
    }

    .messages {
      flex: 1;
      overflow: auto;
      padding: 20px;
      background:
        linear-gradient(#0b141acc, #0b141acc),
        radial-gradient(circle at top, #00a88422, transparent 35%);
      display: none;
      flex-direction: column;
      gap: 8px;
    }

    .bubble {
      max-width: 70%;
      padding: 9px 12px;
      border-radius: 12px;
      line-height: 1.35;
      word-wrap: break-word;
      position: relative;
    }

    .mine {
      background: #005c4b;
      align-self: flex-end;
      border-top-right-radius: 4px;
    }

    .theirs {
      background: #202c33;
      align-self: flex-start;
      border-top-left-radius: 4px;
    }

    .time {
      font-size: 10px;
      color: #cfd7d380;
      text-align: right;
      margin-top: 4px;
    }

    .composer {
      height: 70px;
      display: none;
      align-items: center;
      gap: 10px;
      padding: 10px;
      background: #202c33;
    }

    .composer input {
      margin: 0;
      border-radius: 999px;
    }

    .send {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      padding: 0;
      font-size: 20px;
    }

    .typing {
      color: #25d366;
      font-size: 12px;
      display: none;
    }

    @media (max-width: 760px) {
      .sidebar {
        width: 100%;
      }

      .main {
        display: none;
      }

      .app.chat-open .sidebar {
        display: none;
      }

      .app.chat-open .main {
        display: flex;
      }

      .back {
        display: block !important;
      }
    }

    .back {
      display: none;
      background: transparent;
      color: white;
      font-size: 22px;
      padding: 5px;
    }
  </style>
</head>

<body>
  <div class="auth-screen" id="authScreen">
    <div class="auth-box">
      <div class="logo">💬</div>
      <h1>WhatsClone</h1>
      <div class="muted">Chat with username accounts, Roblox-style. No phone number needed.</div>

      <input id="displayName" placeholder="Display name" />
      <input id="username" placeholder="Username" />
      <input id="password" placeholder="Password" type="password" />

      <button class="full-btn" onclick="submitAuth()" id="authBtn">Create account</button>

      <div class="error" id="authError"></div>

      <p class="muted">
        <span id="switchText">Already have an account?</span>
        <span class="switch" onclick="toggleAuth()" id="switchBtn">Login</span>
      </p>
    </div>
  </div>

  <div class="app" id="app">
    <div class="sidebar">
      <div class="side-header">
        <div class="avatar" id="myAvatar">U</div>
        <div>
          <div class="user-title" id="myName">User</div>
          <div class="small" id="myUsername">@user</div>
        </div>
        <button class="logout" onclick="logout()">Logout</button>
      </div>

      <div class="search">
        <input id="searchBox" placeholder="Search username..." oninput="loadUsers()" />
      </div>

      <div class="user-list" id="userList"></div>
    </div>

    <div class="main">
      <div class="chat-header" id="chatHeader" style="display:none;">
        <button class="back" onclick="closeChat()">‹</button>
        <div class="avatar" id="chatAvatar">U</div>
        <div>
          <div class="user-title" id="chatName">Select a user</div>
          <div class="small" id="chatStatus">offline</div>
          <div class="typing" id="typing">typing...</div>
        </div>
      </div>

      <div class="empty-chat" id="emptyChat">
        <div>
          <h2>WhatsClone Web</h2>
          <p>Search a user from the left side and start chatting.</p>
        </div>
      </div>

      <div class="messages" id="messages"></div>

      <div class="composer" id="composer">
        <input id="messageInput" placeholder="Type a message..." onkeydown="handleTyping(event)" />
        <button class="send" onclick="sendMessage()">➤</button>
      </div>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>

  <script>
    let isLogin = false;
    let token = localStorage.getItem("token");
    let me = null;
    let socket = null;
    let users = [];
    let selectedUser = null;
    let currentMessages = [];
    let onlineUsers = [];
    let typingTimer = null;

    const authScreen = document.getElementById("authScreen");
    const app = document.getElementById("app");

    function avatarText(name) {
      return String(name || "U").charAt(0).toUpperCase();
    }

    function timeText(ts) {
      return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    async function api(url, options = {}) {
      options.headers = options.headers || {};
      options.headers["Content-Type"] = "application/json";

      if (token) {
        options.headers.Authorization = "Bearer " + token;
      }

      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || "Something went wrong");
      }

      return data;
    }

    function toggleAuth() {
      isLogin = !isLogin;

      document.getElementById("displayName").style.display = isLogin ? "none" : "block";
      document.getElementById("authBtn").textContent = isLogin ? "Login" : "Create account";
      document.getElementById("switchText").textContent = isLogin ? "New here?" : "Already have an account?";
      document.getElementById("switchBtn").textContent = isLogin ? "Create account" : "Login";
      document.getElementById("authError").textContent = "";
    }

    async function submitAuth() {
      const username = document.getElementById("username").value.trim();
      const password = document.getElementById("password").value;
      const displayName = document.getElementById("displayName").value.trim();
      const error = document.getElementById("authError");

      error.textContent = "";

      try {
        const endpoint = isLogin ? "/api/login" : "/api/signup";
        const body = isLogin ? { username, password } : { username, password, displayName };

        const data = await api(endpoint, {
          method: "POST",
          body: JSON.stringify(body)
        });

        token = data.token;
        me = data.user;
        localStorage.setItem("token", token);
        startApp();
      } catch (err) {
        error.textContent = err.message;
      }
    }

    async function startApp() {
      try {
        if (!me) {
          const data = await api("/api/me");
          me = data.user;
        }

        authScreen.style.display = "none";
        app.style.display = "flex";

        document.getElementById("myName").textContent = me.displayName;
        document.getElementById("myUsername").textContent = "@" + me.username;
        document.getElementById("myAvatar").textContent = avatarText(me.displayName);

        connectSocket();
        loadUsers();
      } catch {
        logout();
      }
    }

    function connectSocket() {
      socket = io({
        auth: { token }
      });

      socket.on("onlineUsers", ids => {
        onlineUsers = ids;
        renderUsers();
        updateChatHeader();
      });

      socket.on("newMessage", msg => {
        if (selectedUser && (msg.from === selectedUser.id || msg.to === selectedUser.id)) {
          currentMessages.push(msg);
          renderMessages();
        }
      });

      socket.on("typing", data => {
        if (selectedUser && data.from === selectedUser.id) {
          const typing = document.getElementById("typing");
          typing.style.display = "block";
          clearTimeout(typingTimer);
          typingTimer = setTimeout(() => {
            typing.style.display = "none";
          }, 1000);
        }
      });
    }

    async function loadUsers() {
      const q = document.getElementById("searchBox").value.trim();

      try {
        const data = await api("/api/users?q=" + encodeURIComponent(q));
        users = data.users;
        renderUsers();
      } catch {}
    }

    function renderUsers() {
      const box = document.getElementById("userList");
      box.innerHTML = "";

      if (!users.length) {
        box.innerHTML = '<div class="small" style="padding:20px;">No users found. Create another account in another browser/device to test chat.</div>';
        return;
      }

      users.forEach(user => {
        const div = document.createElement("div");
        div.className = "user-row" + (selectedUser && selectedUser.id === user.id ? " active" : "");
        div.onclick = () => openChat(user);

        const online = onlineUsers.includes(user.id);

        div.innerHTML = \`
          <div class="avatar">\${avatarText(user.displayName)}</div>
          <div style="min-width:0;">
            <div class="user-title">\${escapeHtml(user.displayName)}</div>
            <div class="small">@\${escapeHtml(user.username)} • \${online ? "online" : "offline"}</div>
          </div>
        \`;

        box.appendChild(div);
      });
    }

    async function openChat(user) {
      selectedUser = user;
      app.classList.add("chat-open");

      document.getElementById("emptyChat").style.display = "none";
      document.getElementById("chatHeader").style.display = "flex";
      document.getElementById("messages").style.display = "flex";
      document.getElementById("composer").style.display = "flex";

      updateChatHeader();
      renderUsers();

      const data = await api("/api/messages/" + user.id);
      currentMessages = data.messages;
      renderMessages();
    }

    function closeChat() {
      app.classList.remove("chat-open");
    }

    function updateChatHeader() {
      if (!selectedUser) return;

      document.getElementById("chatAvatar").textContent = avatarText(selectedUser.displayName);
      document.getElementById("chatName").textContent = selectedUser.displayName;
      document.getElementById("chatStatus").textContent = onlineUsers.includes(selectedUser.id) ? "online" : "offline";
    }

    function renderMessages() {
      const box = document.getElementById("messages");
      box.innerHTML = "";

      currentMessages.forEach(msg => {
        const div = document.createElement("div");
        const mine = msg.from === me.id;

        div.className = "bubble " + (mine ? "mine" : "theirs");
        div.innerHTML = \`
          <div>\${escapeHtml(msg.text)}</div>
          <div class="time">\${timeText(msg.createdAt)}</div>
        \`;

        box.appendChild(div);
      });

      box.scrollTop = box.scrollHeight;
    }

    function sendMessage() {
      const input = document.getElementById("messageInput");
      const text = input.value.trim();

      if (!text || !selectedUser) return;

      socket.emit("sendMessage", {
        to: selectedUser.id,
        text
      });

      input.value = "";
    }

    function handleTyping(event) {
      if (event.key === "Enter") {
        sendMessage();
        return;
      }

      if (selectedUser && socket) {
        socket.emit("typing", { to: selectedUser.id });
      }
    }

    function logout() {
      localStorage.removeItem("token");
      token = null;
      me = null;

      if (socket) {
        socket.disconnect();
      }

      location.reload();
    }

    function escapeHtml(str) {
      return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    if (token) {
      startApp();
    }
  </script>
</body>
</html>
`;
