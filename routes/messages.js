const express = require('express');
const { db, id } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { triggerBotsForMessage } = require('../botEngine');

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
      `SELECT m.id, m.content, m.created_at, m.pinned_at, u.id as user_id, u.username, u.avatar_color, u.is_bot
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
    is_bot: 0,
  };

  const io = req.app.get('io');
  io.to(`channel:${channelId}`).emit('message:new', message);
  triggerBotsForMessage(io, channelId, String(content).trim());

  res.status(201).json({ message });
});

// Delete a message (author, or the server owner, can delete)
router.delete('/:messageId', (req, res) => {
  const { messageId } = req.params;
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!message) return res.status(404).json({ error: 'Message not found' });

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(message.channel_id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(channel.server_id);

  const isAuthor = message.user_id === req.userId;
  const isOwner = server && server.owner_id === req.userId;
  if (!isAuthor && !isOwner) return res.status(403).json({ error: 'You cannot delete this message' });

  db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);

  const io = req.app.get('io');
  io.to(`channel:${message.channel_id}`).emit('message:delete', { id: messageId, channelId: message.channel_id });

  res.json({ ok: true });
});

// Pin or unpin a message
router.post('/:messageId/pin', (req, res) => {
  const { messageId } = req.params;
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (!channelAccess(message.channel_id, req.userId)) {
    return res.status(403).json({ error: 'No access to this channel' });
  }

  const nowPinned = message.pinned_at ? null : Date.now();
  db.prepare('UPDATE messages SET pinned_at = ? WHERE id = ?').run(nowPinned, messageId);

  const io = req.app.get('io');
  io.to(`channel:${message.channel_id}`).emit('message:pin', {
    id: messageId,
    channelId: message.channel_id,
    pinnedAt: nowPinned,
  });

  res.json({ pinnedAt: nowPinned });
});

// Report a message to the server owner (visible via a simple query, no notification system yet)
router.post('/:messageId/report', (req, res) => {
  const { messageId } = req.params;
  const { reason } = req.body || {};
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (!channelAccess(message.channel_id, req.userId)) {
    return res.status(403).json({ error: 'No access to this channel' });
  }

  db.prepare(
    'INSERT INTO message_reports (id, message_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id(), messageId, req.userId, reason ? String(reason).slice(0, 500) : null, Date.now());

  res.status(201).json({ ok: true });
});

module.exports = router;
