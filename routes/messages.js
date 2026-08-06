const express = require('express');
const { db, id } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function channelAccess(channelId, userId) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return null;
  const member = db
    .prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?')
    .get(channel.server_id, userId);
  return member ? channel : null;
}

// Get message history for a channel (paginated via `before` timestamp)
router.get('/:channelId', (req, res) => {
  const { channelId } = req.params;
  const before = req.query.before ? Number(req.query.before) : Date.now() + 1;
  const limit = Math.min(Number(req.query.limit) || 50, 100);

  if (!channelAccess(channelId, req.userId)) {
    return res.status(403).json({ error: 'No access to this channel' });
  }

  const rows = db
    .prepare(
      `SELECT m.id, m.content, m.created_at, u.id as user_id, u.username, u.avatar_color
       FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.channel_id = ? AND m.created_at < ?
       ORDER BY m.created_at DESC
       LIMIT ?`
    )
    .all(channelId, before, limit);

  res.json({ messages: rows.reverse() });
});

// Post a message (also used as a fallback if the client isn't using sockets)
router.post('/:channelId', (req, res) => {
  const { channelId } = req.params;
  const { content } = req.body || {};

  const channel = channelAccess(channelId, req.userId);
  if (!channel) return res.status(403).json({ error: 'No access to this channel' });
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'Message content is required' });
  if (String(content).length > 4000) return res.status(400).json({ error: 'Message is too long' });

  const messageId = id();
  const now = Date.now();
  db.prepare(
    'INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(messageId, channelId, req.userId, String(content).trim(), now);

  const user = db.prepare('SELECT username, avatar_color FROM users WHERE id = ?').get(req.userId);
  const message = {
    id: messageId,
    channel_id: channelId,
    content: String(content).trim(),
    created_at: now,
    user_id: req.userId,
    username: user.username,
    avatar_color: user.avatar_color,
  };

  const io = req.app.get('io');
  io.to(`channel:${channelId}`).emit('message:new', message);

  res.status(201).json({ message });
});

module.exports = router;
