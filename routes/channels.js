const express = require('express');
const { prepare, id } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function isMember(serverId, userId) {
  return prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}

// List channels in a server
router.get('/server/:serverId', async (req, res, next) => {
  try {
    const { serverId } = req.params;
    if (!(await isMember(serverId, req.userId))) return res.status(403).json({ error: 'Not a member of this server' });

    const channels = await prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position ASC, created_at ASC').all(serverId);
    res.json({ channels });
  } catch (err) {
    next(err);
  }
});

// Create a channel in a server
router.post('/server/:serverId', async (req, res, next) => {
  try {
    const { serverId } = req.params;
    const { name } = req.body || {};
    if (!(await isMember(serverId, req.userId))) return res.status(403).json({ error: 'Not a member of this server' });
    if (!name || String(name).trim().length < 1) {
      return res.status(400).json({ error: 'Channel name is required' });
    }
    const cleanName = String(name).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
    if (!cleanName) return res.status(400).json({ error: 'Channel name is invalid' });

    const maxRow = await prepare('SELECT COALESCE(MAX(position), -1) as maxPos FROM channels WHERE server_id = ?').get(serverId);
    const maxPos = maxRow.maxPos;

    const channelId = id();
    const now = Date.now();
    await prepare(
      'INSERT INTO channels (id, server_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(channelId, serverId, cleanName, maxPos + 1, now);

    res.status(201).json({ channel: { id: channelId, server_id: serverId, name: cleanName, position: maxPos + 1, created_at: now } });
  } catch (err) {
    next(err);
  }
});

// Delete a channel (any member for simplicity; tighten to owner/admin if desired)
router.delete('/:channelId', async (req, res, next) => {
  try {
    const { channelId } = req.params;
    const channel = await prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!(await isMember(channel.server_id, req.userId))) return res.status(403).json({ error: 'Not a member of this server' });

    const server = await prepare('SELECT * FROM servers WHERE id = ?').get(channel.server_id);
    if (server.owner_id !== req.userId) return res.status(403).json({ error: 'Only the owner can delete channels' });

    await prepare('DELETE FROM channels WHERE id = ?').run(channelId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
