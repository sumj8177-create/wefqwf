const { db, id } = require('./db');

// Checks a channel's installed bots against a new message's content, and
// posts any matching canned responses after a short human-like delay.
function triggerBotsForMessage(io, channelId, content) {
  const installs = db
    .prepare(
      `SELECT bi.bot_id, u.id as user_id, u.username, u.avatar_color
       FROM bot_installs bi
       JOIN bots b ON b.id = bi.bot_id
       JOIN users u ON u.id = b.user_id
       WHERE bi.channel_id = ?`
    )
    .all(channelId);
  if (!installs.length) return;

  const lower = content.toLowerCase();

  installs.forEach((bot) => {
    const triggers = db.prepare('SELECT * FROM bot_triggers WHERE bot_id = ?').all(bot.bot_id);
    const match = triggers.find((t) => lower.includes(t.trigger_text));
    if (!match) return;

    setTimeout(() => {
      const messageId = id();
      const now = Date.now();
      db.prepare(
        'INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(messageId, channelId, bot.user_id, match.response_text, now);

      io.to(`channel:${channelId}`).emit('message:new', {
        id: messageId,
        channel_id: channelId,
        content: match.response_text,
        created_at: now,
        user_id: bot.user_id,
        username: bot.username,
        avatar_color: bot.avatar_color,
        is_bot: 1,
      });
    }, 500 + Math.floor(Math.random() * 500));
  });
}

module.exports = { triggerBotsForMessage };
