require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const { prepare, id, conversationId, initSchema } = require('./db');
const { verifyToken } = require('./middleware/auth');
const { triggerBotsForMessage } = require('./botEngine');

const authRoutes = require('./routes/auth');
const serverRoutes = require('./routes/servers');
const channelRoutes = require('./routes/channels');
const messageRoutes = require('./routes/messages');
const dmRoutes = require('./routes/dms');
const botRoutes = require('./routes/bots');

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
app.use('/api/dms', dmRoutes);
app.use('/api/bots', botRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Fallback to the SPA for any non-API route
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Central error handler — every route's try/catch calls next(err) into this
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
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

async function isMember(serverId, userId) {
  return prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}

async function channelForUser(channelId, userId) {
  const channel = await prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return null;
  return (await isMember(channel.server_id, userId)) ? channel : null;
}

io.on('connection', (socket) => {
  // Personal room for DM delivery regardless of which channel/server view is open
  socket.join(`user:${socket.userId}`);

  socket.on('channel:join', async (channelId) => {
    try {
      const channel = await channelForUser(channelId, socket.userId);
      if (!channel) return;
      socket.join(`channel:${channelId}`);
    } catch (err) {
      console.error('channel:join failed:', err);
    }
  });

  socket.on('channel:leave', (channelId) => {
    socket.leave(`channel:${channelId}`);
  });

  socket.on('message:send', async (data) => {
    try {
      const { channelId, content } = data || {};
      const channel = await channelForUser(channelId, socket.userId);
      if (!channel) return;
      const text = String(content || '').trim();
      if (!text || text.length > 4000) return;

      const messageId = id();
      const now = Date.now();
      await prepare(
        'INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(messageId, channelId, socket.userId, text, now);

      const user = await prepare('SELECT username, avatar_color FROM users WHERE id = ?').get(socket.userId);
      const message = {
        id: messageId,
        channel_id: channelId,
        content: text,
        created_at: now,
        user_id: socket.userId,
        username: user.username,
        avatar_color: user.avatar_color,
        is_bot: 0,
      };

      io.to(`channel:${channelId}`).emit('message:new', message);
      triggerBotsForMessage(io, channelId, text).catch((err) => console.error('Bot trigger failed:', err));
    } catch (err) {
      console.error('message:send failed:', err);
    }
  });

  socket.on('message:delete', async (data) => {
    try {
      const { messageId } = data || {};
      const message = await prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
      if (!message) return;
      const channel = await channelForUser(message.channel_id, socket.userId);
      if (!channel) return;

      const server = await prepare('SELECT * FROM servers WHERE id = ?').get(channel.server_id);
      const isAuthor = message.user_id === socket.userId;
      const isOwner = server && server.owner_id === socket.userId;
      if (!isAuthor && !isOwner) return;

      await prepare('DELETE FROM messages WHERE id = ?').run(messageId);
      io.to(`channel:${message.channel_id}`).emit('message:delete', { id: messageId, channelId: message.channel_id });
    } catch (err) {
      console.error('message:delete failed:', err);
    }
  });

  socket.on('message:pin', async (data) => {
    try {
      const { messageId } = data || {};
      const message = await prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
      if (!message) return;
      const channel = await channelForUser(message.channel_id, socket.userId);
      if (!channel) return;

      const nowPinned = message.pinned_at ? null : Date.now();
      await prepare('UPDATE messages SET pinned_at = ? WHERE id = ?').run(nowPinned, messageId);
      io.to(`channel:${message.channel_id}`).emit('message:pin', {
        id: messageId,
        channelId: message.channel_id,
        pinnedAt: nowPinned,
      });
    } catch (err) {
      console.error('message:pin failed:', err);
    }
  });

  socket.on('typing', ({ channelId }) => {
    if (!channelId) return;
    socket.to(`channel:${channelId}`).emit('typing', { channelId, username: socket.username });
  });

  socket.on('dm:send', async (data) => {
    try {
      const { recipientId, content } = data || {};
      const text = String(content || '').trim();
      if (!recipientId || !text || text.length > 4000 || recipientId === socket.userId) return;

      const recipient = await prepare('SELECT id, is_bot FROM users WHERE id = ?').get(recipientId);
      if (!recipient || recipient.is_bot) return;

      const convId = conversationId(socket.userId, recipientId);
      const messageId = id();
      const now = Date.now();
      await prepare(
        'INSERT INTO dm_messages (id, conversation_id, sender_id, recipient_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(messageId, convId, socket.userId, recipientId, text, now);

      const sender = await prepare('SELECT username, avatar_color FROM users WHERE id = ?').get(socket.userId);
      const message = {
        id: messageId,
        conversationId: convId,
        content: text,
        created_at: now,
        sender_id: socket.userId,
        username: sender.username,
        avatar_color: sender.avatar_color,
      };

      io.to(`user:${recipientId}`).to(`user:${socket.userId}`).emit('dm:new', message);
    } catch (err) {
      console.error('dm:send failed:', err);
    }
  });
});

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`relay listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
