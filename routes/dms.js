const express = require('express');
const { prepare, id, conversationId } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// List DM conversations for the current user (most recent message first)
router.get('/', async (req, res, next) => {
  try {
    const rows = await prepare(
      `SELECT
         u.id as user_id, u.username, u.avatar_color,
         (SELECT content FROM dm_messages dm2
            WHERE dm2.conversation_id = dm.conversation_id
            ORDER BY dm2.created_at DESC LIMIT 1) as last_message,
         MAX(dm.created_at) as last_at
       FROM dm_messages dm
       JOIN users u ON u.id = (CASE WHEN dm.sender_id = ? THEN dm.recipient_id ELSE dm.sender_id END)
       WHERE dm.sender_id = ? OR dm.recipient_id = ?
       GROUP BY u.id
       ORDER BY last_at DESC`
    ).all(req.userId, req.userId, req.userId);
    res.json({ conversations: rows });
  } catch (err) {
    next(err);
  }
});

// Start (or just look up) a conversation by username
router.post('/start', async (req, res, next) => {
  try {
    const { username } = req.body || {};
    const clean = String(username || '').trim();
    if (!clean) return res.status(400).json({ error: 'Username is required' });

    const target = await prepare('SELECT id, username, avatar_color, is_bot FROM users WHERE username = ?').get(clean);
    if (!target) return res.status(404).json({ error: 'No user with that username' });
    if (target.id === req.userId) return res.status(400).json({ error: "You can't DM yourself" });
    if (target.is_bot) return res.status(400).json({ error: 'Bots only respond inside server channels, not DMs' });

    res.json({ user: { id: target.id, username: target.username, avatarColor: target.avatar_color } });
  } catch (err) {
    next(err);
  }
});

// Message history with a specific user
router.get('/:userId', async (req, res, next) => {
  try {
    const otherId = req.params.userId;
    const other = await prepare('SELECT id, username, avatar_color FROM users WHERE id = ?').get(otherId);
    if (!other) return res.status(404).json({ error: 'User not found' });

    const convId = conversationId(req.userId, otherId);
    const before = req.query.before ? Number(req.query.before) : Date.now() + 1;
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    const rows = await prepare(
      `SELECT dm.id, dm.content, dm.created_at, dm.sender_id,
              u.username, u.avatar_color
       FROM dm_messages dm
       JOIN users u ON u.id = dm.sender_id
       WHERE dm.conversation_id = ? AND dm.created_at < ?
       ORDER BY dm.created_at DESC
       LIMIT ?`
    ).all(convId, before, limit);

    res.json({ messages: rows.reverse(), user: { id: other.id, username: other.username, avatarColor: other.avatar_color } });
  } catch (err) {
    next(err);
  }
});

// Send a DM (REST fallback; sockets are the primary path)
router.post('/:userId', async (req, res, next) => {
  try {
    const otherId = req.params.userId;
    const { content } = req.body || {};
    const other = await prepare('SELECT id FROM users WHERE id = ?').get(otherId);
    if (!other) return res.status(404).json({ error: 'User not found' });
    if (otherId === req.userId) return res.status(400).json({ error: "You can't DM yourself" });
    if (!content || !String(content).trim()) return res.status(400).json({ error: 'Message content is required' });

    const messageId = id();
    const now = Date.now();
    const convId = conversationId(req.userId, otherId);
    await prepare(
      'INSERT INTO dm_messages (id, conversation_id, sender_id, recipient_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(messageId, convId, req.userId, otherId, String(content).trim(), now);

    const sender = await prepare('SELECT username, avatar_color FROM users WHERE id = ?').get(req.userId);
    const message = {
      id: messageId,
      conversationId: convId,
      content: String(content).trim(),
      created_at: now,
      sender_id: req.userId,
      username: sender.username,
      avatar_color: sender.avatar_color,
    };

    const io = req.app.get('io');
    io.to(`user:${otherId}`).to(`user:${req.userId}`).emit('dm:new', message);

    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
});

module.exports = router;