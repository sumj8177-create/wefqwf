const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { prepare, id } = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const AVATAR_COLORS = ['#7C5CFF', '#FF8A5C', '#3ECF8E', '#FFC24B', '#FF5C7C', '#4BC6FF', '#C77CFF'];

function publicUser(u) {
  return { id: u.id, username: u.username, avatarColor: u.avatar_color, createdAt: u.created_at };
}

function makeToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

router.post('/register', async (req, res, next) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }
    const cleanUsername = String(username).trim();
    const cleanEmail = String(email).trim().toLowerCase();
    if (cleanUsername.length < 3 || cleanUsername.length > 32) {
      return res.status(400).json({ error: 'Username must be 3-32 characters' });
    }
    if (!/^[a-zA-Z0-9_. ]+$/.test(cleanUsername)) {
      return res.status(400).json({ error: 'Username has invalid characters' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const existing = await prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(cleanUsername, cleanEmail);
    if (existing) {
      return res.status(409).json({ error: 'Username or email already taken' });
    }

    const hash = bcrypt.hashSync(String(password), 10);
    const userId = id();
    const now = Date.now();
    const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

    await prepare(
      'INSERT INTO users (id, username, email, password_hash, avatar_color, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, cleanUsername, cleanEmail, hash, avatarColor, now);

    const user = { id: userId, username: cleanUsername, avatar_color: avatarColor, created_at: now };
    const token = makeToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const cleanUsername = String(username).trim();
    const user = await prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(
      cleanUsername,
      cleanUsername.toLowerCase()
    );

    if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = makeToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;