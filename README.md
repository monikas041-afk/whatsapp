# WhatsClone - Socket.IO Account Chat

A WhatsApp-style chat app with Roblox-like accounts (usernames, not phone numbers), real-time private messaging, message history, online status, unread counts, and a modern responsive UI.

## Features

- Signup/login with username and password
- No phone numbers required
- Search users by username or display name
- Start one-to-one chats
- Real-time messaging using Socket.IO
- Message history saved in `data/db.json`
- Online/offline indicators
- Typing indicator
- Unread counts
- Works on desktop and mobile
- Ready for GitHub + Render deployment

## Run locally

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Deploy on Render

1. Create a GitHub repo and upload all these files.
2. Go to Render > New > Web Service.
3. Connect the GitHub repo.
4. Use these settings:
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Add environment variable:
   - `JWT_SECRET` = any long random secret text
6. Deploy.

## Keeping messages after Render restarts

Render free servers can restart/sleep. This app stores data in `data/db.json`. For serious use, add a Render persistent disk mounted to `/opt/render/project/src/data`, or replace the JSON database with PostgreSQL.

## First test

Create two accounts in two browser windows, search the other username, and chat.
