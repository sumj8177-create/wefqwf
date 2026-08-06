const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

// On Render, set DB_PATH to a file inside your persistent disk mount,
// e.g. /var/data/relay.db
const dbPath = process.env.DB_PATH || path.join(__dirname, 'relay.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color TEXT NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS server_members (
  server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  pinned_at INTEGER,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_reports (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bot_triggers (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  trigger_text TEXT NOT NULL,
  response_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bot_installs (
  bot_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, channel_id),
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dm_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dm_conversation ON dm_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bot_triggers_bot ON bot_triggers(bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_installs_channel ON bot_installs(channel_id);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id, position);
CREATE INDEX IF NOT EXISTS idx_members_user ON server_members(user_id);
`);

// Lightweight migration for databases created before is_bot existed
const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userCols.includes('is_bot')) {
  db.exec('ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0');
}

function conversationId(userIdA, userIdB) {
  return [userIdA, userIdB].sort().join(':');
}

// Lightweight migration for databases created before pinned_at existed
const messageCols = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
if (!messageCols.includes('pinned_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN pinned_at INTEGER');
}

function id() {
  return crypto.randomBytes(12).toString('hex');
}

function inviteCode() {
  return crypto.randomBytes(5).toString('hex');
}

module.exports = { db, id, inviteCode, conversationId };
