# Relay

A Discord-style chat app: accounts, servers, channels, DMs, bots, and real-time text messaging.

## Stack
- **Backend:** Node.js + Express + Socket.io
- **Database:** SQLite-compatible via [Turso](https://turso.tech) (libSQL) — free, persists forever, works fine on Render's free plan. Falls back to a local SQLite file automatically when no Turso credentials are set, so `npm start` just works for local dev.
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
- Create your own bots (no external API keys, no real Discord account needed)
  at `/bots` — set trigger phrases and canned responses, install a bot into
  any channel you're a member of, and it auto-replies when a message
  contains one of its triggers

## ⚠️ Persisting data across deploys — important, especially on a free plan

**If you're on Render's free plan:** free web services can't attach a
persistent disk at all (that's paid-tier only), and Render's own free
Postgres expires after 30 days. So the fix here is to point the app at
[Turso](https://turso.tech) — a free, SQLite-compatible database that lives
outside Render entirely and never expires:

1. Sign up at [turso.tech](https://turso.tech) (free, no credit card).
2. Install the CLI and create a database:
   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   turso auth login
   turso db create relay
   turso db show relay --url
   turso db tokens create relay
   ```
3. In Render → your service → **Environment**, add:
   - `TURSO_DATABASE_URL` — the URL from `turso db show`
   - `TURSO_AUTH_TOKEN` — the token from `turso db tokens create`
   - `JWT_SECRET` — any long random string (otherwise logins also reset on every redeploy)
4. Redeploy. From then on, accounts/servers/messages/bots survive every
   future push, restart, or free-tier spin-down — permanently, not just for
   30 days.

**If you're on a paid Render plan** and would rather use Render's own
storage, you can skip Turso entirely: attach a **persistent disk** (Disks →
Add Disk, e.g. `/var/data`) and set `DB_PATH=/var/data/relay.db` — the app
also understands `DB_PATH` and will use a local file there instead. Either
approach works; Turso is simply the one that works on the free plan too.

## Run it locally

```bash
npm install
npm start
```

Then open **http://localhost:3000**. With no `TURSO_DATABASE_URL` set, it
automatically uses a local `relay.db` file — no external account needed for
local development.

For anything beyond quick local testing, create a `.env` file:

```
JWT_SECRET=some-long-random-string
PORT=3000
# Optional — only needed to test against a real Turso database locally too:
TURSO_DATABASE_URL=libsql://your-db-name.turso.io
TURSO_AUTH_TOKEN=your-token
```

## Deploying to Render

1. Push this folder to a GitHub repo.
2. In Render, create a **Web Service** from that repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. Set environment variables (see the Turso section above):
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `JWT_SECRET` — a long random string
4. Deploy. Socket.io works fine on Render's default HTTP(S) setup — no extra
   config needed. Render's free tier does spin down after 15 minutes of
   inactivity (cold start on the next request) — that's normal and doesn't
   affect your data now that it lives on Turso, not Render's disk.

## Project structure

```
server.js              Express app + Socket.io wiring
db.js                   Database connection (Turso/libSQL) + schema
botEngine.js            Keyword-trigger bot response logic
middleware/auth.js       JWT verification
routes/auth.js           register / login / me
routes/servers.js        create / list / join / leave / delete servers
routes/channels.js       create / list / delete channels
routes/messages.js       message history, pin/delete/report, REST fallback for sending
routes/dms.js            direct message conversations and history
routes/bots.js           create bots, manage triggers, install into channels
public/                  frontend (index.html, css/, js/app.js)
```

## Notes / things you may want to extend
- Channel deletion and creation currently require server-owner or membership
  respectively — tighten roles further if you add moderators/admins.
- No file/image uploads yet — messages are text-only, as requested.
- No rate limiting on message sending — worth adding before a public launch.
- Bots are simple keyword-matchers, not real AI — wiring one up to an LLM
  API would be a natural next step if you want smarter replies.
