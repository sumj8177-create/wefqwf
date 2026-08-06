const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db, id } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const BOT_AVATAR_COLORS = ['#3ECF8E', '#7C5CFF', '#FF8A5C', '#4BC6FF'];

function isChannelMember(channelId, userId) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return null;
  const member = db
    .prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?')
    .get(channel.server_id, userId);
  return member ? channel : null;
}

function botWithTriggers(botRow) {
  const triggers = db
    .prepare('SELECT id, trigger_text, response_text FROM bot_triggers WHERE bot_id = ? ORDER BY created_at ASC')
    .all(botRow.id);
  const installs = db
    .prepare('SELECT channel_id FROM bot_installs WHERE bot_id = ?')
    .all(botRow.id)
    .map((r) => r.channel_id);
  return {
    id: botRow.id,
    name: botRow.username,
    avatarColor: botRow.avatar_color,
    createdAt: botRow.created_at,
    triggers,
    installedChannels: installs,
  };
}

// List bots the current user owns
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT b.id, b.created_at, u.username, u.avatar_color
       FROM bots b JOIN users u ON u.id = b.user_id
       WHERE b.owner_id = ?
       ORDER BY b.created_at ASC`
    )
    .all(req.userId);
  res.json({ bots: rows.map(botWithTriggers) });
});

// Create a bot
router.post('/', (req, res) => {
  const { name } = req.body || {};
  const cleanName = String(name || '').trim();
  if (cleanName.length < 3 || cleanName.length > 32) {
    return res.status(400).json({ error: 'Bot name must be 3-32 characters' });
  }
  if (!/^[a-zA-Z0-9_. ]+$/.test(cleanName)) {
    return res.status(400).json({ error: 'Bot name has invalid characters' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanName);
  if (existing) return res.status(409).json({ error: 'That name is already taken' });

  const botUserId = id();
  const botId = id();
  const now = Date.now();
  const avatarColor = BOT_AVATAR_COLORS[Math.floor(Math.random() * BOT_AVATAR_COLORS.length)];
  // Bots don't log in, so give them an unusable random password hash and a placeholder email.
  const unusableHash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);

  const tx = db.transaction(() => {
    db.prepare(
      'INSERT INTO users (id, username, email, password_hash, avatar_color, is_bot, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
    ).run(botUserId, cleanName, `bot-${botUserId}@relay.local`, unusableHash, avatarColor, now);

    db.prepare(
      'INSERT INTO bots (id, user_id, owner_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(botId, botUserId, req.userId, now);
  });
  tx();

  const botRow = { id: botId, username: cleanName, avatar_color: avatarColor, created_at: now };
  res.status(201).json({ bot: botWithTriggers(botRow) });
});

function ownedBot(botId, ownerId) {
  return db.prepare('SELECT * FROM bots WHERE id = ? AND owner_id = ?').get(botId, ownerId);
}

// Delete a bot
router.delete('/:botId', (req, res) => {
  const bot = ownedBot(req.params.botId, req.userId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  db.prepare('DELETE FROM users WHERE id = ?').run(bot.user_id); // cascades to bots, triggers, installs, messages
  res.json({ ok: true });
});

// Add a trigger/response pair
router.post('/:botId/triggers', (req, res) => {
  const bot = ownedBot(req.params.botId, req.userId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });

  const { trigger, response } = req.body || {};
  const cleanTrigger = String(trigger || '').trim().toLowerCase();
  const cleanResponse = String(response || '').trim();
  if (!cleanTrigger || cleanTrigger.length > 100) {
    return res.status(400).json({ error: 'Trigger must be 1-100 characters' });
  }
  if (!cleanResponse || cleanResponse.length > 2000) {
    return res.status(400).json({ error: 'Response must be 1-2000 characters' });
  }

  const triggerId = id();
  db.prepare(
    'INSERT INTO bot_triggers (id, bot_id, trigger_text, response_text, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(triggerId, bot.id, cleanTrigger, cleanResponse, Date.now());

  res.status(201).json({ trigger: { id: triggerId, trigger_text: cleanTrigger, response_text: cleanResponse } });
});

// Remove a trigger
router.delete('/:botId/triggers/:triggerId', (req, res) => {
  const bot = ownedBot(req.params.botId, req.userId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  db.prepare('DELETE FROM bot_triggers WHERE id = ? AND bot_id = ?').run(req.params.triggerId, bot.id);
  res.json({ ok: true });
});

// Install a bot into a channel (must be a member of that channel's server)
router.post('/:botId/install', (req, res) => {
  const bot = ownedBot(req.params.botId, req.userId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });

  const { channelId } = req.body || {};
  const channel = isChannelMember(channelId, req.userId);
  if (!channel) return res.status(403).json({ error: 'No access to this channel' });

  db.prepare(
    'INSERT OR IGNORE INTO bot_installs (bot_id, channel_id, installed_at) VALUES (?, ?, ?)'
  ).run(bot.id, channelId, Date.now());

  res.status(201).json({ ok: true });
});

// Remove a bot from a channel
router.delete('/:botId/install/:channelId', (req, res) => {
  const bot = ownedBot(req.params.botId, req.userId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  db.prepare('DELETE FROM bot_installs WHERE bot_id = ? AND channel_id = ?').run(bot.id, req.params.channelId);
  res.json({ ok: true });
});

module.exports = router;
