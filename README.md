# Relay

A Discord-style chat app: accounts, servers, channels, and real-time text messaging.

## Stack
- **Backend:** Node.js + Express + Socket.io
- **Database:** SQLite (via better-sqlite3) — a single file, no separate DB server needed
- **Auth:** JWT tokens + bcrypt-hashed passwords
- **Frontend:** Plain HTML/CSS/JS (no build step)

## Features
- Register / log in with a username, email, and password
- Create servers, each auto-gets a `#general` channel
- Create additional text channels within a server
- Join servers via invite code
- Real-time messaging over WebSockets (Socket.io), with a REST fallback
- Member list per server, typing indicator, message history
- Right-click a message: reply, copy text/ID, pin/unpin, report, delete (own messages or server owner)
- 1-on-1 Direct Messages, independent of servers
- Create your own bots (no external API keys) — set trigger phrases and canned
  responses, install a bot into any channel you're a member of, and it
  auto-replies when a message contains one of its triggers

## Persisting data across deploys (important on Render)
Render's disk is wiped on every deploy unless you attach a **persistent disk**.
Without one, every redeploy erases all accounts, servers, and messages. Fix
this once:
1. Render dashboard → your service → **Disks** → Add Disk (e.g. mount path `/var/data`, 1&nbsp;GB is plenty).
2. Add an environment variable `DB_PATH=/var/data/relay.db`.
3. Redeploy. From then on the database survives deploys.

## Run it locally

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

By default it creates `relay.db` in the project folder and uses a dev JWT
secret. For anything beyond local testing, create a `.env` file:

```
JWT_SECRET=some-long-random-string
PORT=3000
```

## Deploying to Render

1. Push this folder to a GitHub repo.
2. In Render, create a **Web Service** from that repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. Add a **persistent disk** (e.g. mounted at `/var/data`) so your database
   survives restarts and deploys — Render's filesystem is otherwise ephemeral.
4. Set environment variables:
   - `JWT_SECRET` — a long random string
   - `DB_PATH` — e.g. `/var/data/relay.db` (matches your disk mount path)
5. Deploy. Socket.io works fine on Render's default HTTP(S) setup — no extra
   config needed.

## Project structure

```
server.js              Express app + Socket.io wiring
db.js                   SQLite schema + connection
middleware/auth.js       JWT verification
routes/auth.js           register / login / me
routes/servers.js        create / list / join / leave / delete servers
routes/channels.js       create / list / delete channels
routes/messages.js       message history + REST fallback for sending
public/                  frontend (index.html, css/, js/app.js)
```

## Notes / things you may want to extend
- Channel deletion and creation currently require server-owner or membership
  respectively — tighten roles further if you add moderators/admins.
- Messages aren't edited or deleted from the UI yet (DB supports it — you'd
  add routes + socket events).
- No file/image uploads yet — messages are text-only, as requested.
- No rate limiting on message sending — worth adding before a public launch.
