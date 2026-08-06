const express = require('express');
const { db, id } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function isMember(serverId, userId) {
  return db
    .prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?')
    .get(serverId, userId);
}

// List channels in a server
router.get('/server/:serverId', (req, res) => {
  const { serverId } = req.params;
  if (!isMember(serverId, req.userId)) return res.status(403).json({ error: 'Not a member of this server' });

  const channels = db
    .prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position ASC, created_at ASC')
    .all(serverId);
  res.json({ channels });
});

// Create a channel in a server
router.post('/server/:serverId', (req, res) => {
  const { serverId } = req.params;
  const { name } = req.body || {};
  if (!isMember(serverId, req.userId)) return res.status(403).json({ error: 'Not a member of this server' });
  if (!name || String(name).trim().length < 1) {
    return res.status(400).json({ error: 'Channel name is required' });
  }
  const cleanName = String(name).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
  if (!cleanName) return res.status(400).json({ error: 'Channel name is invalid' });

  const maxPos = db
    .prepare('SELECT COALESCE(MAX(position), -1) as maxPos FROM channels WHERE server_id = ?')
    .get(serverId).maxPos;

  const channelId = id();
  const now = Date.now();
  db.prepare(
    'INSERT INTO channels (id, server_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(channelId, serverId, cleanName, maxPos + 1, now);

  res.status(201).json({ channel: { id: channelId, server_id: serverId, name: cleanName, position: maxPos + 1, created_at: now } });
});

// Delete a channel (any member for simplicity; tighten to owner/admin if desired)
router.delete('/:channelId', (req, res) => {
  const { channelId } = req.params;
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!isMember(channel.server_id, req.userId)) return res.status(403).json({ error: 'Not a member of this server' });

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(channel.server_id);
  if (server.owner_id !== req.userId) return res.status(403).json({ error: 'Only the owner can delete channels' });

  db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
  res.json({ ok: true });
});

module.exports = router;
