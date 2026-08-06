require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const { db, id } = require('./db');
const { verifyToken } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const serverRoutes = require('./routes/servers');
const channelRoutes = require('./routes/channels');
const messageRoutes = require('./routes/messages');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.set('io', io);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/messages', messageRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Fallback to the SPA for any non-API route
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Socket.io: authenticate on connect, then join/leave channel rooms ---
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Not authenticated'));
    const payload = verifyToken(token);
    socket.userId = payload.sub;
    socket.username = payload.username;
    next();
  } catch (err) {
    next(new Error('Invalid or expired token'));
  }
});

function isMember(serverId, userId) {
  return db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}

function channelForUser(channelId, userId) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return null;
  return isMember(channel.server_id, userId) ? channel : null;
}

io.on('connection', (socket) => {
  socket.on('channel:join', (channelId) => {
    const channel = channelForUser(channelId, socket.userId);
    if (!channel) return;
    socket.join(`channel:${channelId}`);
  });

  socket.on('channel:leave', (channelId) => {
    socket.leave(`channel:${channelId}`);
  });

  socket.on('message:send', (data) => {
    const { channelId, content } = data || {};
    const channel = channelForUser(channelId, socket.userId);
    if (!channel) return;
    const text = String(content || '').trim();
    if (!text || text.length > 4000) return;

    const messageId = id();
    const now = Date.now();
    db.prepare(
      'INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(messageId, channelId, socket.userId, text, now);

    const user = db.prepare('SELECT username, avatar_color FROM users WHERE id = ?').get(socket.userId);
    const message = {
      id: messageId,
      channel_id: channelId,
      content: text,
      created_at: now,
      user_id: socket.userId,
      username: user.username,
      avatar_color: user.avatar_color,
    };

    io.to(`channel:${channelId}`).emit('message:new', message);
  });

  socket.on('typing', ({ channelId }) => {
    if (!channelId) return;
    socket.to(`channel:${channelId}`).emit('typing', { channelId, username: socket.username });
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`relay listening on port ${PORT}`);
});
