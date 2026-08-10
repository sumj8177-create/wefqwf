(() => {
  const API = '/api';
  let state = {
    token: localStorage.getItem('relay_token') || null,
    user: null,
    servers: [],
    currentServerId: null,
    channels: [],
    currentChannelId: null,
    members: [],
    socket: null,
    typingTimeout: null,
    mode: 'server', // 'server' | 'dm'
    dmConversations: [],
    currentDmUserId: null,
    currentDmUser: null,
    bots: [],
    lastRenderTracker: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ---------- API helper ----------
  async function api(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

  function initials(name) {
    return (name || '?').trim().slice(0, 2).toUpperCase();
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function fmtDay(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  // ---------- AUTH SCREEN ----------
  $$('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.auth-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.tab === 'login';
      $('#login-form').classList.toggle('hidden', !isLogin);
      $('#register-form').classList.toggle('hidden', isLogin);
    });
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      const data = await api('POST', '/auth/login', {
        username: $('#login-username').value,
        password: $('#login-password').value,
      });
      onAuthed(data);
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#register-error').textContent = '';
    try {
      const data = await api('POST', '/auth/register', {
        username: $('#register-username').value,
        email: $('#register-email').value,
        password: $('#register-password').value,
      });
      onAuthed(data);
    } catch (err) {
      $('#register-error').textContent = err.message;
    }
  });

  function onAuthed({ token, user }) {
    state.token = token;
    state.user = user;
    localStorage.setItem('relay_token', token);
    showApp();
  }

  $('#logout-btn').addEventListener('click', () => {
    localStorage.removeItem('relay_token');
    if (state.socket) state.socket.disconnect();
    location.reload();
  });

  // ---------- APP BOOT ----------
  async function showApp() {
    $('#auth-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');

    $('#me-username').textContent = state.user.username;
    const meAvatar = $('#me-avatar');
    meAvatar.textContent = initials(state.user.username);
    meAvatar.style.background = state.user.avatarColor;

    $('#me-username-dm').textContent = state.user.username;
    const meAvatarDm = $('#me-avatar-dm');
    meAvatarDm.textContent = initials(state.user.username);
    meAvatarDm.style.background = state.user.avatarColor;

    connectSocket();
    await loadServers();
  }

  function connectSocket() {
    state.socket = io({ auth: { token: state.token } });
    state.socket.on('message:new', (message) => {
      if (message.channel_id === state.currentChannelId) {
        appendMessage(message);
        bumpMessageCount(1);
      }
    });
    state.socket.on('typing', ({ channelId, username }) => {
      if (channelId !== state.currentChannelId) return;
      const el = $('#typing-indicator');
      el.textContent = `${username} is typing...`;
      clearTimeout(state.typingDisplayTimeout);
      state.typingDisplayTimeout = setTimeout(() => { el.textContent = ''; }, 2500);
    });
    state.socket.on('message:delete', ({ id, channelId }) => {
      if (channelId === state.currentChannelId) {
        removeMessage(id);
        bumpMessageCount(-1);
      }
    });
    state.socket.on('message:pin', ({ id, channelId, pinnedAt }) => {
      if (channelId === state.currentChannelId) setMessagePinned(id, pinnedAt);
    });
    state.socket.on('dm:new', (message) => {
      const otherId = message.sender_id === state.user.id ? message.recipient_id : message.sender_id;
      if (state.mode === 'dm' && state.currentDmUserId === otherId) {
        appendDmMessage(message);
      }
      loadDmList();
    });
  }

  $('#logout-btn-dm').addEventListener('click', () => {
    localStorage.removeItem('relay_token');
    if (state.socket) state.socket.disconnect();
    location.reload();
  });

  // ---------- SERVERS ----------
  async function loadServers() {
    const { servers } = await api('GET', '/servers');
    state.servers = servers;
    renderServerRail();
    if (servers.length && !state.currentServerId) {
      selectServer(servers[0].id);
    }
  }

  function renderServerRail() {
    const list = $('#server-list');
    list.innerHTML = '';
    state.servers.forEach((s) => {
      const btn = document.createElement('button');
      btn.className = 'rail-btn' + (s.id === state.currentServerId ? ' active' : '');
      btn.textContent = initials(s.name);
      btn.title = s.name;
      btn.addEventListener('click', () => selectServer(s.id));
      list.appendChild(btn);
    });
  }

  async function selectServer(serverId) {
    switchToServerMode();
    state.currentServerId = serverId;
    state.currentChannelId = null;
    renderServerRail();
    const server = state.servers.find((s) => s.id === serverId);
    $('#current-server-name').textContent = server ? server.name : 'Select a server';
    $('#add-channel-btn').classList.toggle('hidden', !server);

    await loadChannels(serverId);
    await loadMembers(serverId);
  }

  // ---------- MODE SWITCHING (servers vs DMs) ----------
  function switchToServerMode() {
    state.mode = 'server';
    state.currentDmUserId = null;
    state.currentDmUser = null;
    $('#dm-nav-btn').classList.remove('active');
    $('#channel-sidebar').classList.remove('hidden');
    $('#dm-sidebar').classList.add('hidden');
    $('#chat-hash').classList.remove('hidden');
  }

  async function switchToDmMode() {
    state.mode = 'dm';
    state.currentChannelId = null;
    if (state.socket) {
      $$('.channel-item.active').forEach((el) => el.classList.remove('active'));
    }
    renderServerRail();
    $('#dm-nav-btn').classList.add('active');
    $('#channel-sidebar').classList.add('hidden');
    $('#dm-sidebar').classList.remove('hidden');
    $('#member-list').classList.add('hidden');
    $('#app-screen').classList.remove('with-members');
    $('#chat-hash').classList.add('hidden');
    $('#msg-count-badge').classList.add('hidden');
    state.currentChannelMessageCount = undefined;

    if (!state.currentDmUserId) {
      $('#current-channel-name').textContent = 'Select a conversation';
      $('#message-form').classList.add('hidden');
      $('#chat-messages').innerHTML = '<div class="empty-state"><p class="empty-title">Your Direct Messages</p><p class="empty-sub">Pick a conversation, or start a new one.</p></div>';
    }

    await loadDmList();
  }

  $('#dm-nav-btn').addEventListener('click', switchToDmMode);

  async function loadDmList() {
    const { conversations } = await api('GET', '/dms');
    state.dmConversations = conversations;
    renderDmList();
  }

  function renderDmList() {
    const list = $('#dm-list');
    list.innerHTML = '';
    state.dmConversations.forEach((c) => {
      const item = document.createElement('div');
      item.className = 'channel-item dm-item' + (c.user_id === state.currentDmUserId ? ' active' : '');
      item.innerHTML = `
        <div class="member-avatar" style="background:${c.avatar_color}">${initials(c.username)}</div>
        <div class="dm-item-meta">
          <span class="dm-item-name">${escapeHtml(c.username)}</span>
          <span class="dm-item-preview">${escapeHtml(c.last_message || '')}</span>
        </div>
      `;
      item.addEventListener('click', () => openDm(c.user_id, c.username, c.avatar_color));
      list.appendChild(item);
    });
  }

  async function openDm(userId, username, avatarColor) {
    state.currentDmUserId = userId;
    state.currentDmUser = { id: userId, username, avatarColor };
    renderDmList();
    $('#current-channel-name').textContent = username;
    $('#message-form').classList.remove('hidden');
    $('#message-input').focus();

    const { messages } = await api('GET', `/dms/${userId}`);
    const container = $('#chat-messages');
    container.innerHTML = '';
    state.lastRenderTracker = null;
    let lastDay = null;
    messages.forEach((m) => {
      const day = fmtDay(m.created_at);
      if (day !== lastDay) {
        const divider = document.createElement('div');
        divider.className = 'msg-day-divider';
        divider.textContent = day;
        container.appendChild(divider);
        lastDay = day;
        state.lastRenderTracker = null;
      }
      appendDmMessage(m);
    });
    scrollToBottom();
  }

  function appendDmMessage(m) {
    renderMessageLine(m);
  }

  $('#new-dm-btn').addEventListener('click', () => {
    $('#dm-target-username').value = '';
    $('#dm-modal-error').textContent = '';
    openModal('new-dm-modal');
  });

  $('#confirm-start-dm').addEventListener('click', async () => {
    const username = $('#dm-target-username').value.trim();
    if (!username) return;
    try {
      const { user } = await api('POST', '/dms/start', { username });
      closeModal();
      await loadDmList();
      openDm(user.id, user.username, user.avatarColor);
    } catch (err) {
      $('#dm-modal-error').textContent = err.message;
    }
  });

  // ---------- CHANNELS ----------
  async function loadChannels(serverId) {
    const { channels } = await api('GET', `/channels/server/${serverId}`);
    state.channels = channels;
    renderChannelList();
    if (channels.length) {
      selectChannel(channels[0].id);
    } else {
      $('#chat-messages').innerHTML = '<div class="empty-state"><p class="empty-title">No channels yet</p><p class="empty-sub">Create one to start chatting.</p></div>';
      $('#message-form').classList.add('hidden');
      $('#current-channel-name').textContent = 'select-a-channel';
    }
  }

  function renderChannelList() {
    const list = $('#channel-list');
    list.innerHTML = '';
    state.channels.forEach((c) => {
      const item = document.createElement('div');
      item.className = 'channel-item' + (c.id === state.currentChannelId ? ' active' : '');
      item.innerHTML = `<span class="hash">#</span><span>${escapeHtml(c.name)}</span>`;
      item.addEventListener('click', () => selectChannel(c.id));
      list.appendChild(item);
    });
  }

  async function selectChannel(channelId) {
    if (state.currentChannelId) {
      state.socket.emit('channel:leave', state.currentChannelId);
    }
    state.currentChannelId = channelId;
    renderChannelList();
    state.socket.emit('channel:join', channelId);

    const channel = state.channels.find((c) => c.id === channelId);
    $('#current-channel-name').textContent = channel ? channel.name : '';
    $('#message-form').classList.remove('hidden');
    $('#message-input').focus();

    await loadMessages(channelId);
    await refreshMessageCount(channelId);
  }

  function formatCount(n) {
    return n === 1 ? '1 message' : `${n.toLocaleString()} messages`;
  }

  async function refreshMessageCount(channelId) {
    try {
      const { count } = await api('GET', `/messages/${channelId}/count`);
      if (channelId !== state.currentChannelId) return; // user may have switched channels while this was in flight
      const badge = $('#msg-count-badge');
      badge.textContent = formatCount(count);
      badge.classList.remove('hidden');
      state.currentChannelMessageCount = count;
    } catch (err) {
      // non-critical — just hide the badge rather than surface an error
      $('#msg-count-badge').classList.add('hidden');
    }
  }

  function bumpMessageCount(delta) {
    if (typeof state.currentChannelMessageCount !== 'number') return;
    state.currentChannelMessageCount = Math.max(0, state.currentChannelMessageCount + delta);
    $('#msg-count-badge').textContent = formatCount(state.currentChannelMessageCount);
  }

  $('#add-channel-btn').addEventListener('click', () => {
    $('#new-channel-name').value = '';
    $('#channel-modal-error').textContent = '';
    openModal('add-channel-modal');
  });

  $('#confirm-create-channel').addEventListener('click', async () => {
    const name = $('#new-channel-name').value.trim();
    if (!name) return;
    try {
      const { channel } = await api('POST', `/channels/server/${state.currentServerId}`, { name });
      state.channels.push(channel);
      renderChannelList();
      closeModal();
      selectChannel(channel.id);
    } catch (err) {
      $('#channel-modal-error').textContent = err.message;
    }
  });

  // ---------- MESSAGES ----------
  async function loadMessages(channelId) {
    const container = $('#chat-messages');
    container.innerHTML = '';
    state.lastRenderTracker = null;
    const { messages } = await api('GET', `/messages/${channelId}`);
    let lastDay = null;
    messages.forEach((m) => {
      const day = fmtDay(m.created_at);
      if (day !== lastDay) {
        const divider = document.createElement('div');
        divider.className = 'msg-day-divider';
        divider.textContent = day;
        container.appendChild(divider);
        lastDay = day;
        state.lastRenderTracker = null;
      }
      appendMessage(m);
    });
    scrollToBottom();
  }

  // Shared renderer for both channel messages and DMs: groups consecutive
  // messages from the same sender (within 5 minutes) under one avatar/name,
  // Discord-style, instead of repeating the header on every line.
  function renderMessageLine(m) {
    const container = $('#chat-messages');
    const authorId = m.user_id || m.sender_id;
    const tracker = state.lastRenderTracker;
    const canGroup = tracker && tracker.userId === authorId && (m.created_at - tracker.time) < 5 * 60 * 1000;

    if (canGroup) {
      const line = document.createElement('div');
      line.className = 'msg-line';
      line.dataset.messageId = m.id;
      line.dataset.userId = authorId;
      line.title = fmtTime(m.created_at);
      line.innerHTML = `
        <span class="msg-text"></span>
        ${m.pinned_at ? '<span class="pin-badge" title="Pinned">📌</span>' : ''}
      `;
      line.querySelector('.msg-text').textContent = m.content;
      tracker.linesEl.appendChild(line);
      tracker.time = m.created_at;
      return;
    }

    const group = document.createElement('div');
    group.className = 'msg-group';
    group.dataset.userId = authorId;
    group.innerHTML = `
      <div class="msg-avatar" style="background:${m.avatar_color}">${initials(m.username)}</div>
      <div class="msg-lines-wrap">
        <div class="msg-meta">
          <span class="msg-author">${escapeHtml(m.username)}</span>
          ${m.is_bot ? '<span class="bot-badge">BOT</span>' : ''}
          <span class="msg-time">${fmtTime(m.created_at)}</span>
        </div>
        <div class="msg-lines"></div>
      </div>
    `;
    const linesEl = group.querySelector('.msg-lines');
    const firstLine = document.createElement('div');
    firstLine.className = 'msg-line';
    firstLine.dataset.messageId = m.id;
    firstLine.dataset.userId = authorId;
    firstLine.innerHTML = `
      <span class="msg-text"></span>
      ${m.pinned_at ? '<span class="pin-badge" title="Pinned">📌</span>' : ''}
    `;
    firstLine.querySelector('.msg-text').textContent = m.content;
    linesEl.appendChild(firstLine);
    container.appendChild(group);

    state.lastRenderTracker = { userId: authorId, time: m.created_at, linesEl };
  }

  function appendMessage(m) {
    renderMessageLine(m);
  }

  function removeMessage(messageId) {
    const line = $(`.msg-line[data-message-id="${messageId}"]`);
    if (!line) return;
    const group = line.closest('.msg-group');
    line.remove();
    if (group && !group.querySelector('.msg-line')) {
      group.remove();
    }
    state.lastRenderTracker = null;
  }

  function setMessagePinned(messageId, pinnedAt) {
    const line = $(`.msg-line[data-message-id="${messageId}"]`);
    if (!line) return;
    const existingBadge = line.querySelector('.pin-badge');
    if (pinnedAt && !existingBadge) {
      const badge = document.createElement('span');
      badge.className = 'pin-badge';
      badge.title = 'Pinned';
      badge.textContent = '📌';
      line.appendChild(badge);
    } else if (!pinnedAt && existingBadge) {
      existingBadge.remove();
    }
  }

  // ---------- MESSAGE CONTEXT MENU ----------
  const contextMenu = document.createElement('div');
  contextMenu.className = 'msg-context-menu hidden';
  document.body.appendChild(contextMenu);

  function closeContextMenu() {
    contextMenu.classList.add('hidden');
    contextMenu.innerHTML = '';
  }

  function menuItem(label, onClick, opts = {}) {
    const item = document.createElement('div');
    item.className = 'ctx-item' + (opts.danger ? ' ctx-danger' : '');
    item.textContent = label;
    item.addEventListener('click', () => {
      closeContextMenu();
      onClick();
    });
    return item;
  }

  $('#chat-messages').addEventListener('contextmenu', (e) => {
    const line = e.target.closest('.msg-line');
    if (!line) return;
    const group = line.closest('.msg-group');
    if (!group) return;
    e.preventDefault();

    const content = line.querySelector('.msg-text').textContent;
    const messageId = line.dataset.messageId;
    const authorId = group.dataset.userId;

    if (state.mode === 'dm') {
      contextMenu.innerHTML = '';
      contextMenu.appendChild(menuItem('Copy Text', () => {
        navigator.clipboard.writeText(content);
      }));
      const x = Math.min(e.clientX, window.innerWidth - 208);
      const y = Math.min(e.clientY, window.innerHeight - 50);
      contextMenu.style.left = `${x}px`;
      contextMenu.style.top = `${y}px`;
      contextMenu.classList.remove('hidden');
      return;
    }

    const isOwnMessage = authorId === state.user.id;
    const currentServer = state.servers.find((s) => s.id === state.currentServerId);
    const isServerOwner = currentServer && currentServer.role === 'owner';
    const isPinned = !!line.querySelector('.pin-badge');

    contextMenu.innerHTML = '';
    contextMenu.appendChild(menuItem('Reply', () => {
      const author = group.querySelector('.msg-author').textContent;
      const input = $('#message-input');
      input.value = `@${author} `;
      input.focus();
    }));
    contextMenu.appendChild(menuItem('Copy Text', () => {
      navigator.clipboard.writeText(content);
    }));
    contextMenu.appendChild(menuItem('Copy Message ID', () => {
      navigator.clipboard.writeText(messageId);
    }));
    contextMenu.appendChild(menuItem(isPinned ? 'Unpin Message' : 'Pin Message', () => {
      state.socket.emit('message:pin', { messageId });
    }));
    if (!isOwnMessage) {
      contextMenu.appendChild(menuItem('Report Message', async () => {
        try {
          await api('POST', `/messages/${messageId}/report`, {});
          alert('Message reported to the server owner.');
        } catch (err) {
          alert(err.message);
        }
      }));
    }
    if (isOwnMessage || isServerOwner) {
      contextMenu.appendChild(menuItem('Delete Message', () => {
        state.socket.emit('message:delete', { messageId });
      }, { danger: true }));
    }

    const menuWidth = 200;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - contextMenu.children.length * 34 - 16);
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
    contextMenu.classList.remove('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) closeContextMenu();
  });
  document.addEventListener('scroll', closeContextMenu, true);

  function isNearBottom(container, threshold = 80) {
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  }

  function scrollToBottom() {
    const container = $('#chat-messages');
    container.scrollTop = container.scrollHeight;
  }

  $('#message-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#message-input');
    const content = input.value.trim();
    if (!content) return;

    if (state.mode === 'dm') {
      if (!state.currentDmUserId) return;
      state.socket.emit('dm:send', { recipientId: state.currentDmUserId, content });
    } else {
      if (!state.currentChannelId) return;
      state.socket.emit('message:send', { channelId: state.currentChannelId, content });
    }
    input.value = '';
  });

  $('#message-input').addEventListener('input', () => {
    if (state.mode !== 'server' || !state.currentChannelId) return;
    clearTimeout(state.typingTimeout);
    state.socket.emit('typing', { channelId: state.currentChannelId });
    state.typingTimeout = setTimeout(() => {}, 1000);
  });

  // ---------- MEMBERS ----------
  async function loadMembers(serverId) {
    const { members } = await api('GET', `/servers/${serverId}/members`);
    state.members = members;
    const list = $('#member-list');
    list.classList.remove('hidden');
    $('#app-screen').classList.add('with-members');
    const body = $('#member-list-body');
    body.innerHTML = '';
    members.forEach((m) => {
      const item = document.createElement('div');
      item.className = 'member-item';
      item.innerHTML = `
        <div class="member-avatar" style="background:${m.avatar_color}">${initials(m.username)}</div>
        <span class="member-name">${escapeHtml(m.username)}</span>
        ${m.role !== 'member' ? `<span class="member-role">${m.role}</span>` : ''}
      `;
      body.appendChild(item);
    });
  }

  // ---------- CREATE / JOIN SERVER ----------
  $('#add-server-btn').addEventListener('click', () => {
    $('#new-server-name').value = '';
    $('#join-invite-code').value = '';
    $('#server-modal-error').textContent = '';
    openModal('create-server-modal');
  });

  $('#confirm-create-server').addEventListener('click', async () => {
    const name = $('#new-server-name').value.trim();
    if (!name) return;
    try {
      const { server } = await api('POST', '/servers', { name });
      state.servers.push(server);
      closeModal();
      await selectServer(server.id);
      renderServerRail();
    } catch (err) {
      $('#server-modal-error').textContent = err.message;
    }
  });

  $('#confirm-join-server').addEventListener('click', async () => {
    const inviteCode = $('#join-invite-code').value.trim();
    if (!inviteCode) return;
    try {
      const { server } = await api('POST', '/servers/join', { inviteCode });
      state.servers.push(server);
      closeModal();
      await selectServer(server.id);
      renderServerRail();
    } catch (err) {
      $('#server-modal-error').textContent = err.message;
    }
  });

  // ---------- SERVER OPTIONS (invite / leave / delete) ----------
  $('#server-menu-btn').addEventListener('click', () => {
    const server = state.servers.find((s) => s.id === state.currentServerId);
    if (!server) return;
    $('#server-options-title').textContent = server.name;
    $('#invite-code-display').textContent = server.invite_code;
    const btn = $('#leave-or-delete-btn');
    const isOwner = server.role === 'owner';
    btn.textContent = isOwner ? 'Delete server' : 'Leave server';
    btn.onclick = async () => {
      if (isOwner) {
        if (!confirm(`Delete "${server.name}"? This cannot be undone.`)) return;
        await api('DELETE', `/servers/${server.id}`);
      } else {
        await api('DELETE', `/servers/${server.id}/leave`);
      }
      state.servers = state.servers.filter((s) => s.id !== server.id);
      state.currentServerId = null;
      closeModal();
      renderServerRail();
      if (state.servers.length) {
        selectServer(state.servers[0].id);
      } else {
        $('#current-server-name').textContent = 'Select a server';
        $('#channel-list').innerHTML = '';
        $('#chat-messages').innerHTML = '<div class="empty-state"><p class="empty-title">Pick a server, then a channel</p><p class="empty-sub">Or create your own server on the left to get started.</p></div>';
        $('#message-form').classList.add('hidden');
        $('#member-list').classList.add('hidden');
      }
    };
    openModal('server-options-modal');
  });

  $('#copy-invite-btn').addEventListener('click', () => {
    navigator.clipboard.writeText($('#invite-code-display').textContent);
    $('#copy-invite-btn').textContent = 'Copied!';
    setTimeout(() => { $('#copy-invite-btn').textContent = 'Copy'; }, 1500);
  });

  // ---------- BOTS ----------
  $('#bots-nav-btn').addEventListener('click', openBotsModal);

  async function loadBots() {
    const { bots } = await api('GET', '/bots');
    state.bots = bots;
    renderBotsList();
  }

  function renderBotsList() {
    const list = $('#bots-list');
    list.innerHTML = '';
    if (!state.bots.length) {
      list.innerHTML = '<p class="modal-hint">You haven\'t created any bots yet.</p>';
      return;
    }

    state.bots.forEach((bot) => {
      const card = document.createElement('div');
      card.className = 'bot-card';

      const triggerRows = bot.triggers.map((t) => `
        <div class="trigger-row" data-trigger-id="${t.id}">
          <span class="trigger-when">"${escapeHtml(t.trigger_text)}"</span>
          <span class="trigger-arrow">→</span>
          <span class="trigger-then">${escapeHtml(t.response_text)}</span>
          <button class="icon-btn trigger-delete" title="Remove trigger">✕</button>
        </div>
      `).join('') || '<p class="modal-hint">No triggers yet — add one below.</p>';

      const installedHere = state.currentChannelId && bot.installedChannels.includes(state.currentChannelId);
      const currentChannel = state.channels.find((c) => c.id === state.currentChannelId);

      card.innerHTML = `
        <div class="bot-card-header">
          <div class="member-avatar" style="background:${bot.avatarColor}">${initials(bot.name)}</div>
          <span class="bot-card-name">${escapeHtml(bot.name)}</span>
          <button class="btn-ghost bot-message" title="Message this bot">✉ Message</button>
          <button class="icon-btn bot-delete" title="Delete bot">🗑</button>
        </div>
        <div class="triggers-list">${triggerRows}</div>
        <div class="trigger-form">
          <input type="text" class="trigger-input" placeholder="when message contains..." maxlength="100" />
          <input type="text" class="response-input" placeholder="bot replies with..." maxlength="500" />
          <button class="btn-ghost trigger-add">Add</button>
        </div>
        ${currentChannel ? `
          <button class="btn-ghost install-toggle">
            ${installedHere ? `Remove from #${escapeHtml(currentChannel.name)}` : `Add to #${escapeHtml(currentChannel.name)}`}
          </button>
        ` : '<p class="modal-hint">Open a channel first to add this bot to it.</p>'}
      `;

      card.querySelector('.bot-message').addEventListener('click', () => {
        closeModal();
        openDm(bot.userId, bot.name, bot.avatarColor);
      });

      card.querySelector('.bot-delete').addEventListener('click', async () => {
        if (!confirm(`Delete bot "${bot.name}"? This cannot be undone.`)) return;
        await api('DELETE', `/bots/${bot.id}`);
        await loadBots();
      });

      card.querySelectorAll('.trigger-delete').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const triggerId = e.target.closest('.trigger-row').dataset.triggerId;
          await api('DELETE', `/bots/${bot.id}/triggers/${triggerId}`);
          await loadBots();
        });
      });

      card.querySelector('.trigger-add').addEventListener('click', async () => {
        const trigger = card.querySelector('.trigger-input').value.trim();
        const response = card.querySelector('.response-input').value.trim();
        if (!trigger || !response) return;
        try {
          await api('POST', `/bots/${bot.id}/triggers`, { trigger, response });
          await loadBots();
        } catch (err) {
          alert(err.message);
        }
      });

      const installBtn = card.querySelector('.install-toggle');
      if (installBtn) {
        installBtn.addEventListener('click', async () => {
          if (installedHere) {
            await api('DELETE', `/bots/${bot.id}/install/${state.currentChannelId}`);
          } else {
            await api('POST', `/bots/${bot.id}/install`, { channelId: state.currentChannelId });
          }
          await loadBots();
        });
      }

      list.appendChild(card);
    });
  }

  $('#confirm-create-bot').addEventListener('click', async () => {
    const name = $('#new-bot-name').value.trim();
    if (!name) return;
    try {
      await api('POST', '/bots', { name });
      $('#new-bot-name').value = '';
      $('#bot-modal-error').textContent = '';
      await loadBots();
    } catch (err) {
      $('#bot-modal-error').textContent = err.message;
    }
  });

  // ---------- MODAL HELPERS ----------
  function openModal(id) {
    $('#modal-overlay').classList.remove('hidden');
    $$('.modal').forEach((m) => m.classList.add('hidden'));
    $('#' + id).classList.remove('hidden');
    if (id === 'bots-modal' && location.pathname !== '/bots') {
      history.pushState({ modal: 'bots' }, '', '/bots');
    }
  }
  function closeModal() {
    $('#modal-overlay').classList.add('hidden');
    if (location.pathname === '/bots') {
      history.pushState({}, '', '/');
    }
  }
  $$('[data-close-modal]').forEach((btn) => btn.addEventListener('click', closeModal));
  $('#modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') closeModal();
  });
  window.addEventListener('popstate', () => {
    if (location.pathname === '/bots') {
      $('#bots-nav-btn').click();
    } else {
      closeModal();
    }
  });

  async function openBotsModal() {
    $('#new-bot-name').value = '';
    $('#bot-modal-error').textContent = '';
    await loadBots();
    openModal('bots-modal');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- BOOT ----------
  async function boot() {
    if (state.token) {
      try {
        const { user } = await api('GET', '/auth/me');
        state.user = user;
        await showApp();
        if (location.pathname === '/bots') {
          await openBotsModal();
        }
        return;
      } catch (err) {
        localStorage.removeItem('relay_token');
        state.token = null;
      }
    }
    $('#auth-screen').classList.remove('hidden');
  }

  boot();
})();
