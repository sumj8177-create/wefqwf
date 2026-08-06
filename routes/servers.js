const express = require('express');
const { db, id, inviteCode } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function isMember(serverId, userId) {
  return db
    .prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?')
    .get(serverId, userId);
}

// List servers the current user belongs to
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.owner_id, s.invite_code, s.created_at, sm.role
       FROM servers s
       JOIN server_members sm ON sm.server_id = s.id
       WHERE sm.user_id = ?
       ORDER BY s.created_at ASC`
    )
    .all(req.userId);
  res.json({ servers: rows });
});

// Create a new server (creator becomes owner, gets a #general channel)
router.post('/', (req, res) => {
  const { name } = req.body || {};
  if (!name || String(name).trim().length < 2) {
    return res.status(400).json({ error: 'Server name must be at least 2 characters' });
  }
  const serverId = id();
  const now = Date.now();
  const code = inviteCode();

  const tx = db.transaction(() => {
    db.prepare(
      'INSERT INTO servers (id, name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(serverId, String(name).trim(), req.userId, code, now);

    db.prepare(
      'INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    ).run(serverId, req.userId, 'owner', now);

    const channelId = id();
    db.prepare(
      'INSERT INTO channels (id, server_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(channelId, serverId, 'general', 0, now);
  });
  tx();

  res.status(201).json({
    server: { id: serverId, name: String(name).trim(), owner_id: req.userId, invite_code: code, created_at: now, role: 'owner' },
  });
});

// Join a server via invite code
router.post('/join', (req, res) => {
  const { inviteCode: code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Invite code is required' });

  const server = db.prepare('SELECT * FROM servers WHERE invite_code = ?').get(String(code).trim());
  if (!server) return res.status(404).json({ error: 'Invalid invite code' });

  if (isMember(server.id, req.userId)) {
    return res.status(409).json({ error: 'You are already a member of this server' });
  }

  db.prepare(
    'INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
  ).run(server.id, req.userId, 'member', Date.now());

  res.status(201).json({ server: { ...server, role: 'member' } });
});

// List members of a server
router.get('/:serverId/members', (req, res) => {
  const { serverId } = req.params;
  if (!isMember(serverId, req.userId)) return res.status(403).json({ error: 'Not a member of this server' });

  const members = db
    .prepare(
      `SELECT u.id, u.username, u.avatar_color, sm.role
       FROM server_members sm
       JOIN users u ON u.id = sm.user_id
       WHERE sm.server_id = ?
       ORDER BY sm.role ASC, u.username ASC`
    )
    .all(serverId);
  res.json({ members });
});

// Leave a server (owners cannot leave; they must delete instead)
router.delete('/:serverId/leave', (req, res) => {
  const { serverId } = req.params;
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.owner_id === req.userId) {
    return res.status(400).json({ error: 'Owners cannot leave; delete the server instead' });
  }
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, req.userId);
  res.json({ ok: true });
});

// Delete a server (owner only)
router.delete('/:serverId', (req, res) => {
  const { serverId } = req.params;
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.owner_id !== req.userId) return res.status(403).json({ error: 'Only the owner can delete this server' });
  db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
  res.json({ ok: true });
});

module.exports = router;
