const express = require('express');
const { prepare, batchRun, id, inviteCode } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function isMember(serverId, userId) {
  return prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}

// List servers the current user belongs to
router.get('/', async (req, res, next) => {
  try {
    const rows = await prepare(
      `SELECT s.id, s.name, s.owner_id, s.invite_code, s.created_at, sm.role
       FROM servers s
       JOIN server_members sm ON sm.server_id = s.id
       WHERE sm.user_id = ?
       ORDER BY s.created_at ASC`
    ).all(req.userId);
    res.json({ servers: rows });
  } catch (err) {
    next(err);
  }
});

// Create a new server (creator becomes owner, gets a #general channel)
router.post('/', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({ error: 'Server name must be at least 2 characters' });
    }
    const serverId = id();
    const now = Date.now();
    const code = inviteCode();
    const channelId = id();

    await batchRun([
      [
        'INSERT INTO servers (id, name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?)',
        [serverId, String(name).trim(), req.userId, code, now],
      ],
      [
        'INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
        [serverId, req.userId, 'owner', now],
      ],
      [
        'INSERT INTO channels (id, server_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)',
        [channelId, serverId, 'general', 0, now],
      ],
    ]);

    res.status(201).json({
      server: { id: serverId, name: String(name).trim(), owner_id: req.userId, invite_code: code, created_at: now, role: 'owner' },
    });
  } catch (err) {
    next(err);
  }
});

// Join a server via invite code
router.post('/join', async (req, res, next) => {
  try {
    const { inviteCode: code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Invite code is required' });

    const server = await prepare('SELECT * FROM servers WHERE invite_code = ?').get(String(code).trim());
    if (!server) return res.status(404).json({ error: 'Invalid invite code' });

    if (await isMember(server.id, req.userId)) {
      return res.status(409).json({ error: 'You are already a member of this server' });
    }

    await prepare(
      'INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    ).run(server.id, req.userId, 'member', Date.now());

    res.status(201).json({ server: { ...server, role: 'member' } });
  } catch (err) {
    next(err);
  }
});

// List members of a server
router.get('/:serverId/members', async (req, res, next) => {
  try {
    const { serverId } = req.params;
    if (!(await isMember(serverId, req.userId))) return res.status(403).json({ error: 'Not a member of this server' });

    const members = await prepare(
      `SELECT u.id, u.username, u.avatar_color, sm.role
       FROM server_members sm
       JOIN users u ON u.id = sm.user_id
       WHERE sm.server_id = ?
       ORDER BY sm.role ASC, u.username ASC`
    ).all(serverId);
    res.json({ members });
  } catch (err) {
    next(err);
  }
});

// Leave a server (owners cannot leave; they must delete instead)
router.delete('/:serverId/leave', async (req, res, next) => {
  try {
    const { serverId } = req.params;
    const server = await prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.owner_id === req.userId) {
      return res.status(400).json({ error: 'Owners cannot leave; delete the server instead' });
    }
    await prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, req.userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Delete a server (owner only)
router.delete('/:serverId', async (req, res, next) => {
  try {
    const { serverId } = req.params;
    const server = await prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.owner_id !== req.userId) return res.status(403).json({ error: 'Only the owner can delete this server' });
    await prepare('DELETE FROM servers WHERE id = ?').run(serverId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
