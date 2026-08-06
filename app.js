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

    connectSocket();
    await loadServers();
  }

  function connectSocket() {
    state.socket = io({ auth: { token: state.token } });
    state.socket.on('message:new', (message) => {
      if (message.channel_id === state.currentChannelId) {
        appendMessage(message);
        scrollToBottom();
      }
    });
    state.socket.on('typing', ({ channelId, username }) => {
      if (channelId !== state.currentChannelId) return;
      const el = $('#typing-indicator');
      el.textContent = `${username} is typing...`;
      clearTimeout(state.typingDisplayTimeout);
      state.typingDisplayTimeout = setTimeout(() => { el.textContent = ''; }, 2500);
    });
  }

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
    state.currentServerId = serverId;
    state.currentChannelId = null;
    renderServerRail();
    const server = state.servers.find((s) => s.id === serverId);
    $('#current-server-name').textContent = server ? server.name : 'Select a server';
    $('#add-channel-btn').classList.toggle('hidden', !server);

    await loadChannels(serverId);
    await loadMembers(serverId);
  }

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
      }
      appendMessage(m, false);
    });
    scrollToBottom();
  }

  function appendMessage(m) {
    const container = $('#chat-messages');
    const group = document.createElement('div');
    group.className = 'msg-group';
    group.innerHTML = `
      <div class="msg-avatar" style="background:${m.avatar_color}">${initials(m.username)}</div>
      <div class="msg-body">
        <div class="msg-meta">
          <span class="msg-author">${escapeHtml(m.username)}</span>
          <span class="msg-time">${fmtTime(m.created_at)}</span>
        </div>
        <div class="msg-text"></div>
      </div>
    `;
    group.querySelector('.msg-text').textContent = m.content;
    container.appendChild(group);
  }

  function scrollToBottom() {
    const container = $('#chat-messages');
    container.scrollTop = container.scrollHeight;
  }

  $('#message-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#message-input');
    const content = input.value.trim();
    if (!content || !state.currentChannelId) return;
    state.socket.emit('message:send', { channelId: state.currentChannelId, content });
    input.value = '';
  });

  $('#message-input').addEventListener('input', () => {
    if (!state.currentChannelId) return;
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

  // ---------- MODAL HELPERS ----------
  function openModal(id) {
    $('#modal-overlay').classList.remove('hidden');
    $$('.modal').forEach((m) => m.classList.add('hidden'));
    $('#' + id).classList.remove('hidden');
  }
  function closeModal() {
    $('#modal-overlay').classList.add('hidden');
  }
  $$('[data-close-modal]').forEach((btn) => btn.addEventListener('click', closeModal));
  $('#modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') closeModal();
  });

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
        showApp();
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
