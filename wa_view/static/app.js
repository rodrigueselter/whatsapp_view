/* Visualizador forense WhatsApp — frontend (sem dependências). */
(function () {
  'use strict';

  const ICONS = window.WA_ICONS;
  const state = {
    chats: [],
    filter: 'all',          // all | group | individual
    query: '',
    currentChat: null,
    messages: [],
    messageIndex: new Map(),
    drawer: null,           // 'message' | 'chat' | 'search' | 'case'
    summary: null,
  };
  const SENDER_COLORS = ['#1f7aec', '#fe6a5e', '#ef697a', '#dd6f5a', '#02a698', '#2f88c7',
    '#6bcbef', '#35cd96', '#f3b53e', '#a364f5', '#e542a3', '#91ab01', '#d26523', '#5d86e0'];
  const MEDIA_LABEL = {
    image: 'Foto', video: 'Vídeo', audio: 'Áudio', contact: 'Contato', location: 'Localização',
    document: 'Documento', gif: 'GIF', sticker: 'Figurinha', call: 'Chamada', deleted: 'Mensagem apagada',
  };
  const MEDIA_ICON = { image: 'camera', video: 'video', audio: 'micSmall', contact: 'contactCard',
    location: 'location', document: 'doc', gif: 'video', sticker: 'camera', call: 'call', deleted: 'blocked' };
  const STATUS_PT = { received: 'Recebida', pending: 'Pendente', sent: 'Enviada', failed: 'Falha no envio',
    played: 'Reproduzida', delivered: 'Entregue', read: 'Lida' };
  const TYPE_PT = { text: 'Texto', image: 'Imagem', video: 'Vídeo', audio: 'Áudio', contact: 'Contato (vCard)',
    location: 'Localização', group_event: 'Evento de grupo', link: 'Link', document: 'Documento',
    call: 'Chamada', gif: 'GIF', deleted: 'Apagada', sticker: 'Figurinha' };
  const EVENT_PT = {
    created: (e) => ['criou o grupo ', q(e.subject)],
    member_added: (e) => ['adicionou ', b(e.target || 'participante')],
    member_removed: (e) => e.target ? ['removeu ', b(e.target)] : ['saiu'],
    picture_changed: () => ['alterou a imagem do grupo'],
    settings_changed: () => ['alterou as configurações do grupo'],
    admin_changed: (e) => ['alterou privilégios de administrador', e.target ? ' de ' : '', e.target ? b(e.target) : ''],
    member_promoted: (e) => ['promoveu ', b(e.target || 'participante'), ' a administrador'],
    description_changed: () => ['alterou a descrição do grupo'],
    subject_changed: (e) => ['alterou o assunto para ', q(e.subject)],
  };

  // ------------------------------------------------------------ helpers DOM
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v;            // só para ícones internos
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(k, v);
      }
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false || c === '') continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
  }
  function icon(name, cls) { return h('span', { class: cls || 'ico', html: ICONS[name] || '' }); }
  function b(text) { return h('b', null, text); }
  function q(text) { return text ? h('b', null, '“' + text + '”') : ''; }
  const $ = (id) => document.getElementById(id);

  document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = ICONS[el.dataset.icon] || ''; });

  // ---------------------------------------------------------------- datas
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fmtTime = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const fmtDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtWeekday = new Intl.DateTimeFormat('pt-BR', { weekday: 'long' });
  const fmtFull = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'long' });

  function toDate(ts) { return ts ? new Date(ts.unix * 1000) : null; }
  function dayKey(d) { return d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : 'none'; }
  function dayLabel(d) {
    if (!d) return 'Data desconhecida';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (diff === 0) return 'Hoje';
    if (diff === 1) return 'Ontem';
    if (diff > 1 && diff < 7) return fmtWeekday.format(d);
    return fmtDate.format(d);
  }
  function listTime(ts) {
    const d = toDate(ts);
    if (!d) return '';
    const label = dayLabel(d);
    return label === 'Hoje' ? fmtTime.format(d) : label;
  }
  function approxTitle(ts) {
    return ts && ts.approx
      ? `Horário aproximado: o export truncou o timestamp (janela de ${Math.round(ts.window_seconds / 60)} min).`
      : (ts ? fmtFull.format(toDate(ts)) : '');
  }

  function linkify(text) {
    const out = [];
    const re = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const url = m[0];
      out.push(h('a', { href: url.startsWith('http') ? url : 'http://' + url, target: '_blank', rel: 'noopener noreferrer' }, url));
      last = m.index + url.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  function senderColor(key) {
    let hash = 0;
    for (const ch of String(key || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return SENDER_COLORS[hash % SENDER_COLORS.length];
  }
  function avatar(chatOrType, size) {
    const isGroup = chatOrType === 'group' || (chatOrType && chatOrType.type === 'group');
    return h('div', { class: `avatar avatar-${size}`, html: ICONS[isGroup ? 'defaultGroup' : 'defaultUser'] });
  }
  function ticks(msg, extraClass) {
    if (!msg.from_me) return null;
    const cls = ['ticks', extraClass || ''];
    let name = 'tick1';
    switch (msg.status) {
      case 'pending': name = 'clock'; break;
      case 'failed': name = 'error'; cls.push('failed'); break;
      case 'delivered': name = 'tick2'; break;
      case 'read': case 'played': name = 'tick2'; cls.push('read'); break;
      default: name = 'tick1';
    }
    return h('span', { class: cls.join(' '), title: STATUS_PT[msg.status] || msg.status, html: ICONS[name] });
  }
  function fmtBytes(n) {
    if (n === null || n === undefined) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtDuration(sec) {
    if (!sec && sec !== 0) return '';
    sec = Math.round(sec);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }
  function eventText(ev) {
    const builder = EVENT_PT[ev.kind] || (() => [`evento de grupo (tipo ${ev.code})`]);
    return [ev.actor ? b(ev.actor) : 'Sistema', ' ', ...builder(ev)];
  }

  // ----------------------------------------------------------- chat list
  async function loadChats() {
    const status = await fetch('/api/status').then((r) => r.json());
    state.status = status;
    if (!status.loaded) {
      state.chats = []; state.summary = null;
      $('intro-summary').textContent = 'Nenhum export carregado.';
      $('intro-note').textContent = 'Envie o arquivo .zip exportado do WhatsApp para iniciar a análise. Os dados são processados apenas neste servidor.';
      $('chat-list').textContent = '';
      $('chat-list').appendChild(h('div', { class: 'chat-list-empty' }, 'Nenhum export carregado. Use o botão de upload acima.'));
      document.dispatchEvent(new CustomEvent('wa:status', { detail: status }));
      return;
    }
    $('intro-note').textContent = 'Visualização forense somente leitura. Selecione uma conversa à esquerda para exibir as mensagens.';
    const [chats, summary] = await Promise.all([
      fetch('/api/chats').then((r) => r.json()),
      fetch('/api/summary').then((r) => r.json()),
    ]);
    state.chats = chats;
    state.summary = summary;
    renderIntro();
    renderChatList();
    document.dispatchEvent(new CustomEvent('wa:status', { detail: status }));
  }

  /* Recarrega tudo após um novo upload. */
  async function reloadExport() {
    closeDrawer();
    state.currentChat = null; state.currentChatFull = null; state.messages = []; state.messageIndex = new Map();
    $('conversation').hidden = true; $('media-panel').hidden = true; $('intro').hidden = false;
    $('app').classList.remove('show-chat');
    await loadChats();
  }

  function renderIntro() {
    const s = state.summary;
    const p = $('intro-summary');
    p.textContent = '';
    p.appendChild(h('div', { class: 'intro-stats' },
      stat(s.chats, 'conversas'), stat(s.groups, 'grupos'), stat(s.messages, 'mensagens'),
      stat(s.media_linked, 'mídias'), stat(s.contacts, 'contatos')));
    function stat(v, l) { return h('div', { class: 'intro-stat' }, b(v.toLocaleString('pt-BR')), h('span', null, l)); }
  }

  function filteredChats() {
    const q = state.query.trim().toLowerCase();
    return state.chats.filter((c) => {
      if (state.filter === 'media') { if (!c.media || !c.media.total) return false; }
      else if (state.filter !== 'all' && c.type !== state.filter) return false;
      if (!q) return true;
      return [c.name, c.phone, c.jid_normalized, c.last_message && c.last_message.text]
        .some((v) => v && String(v).toLowerCase().includes(q));
    });
  }

  function renderChatList() {
    const list = $('chat-list');
    list.textContent = '';
    const chats = filteredChats();
    if (!chats.length) {
      list.appendChild(h('div', { class: 'chat-list-empty' }, 'Nenhuma conversa encontrada'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const chat of chats) frag.appendChild(chatItem(chat));
    list.appendChild(frag);
  }

  function mediaBadge(m) {
    const title = `${m.total} mídias referenciadas: ${m.ok} disponíveis, ${m.missing} ausentes, ${m.corrupted} corrompidas/divergentes`;
    return h('span', { class: 'media-badge' + (m.corrupted ? ' has-corrupted' : '') + (m.ok ? ' has-ok' : ''), title },
      icon('attach', 'mb-icon'), String(m.ok), h('span', { class: 'mb-total' }, '/' + m.total),
      m.corrupted ? icon('warn', 'mb-warn') : null);
  }

  function chatItem(chat) {
    const lm = chat.last_message;
    const preview = h('div', { class: 'chat-row-preview' });
    if (lm) {
      if (lm.from_me) preview.appendChild(ticks({ from_me: true, status: lm.status }));
      else if (chat.type === 'group' && lm.type !== 'group_event' && lm.type !== 'call') preview.appendChild(h('span', { class: 'preview-text' }, lm.sender_name + ': '));
      if (MEDIA_ICON[lm.type]) preview.appendChild(icon(MEDIA_ICON[lm.type], 'media-icon'));
      const text = lm.type === 'group_event' ? 'Evento de grupo' : (lm.text || MEDIA_LABEL[lm.type] || '');
      preview.appendChild(h('span', { class: 'preview-text' }, text));
    } else {
      preview.appendChild(h('span', { class: 'preview-text' }, chat.last_message_text || 'Sem mensagens'));
    }
    const badges = h('div', { class: 'badges' });
    if (chat.unread_count > 0) badges.appendChild(h('span', { class: 'unread-badge' }, chat.unread_count));
    if (chat.archived) badges.appendChild(h('span', { class: 'tag' }, 'arquivada'));
    if (chat.media && chat.media.total) badges.appendChild(mediaBadge(chat.media));
    const ts = lm ? lm.timestamp : chat.last_message_date;
    const item = h('div', {
      class: 'chat-item' + (state.currentChat && state.currentChat.id === chat.id ? ' active' : ''),
      role: 'listitem', dataset: { id: chat.id }, onclick: () => openChat(chat.id),
    },
      avatar(chat, 49),
      h('div', { class: 'chat-item-body' },
        h('div', { class: 'chat-row' },
          h('div', { class: 'chat-row-title' }, chat.name),
          h('div', { class: 'chat-row-time' + (ts && ts.approx ? ' approx' : ''), title: approxTitle(ts) }, listTime(ts))),
        h('div', { class: 'chat-row' }, preview, badges)));
    return item;
  }

  // ------------------------------------------------------------ conversa
  async function openChat(id) {
    const chat = state.chats.find((c) => c.id === id);
    if (!chat) return;
    state.currentChat = chat;
    document.querySelectorAll('.chat-item').forEach((el) => el.classList.toggle('active', Number(el.dataset.id) === id));
    $('intro').hidden = true;
    $('media-panel').hidden = true;
    $('btn-media-panel').classList.remove('active');
    $('conversation').hidden = false;
    $('app').classList.add('show-chat');
    renderChatHeader(chat);
    const box = $('messages');
    box.textContent = '';
    box.appendChild(h('div', { class: 'messages-loading' }, 'Carregando mensagens…'));
    if (state.drawer === 'message' || state.drawer === 'search') closeDrawer();
    if (state.drawer === 'chat') showChatInfo();
    try {
      const [full, messages] = await Promise.all([
        fetch(`/api/chats/${id}`).then((r) => r.json()),
        fetch(`/api/chats/${id}/messages`).then((r) => r.json()),
      ]);
      if (state.currentChat.id !== id) return;
      state.currentChatFull = full;
      state.messages = messages;
      state.messageIndex = new Map(messages.map((m) => [m.id, m]));
      renderChatHeader(chat, full);
      renderMessages(messages);
    } catch (err) {
      box.textContent = '';
      box.appendChild(h('div', { class: 'messages-loading' }, 'Erro ao carregar mensagens: ' + err.message));
    }
  }

  function renderChatHeader(chat, full) {
    const av = $('chat-avatar');
    av.innerHTML = ICONS[chat.type === 'group' ? 'defaultGroup' : 'defaultUser'];
    $('chat-name').textContent = chat.name;
    let sub;
    if (chat.type === 'group') {
      const parts = full ? full.participants : null;
      sub = parts ? parts.filter((p) => p.active).map((p) => p.name).join(', ') : `${chat.participant_count} participantes`;
    } else {
      sub = chat.phone ? `+${chat.phone}` : chat.jid;
      if (chat.message_count) sub += ` · ${chat.message_count.toLocaleString('pt-BR')} mensagens`;
    }
    $('chat-sub').textContent = sub;
  }

  function renderMessages(messages) {
    const box = $('messages');
    box.textContent = '';
    const frag = document.createDocumentFragment();
    let lastDay = null, lastSenderKey = null, lastWasSystem = false;
    for (const msg of messages) {
      const d = toDate(msg.timestamp);
      const key = dayKey(d);
      if (key !== lastDay) {
        frag.appendChild(h('div', { class: 'day-chip' + (msg.timestamp && msg.timestamp.approx ? ' approx' : ''), title: approxTitle(msg.timestamp) },
          h('span', null, dayLabel(d))));
        lastDay = key;
        lastSenderKey = null;
      }
      if (msg.type === 'group_event') {
        frag.appendChild(h('div', { class: 'system-msg', dataset: { id: msg.id }, onclick: () => showMessageDetails(msg) },
          h('span', null, ...eventText(msg.group_event))));
        lastSenderKey = null; lastWasSystem = true;
        continue;
      }
      const senderKey = msg.from_me ? 'me' : (msg.sender.jid || msg.sender.name);
      const tail = senderKey !== lastSenderKey;
      frag.appendChild(messageEl(msg, tail, tail && !lastWasSystem && lastSenderKey !== null));
      lastSenderKey = senderKey; lastWasSystem = false;
    }
    box.appendChild(frag);
    box.scrollTop = box.scrollHeight;
  }

  function messageEl(msg, tail, gap) {
    const isGroup = state.currentChat.type === 'group';
    const bubble = h('div', { class: 'bubble', onclick: (ev) => { if (!ev.target.closest('a, button, video, audio')) showMessageDetails(msg); } });
    bubble.appendChild(h('span', { class: 'bubble-tail', html: tailSvg(msg.from_me) }));
    const showSender = isGroup && !msg.from_me && tail && msg.type !== 'call';
    const senderEl = showSender
      ? h('div', { class: 'sender-name', style: `color:${senderColor(msg.sender.jid || msg.sender.name)}` }, msg.sender.name,
        msg.sender.unresolved ? h('span', { class: 'sender-jid' }, '(não vinculado)') : null)
      : null;
    const meta = h('div', { class: 'meta' + (msg.timestamp && msg.timestamp.approx ? ' approx' : ''), title: approxTitle(msg.timestamp) },
      msg.starred ? h('span', { class: 'star' }, '★') : null,
      h('span', { class: 'time' }, msg.timestamp ? fmtTime.format(toDate(msg.timestamp)) : '--:--'),
      ticks(msg));

    const media = msg.media;
    if ((msg.type === 'image' || msg.type === 'video' || msg.type === 'gif' || msg.type === 'sticker') && media && media.available) {
      bubble.classList.add('has-media');
      if (media.status === 'corrupted') bubble.appendChild(h('span', { class: 'integrity-flag', title: 'Arquivo divergente/corrompido — ver detalhes' }, icon('warn'), 'divergente'));
      if (senderEl) bubble.appendChild(senderEl);
      if (msg.type === 'video') {
        bubble.appendChild(h('video', { class: 'media-video', controls: '', preload: 'metadata', src: media.url }));
      } else {
        bubble.appendChild(h('img', { class: 'media-img', src: media.url, loading: 'lazy', alt: media.filename || 'imagem',
          onclick: (e) => { e.stopPropagation(); openMediaViewer(media, media.url); } }));
      }
      if (msg.text) bubble.appendChild(h('div', { class: 'media-caption' }, linkify(msg.text), spacer(msg), meta));
      else bubble.appendChild(h('div', { class: 'meta-overlay' }, h('span', null, fmtTime.format(toDate(msg.timestamp))), ticks(msg)));
    } else {
      if (senderEl) bubble.appendChild(senderEl);
      bubble.appendChild(messageBody(msg));
      bubble.appendChild(meta);
    }
    return h('div', { class: ['msg', msg.from_me ? 'out' : 'in', tail ? 'tail' : '', gap ? 'gap' : ''].join(' '), dataset: { id: msg.id } }, bubble);
  }

  function spacer(msg) { return h('span', { class: 'meta-spacer' + (msg.from_me ? ' out' : '') }); }

  function tailSvg(out) {
    return out
      ? '<svg viewBox="0 0 8 13" width="8" height="13"><path fill="currentColor" d="M5.188 1H0v11.193l6.467-8.625C7.526 2.156 6.958 1 5.188 1z"/></svg>'
      : '<svg viewBox="0 0 8 13" width="8" height="13"><path fill="currentColor" d="M1.533 3.568 8 12.193V1H2.812C1.042 1 .474 2.156 1.533 3.568z"/></svg>';
  }

  function messageBody(msg) {
    const media = msg.media;
    switch (msg.type) {
      case 'text':
        return h('div', { class: 'msg-text' }, linkify(msg.text || ''), spacer(msg));
      case 'link':
        return h('div', null,
          msg.link && msg.link.url ? h('a', { class: 'link-preview', href: msg.link.url, target: '_blank', rel: 'noopener noreferrer' },
            h('div', { class: 'lp-title' }, (media && media.title) || msg.link.title || msg.link.url),
            h('div', { class: 'lp-url' }, msg.link.canonical || msg.link.url)) : null,
          h('div', { class: 'msg-text' }, linkify(msg.text || ''), spacer(msg)));
      case 'audio':
        return audioEl(msg);
      case 'document':
        if (media && media.available) {
          return h('div', null, h('div', { class: 'card doc-card', onclick: (e) => { e.stopPropagation(); openMediaViewer(media, media.url); } },
            icon('doc', 'media-icon'),
            h('div', { class: 'card-body' }, h('div', { class: 'card-title' }, media.title || media.filename),
              h('div', { class: 'card-sub' }, `${(media.mime || '').split('/').pop().toUpperCase()} · ${fmtBytes(media.actual_size)}`))),
          msg.text ? h('div', { class: 'msg-text', style: 'margin-top:6px' }, linkify(msg.text)) : null);
        }
        return mediaMissing(msg);
      case 'image': case 'video': case 'gif': case 'sticker':
        return mediaMissing(msg);
      case 'contact':
        return contactCard(msg);
      case 'location':
        return locationEl(msg);
      case 'call':
        return h('div', { class: 'call-msg' }, icon('call', 'call-icon'), h('span', null, 'Chamada', h('div', { class: 'card-sub' }, 'registro de chamada no histórico')));
      case 'deleted':
        return h('div', { class: 'msg-text deleted' }, icon('blocked'), msg.from_me ? 'Você apagou esta mensagem' : 'Esta mensagem foi apagada');
      default:
        return h('div', { class: 'msg-text' }, msg.text || `[${msg.type}]`);
    }
  }

  function mediaMissing(msg) {
    const media = msg.media || {};
    const name = media.local_path ? media.local_path.split('/').pop() : '(sem caminho)';
    return h('div', null,
      h('div', { class: 'media-missing' }, icon(MEDIA_ICON[msg.type] || 'doc', 'media-icon'),
        h('div', null, `${MEDIA_LABEL[msg.type] || 'Mídia'} não incluída no export`,
          h('small', null, name, media.declared_size ? ` · ${fmtBytes(media.declared_size)}` : ''))),
      msg.text ? h('div', { class: 'msg-text', style: 'margin-top:6px' }, linkify(msg.text)) : null);
  }

  function audioEl(msg) {
    const media = msg.media || {};
    const duration = media.duration ? fmtDuration(media.duration) : '';
    const sender = msg.from_me ? null : msg.sender;
    const playBtn = h('button', { class: 'play-btn', html: ICONS.play, disabled: media.available ? null : '', title: media.available ? 'Reproduzir' : 'Arquivo não incluído no export' });
    const progress = h('div', { class: 'audio-progress' });
    const knob = h('div', { class: 'audio-knob' });
    const bar = h('div', { class: 'audio-bar' }, progress, knob);
    const timeEl = h('span', null, duration || (media.available ? '0:00' : 'indisponível'));
    const timeRow = h('div', { class: 'audio-time' }, timeEl, media.available ? null : h('span', null, 'não incluído no export'));
    const wrap = h('div', { class: 'audio' },
      h('div', { class: 'audio-avatar' }, avatar(sender ? 'user' : 'me', 40),
        h('span', { class: 'mic-badge' + (msg.status === 'played' ? ' played' : ''), html: ICONS.micSmall })),
      playBtn, h('div', { class: 'audio-track' }, bar, timeRow));
    if (media.available) {
      const audio = h('audio', { preload: 'none', src: media.url });
      wrap.appendChild(audio);
      let playing = false;
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (playing) audio.pause(); else { document.querySelectorAll('audio').forEach((a) => a !== audio && a.pause()); audio.play(); }
      });
      audio.addEventListener('play', () => { playing = true; playBtn.innerHTML = ICONS.pause; });
      audio.addEventListener('pause', () => { playing = false; playBtn.innerHTML = ICONS.play; });
      audio.addEventListener('ended', () => { progress.style.width = '0'; knob.style.left = '0'; timeEl.textContent = duration || fmtDuration(audio.duration); });
      audio.addEventListener('loadedmetadata', () => { if (!duration && isFinite(audio.duration)) timeEl.textContent = fmtDuration(audio.duration); });
      audio.addEventListener('timeupdate', () => {
        const total = isFinite(audio.duration) ? audio.duration : (media.duration || 0);
        const pct = total ? Math.min(100, audio.currentTime / total * 100) : 0;
        progress.style.width = pct + '%'; knob.style.left = pct + '%';
        timeEl.textContent = fmtDuration(audio.currentTime);
      });
      audio.addEventListener('error', () => { timeEl.textContent = 'formato não suportado'; playBtn.disabled = true; });
      bar.addEventListener('click', (e) => {
        e.stopPropagation();
        const total = isFinite(audio.duration) ? audio.duration : 0;
        if (!total) return;
        const rect = bar.getBoundingClientRect();
        audio.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * total;
      });
    }
    return wrap;
  }

  function contactCard(msg) {
    const media = msg.media || {};
    const tels = [];
    (media.vcard || '').split(/\r?\n/).forEach((line) => {
      const m = /^(?:item\d+\.)?TEL[^:]*:(.+)$/i.exec(line.trim());
      if (m) tels.push(m[1].trim());
    });
    return h('div', null,
      h('div', { class: 'card' }, avatar('user', 40),
        h('div', { class: 'card-body' }, h('div', { class: 'card-title' }, media.vcard_name || 'Contato'),
          h('div', { class: 'card-sub' }, tels.join(' · ') || 'vCard sem telefone'))),
      h('div', { class: 'card-actions' }, h('span', null, 'Contato compartilhado')));
  }

  function locationEl(msg) {
    const media = msg.media || {};
    const lat = media.latitude, lon = media.longitude;
    const coords = lat !== null && lat !== undefined ? `${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}` : 'coordenadas indisponíveis';
    const map = h('div', { class: 'location-map' }, h('span', { class: 'pin', html: ICONS.location.replace('width="16" height="20"', 'width="32" height="40"') }));
    return h('div', null, map,
      h('div', { class: 'msg-text', style: 'margin-top:6px' }, media.title || 'Localização', h('div', { class: 'card-sub mono' }, coords),
        lat !== null && lat !== undefined ? h('a', { href: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`, target: '_blank', rel: 'noopener noreferrer', style: 'font-size:12px' }, 'abrir no OpenStreetMap') : null));
  }

  // ---------------------------------------------------------------- drawer
  function openDrawer(kind, title, body) {
    state.drawer = kind;
    $('drawer-title').textContent = title;
    const el = $('drawer-body');
    el.textContent = '';
    append(el, [body]);
    $('drawer').hidden = false;
    $('btn-msg-search').classList.toggle('active', kind === 'search');
  }
  function closeDrawer() {
    state.drawer = null;
    $('drawer').hidden = true;
    $('btn-msg-search').classList.remove('active');
  }
  function section(title, ...children) { return h('div', { class: 'drawer-section' }, title ? h('h3', null, title) : null, ...children); }
  function kv(rows) {
    const dl = h('dl', { class: 'kv' });
    for (const [k, v, cls] of rows) {
      if (v === null || v === undefined || v === '') continue;
      dl.appendChild(h('dt', null, k));
      dl.appendChild(h('dd', { class: cls || '' }, v));
    }
    return dl;
  }
  function tsRows(label, ts) {
    if (!ts) return [[label, 'não registrado', 'muted']];
    const d = toDate(ts);
    return [
      [label + (ts.approx ? ' (aprox.)' : ''), fmtFull.format(d) + ` (${TZ})`],
      [label + ' UTC', ts.iso, 'mono'],
      ts.approx ? [label + ' janela', `±${Math.round(ts.window_seconds / 60)} min — timestamp truncado no export (valor bruto ${ts.raw})`, 'muted'] : [label + ' bruto', String(ts.raw), 'mono'],
    ];
  }

  function showMessageDetails(msg) {
    const chat = state.currentChat;
    const media = msg.media;
    const rows = [
      ['ID (Z_PK)', String(msg.id), 'mono'],
      ['Ordem (ZSORT)', String(msg.sort), 'mono'],
      ['Conversa', `${chat.name} (#${chat.id})`],
      ['Tipo', `${TYPE_PT[msg.type] || msg.type} (código ${msg.type_code})`],
      ['Direção', msg.from_me ? 'Enviada pelo titular do aparelho' : 'Recebida'],
      ['Remetente', msg.from_me ? 'Titular (ZISFROMME = 1)' : msg.sender.name + (msg.sender.unresolved ? ' — membro não vinculado' : '')],
      ['JID remetente', msg.sender.jid, 'mono'],
      ['Contato (agenda)', msg.sender.contact ? `${msg.sender.contact.full_name || ''} ${msg.sender.contact.phone ? '· ' + msg.sender.contact.phone : ''}`.trim() : null],
      ['Status', `${STATUS_PT[msg.status] || msg.status} (código ${msg.status_code})`],
      ['Erro', msg.error_status ? String(msg.error_status) : null],
      ...tsRows('Data', msg.timestamp),
      ...tsRows('Enviada em', msg.sent_timestamp),
      ['Stanza ID', msg.stanza_id, 'mono'],
      ['ZFROMJID', msg.from_jid, 'mono'],
      ['ZTOJID', msg.to_jid, 'mono'],
      ['Push name', msg.push_name],
      ['Flags', msg.flags !== null ? String(msg.flags) : null, 'mono'],
      ['Favoritada', msg.starred ? 'sim' : null],
    ];
    const parts = [
      section('Mensagem', kv(rows)),
      msg.text ? section('Conteúdo', h('div', { class: 'msg-text', style: 'font-size:13px' }, msg.text)) : null,
    ];
    if (msg.group_event) {
      const ev = msg.group_event;
      parts.push(section('Evento de grupo', kv([
        ['Evento', `${ev.kind} (código ${ev.code})`],
        ['Autor', ev.actor], ['JID autor', ev.actor_jid, 'mono'],
        ['Alvo', ev.target], ['JID alvo', ev.target_jid, 'mono'],
        ['Assunto', ev.subject],
      ])));
    }
    if (media) {
      const hashRow = h('dd', { class: 'mono' });
      const hashBtn = h('button', { class: 'small-btn', onclick: async () => {
        hashBtn.disabled = true; hashBtn.textContent = 'calculando…';
        try { const r = await fetch(`/api/media/${media.id}/hash`).then((x) => x.json()); hashRow.textContent = r.sha256; }
        catch (e) { hashRow.textContent = 'erro: ' + e.message; }
      } }, 'calcular SHA-256');
      hashRow.appendChild(hashBtn);
      const dl = kv([
        ['ID mídia', String(media.id), 'mono'],
        ['Disponível', media.available ? 'sim — arquivo presente no export' : 'não — somente metadados'],
        ['Integridade', { ok: 'Íntegra', missing: 'Ausente', corrupted: 'Corrompida / divergente' }[media.status] || media.status],
        ['Problemas', (media.issues || []).concat(media.warnings || []).map((c) => (window.WAMedia ? window.WAMedia.issueLabel(c) : c)).join('; ') || null],
        ['Arquivo', media.filename, 'mono'],
        ['Caminho original', media.local_path, 'mono'],
        ['Miniatura', media.thumbnail_path, 'mono'],
        ['MIME (conteúdo)', media.mime, 'mono'],
        ['Tamanho declarado', media.declared_size !== null ? `${fmtBytes(media.declared_size)} (${media.declared_size} B)` : null],
        ['Tamanho real', media.actual_size !== null ? `${fmtBytes(media.actual_size)} (${media.actual_size} B)` : null],
        ['Divergência', media.actual_size !== null && media.declared_size !== null && media.actual_size !== media.declared_size ? 'tamanho real ≠ declarado' : null],
        ['Duração', media.duration ? fmtDuration(media.duration) : null],
        ['Título', media.title], ['vCard', media.vcard_name],
        ['Latitude', media.latitude !== null ? String(media.latitude) : null, 'mono'],
        ['Longitude', media.longitude !== null ? String(media.longitude) : null, 'mono'],
        ['URL remota', media.remote_url, 'mono'],
        ['Chave de mídia', media.has_media_key ? 'presente' : null],
        ['Origem / nuvem', media.origin !== null || media.cloud_status !== null ? `${media.origin ?? '—'} / ${media.cloud_status ?? '—'}` : null, 'mono'],
      ]);
      if (media.available) { dl.appendChild(h('dt', null, 'SHA-256')); dl.appendChild(hashRow); }
      parts.push(section('Mídia', dl, media.vcard ? h('pre', { class: 'mono', style: 'white-space:pre-wrap;font-size:11px;margin:10px 0 0;color:#54656f' }, media.vcard) : null));
    }
    if (msg.receipts && msg.receipts.length) {
      parts.push(section('Recibos (ZRECEIPTINFO)', ...msg.receipts.map((r) => h('div', { class: 'receipt' },
        h('div', { class: 'r-jid mono' }, r.jid),
        kv([
          ['Entregue', r.delivered ? fmtFull.format(toDate(r.delivered)) : null],
          ['Lida', r.read ? fmtFull.format(toDate(r.read)) : null],
          ['Reproduzida', r.played ? fmtFull.format(toDate(r.played)) : null],
        ])))));
    }
    if (msg.link) parts.push(section('Link detectado', kv([['URL', msg.link.url, 'mono'], ['Canônica', msg.link.canonical, 'mono'], ['Título', msg.link.title], ['Resumo', msg.link.summary]])));
    openDrawer('message', 'Dados da mensagem', parts);
    const el = document.querySelector(`.msg[data-id="${msg.id}"], .system-msg[data-id="${msg.id}"]`);
    if (el) { el.classList.remove('highlight'); void el.offsetWidth; el.classList.add('highlight'); }
  }

  function showChatInfo() {
    const chat = state.currentChatFull || state.currentChat;
    if (!chat) return;
    const msgs = state.messages;
    const first = msgs.find((m) => m.timestamp), last = [...msgs].reverse().find((m) => m.timestamp);
    const counts = { out: 0, in: 0, media: 0 };
    for (const m of msgs) { if (m.from_me) counts.out++; else if (m.type !== 'group_event') counts.in++; if (m.media) counts.media++; }
    const parts = [
      h('div', { class: 'drawer-section profile' }, avatar(chat, 200),
        h('div', { class: 'name' }, chat.name),
        h('div', { class: 'sub' }, chat.type === 'group' ? `Grupo · ${chat.participants.length} participantes` : (chat.phone ? '+' + chat.phone : chat.jid))),
      section('Identificação', kv([
        ['ID da sessão', String(chat.id), 'mono'],
        ['JID (bruto)', chat.jid, 'mono'],
        ['JID normalizado', chat.jid_normalized, 'mono'],
        ['Tipo', chat.type === 'group' ? 'Grupo' : chat.type === 'broadcast' ? 'Lista de transmissão' : 'Individual'],
        ['Nome exibido (ZPARTNERNAME)', chat.name],
        ['Arquivada / removida / oculta', `${chat.archived ? 'sim' : 'não'} / ${chat.removed ? 'sim' : 'não'} / ${chat.hidden ? 'sim' : 'não'}`],
        ['Não lidas (ZUNREADCOUNT)', String(chat.unread_count)],
        ['Contador (ZMESSAGECOUNTER)', String(chat.message_counter)],
      ])),
      section('Mensagens', kv([
        ['Total no banco', msgs.length.toLocaleString('pt-BR')],
        ['Enviadas / recebidas', `${counts.out} / ${counts.in}`],
        ['Com mídia', String(counts.media)],
        ['Primeira', first ? fmtFull.format(toDate(first.timestamp)) + (first.timestamp.approx ? ' (aprox.)' : '') : null],
        ['Última', last ? fmtFull.format(toDate(last.timestamp)) + (last.timestamp.approx ? ' (aprox.)' : '') : null],
      ])),
    ];
    if (window.WAMedia) parts.push(window.WAMedia.chatInfoSection(chat.id));
    if (chat.contact) {
      const c = chat.contact;
      parts.push(section('Agenda (Contacts.sqlite)', kv([
        ['Nome completo', c.full_name], ['Primeiro nome', c.first_name], ['Apelido', c.nickname],
        ['Telefone', c.phone ? `${c.phone}${c.phone_label ? ' (' + c.phone_label + ')' : ''}` : null],
        ['ID na agenda (AB)', c.address_book_id !== null ? String(c.address_book_id) : null, 'mono'],
      ])));
    } else if (chat.type !== 'group') {
      parts.push(section('Agenda (Contacts.sqlite)', h('div', { class: 'kv' }, h('dd', { class: 'muted' }, 'Sem correspondência na agenda exportada.'))));
    }
    if (chat.type === 'group') {
      const g = chat.group || {};
      parts.push(section('Grupo', kv([
        ['Criado em', g.created ? fmtFull.format(toDate(g.created)) + (g.created.approx ? ' (aprox.)' : '') : null],
        ['Criador (JID)', g.creator_jid, 'mono'], ['Proprietário (JID)', g.owner_jid, 'mono'],
        ['Imagem', g.picture_path, 'mono'],
      ])));
      parts.push(section(`${chat.participants.length} participantes`, ...chat.participants.map((p) => h('div', { class: 'participant' }, avatar('user', 40),
        h('div', { class: 'p-body' }, h('div', { class: 'p-name', style: `color:${senderColor(p.jid)}` }, p.name),
          h('div', { class: 'p-jid mono' }, p.jid, p.contact && p.contact.full_name ? ` · agenda: ${p.contact.full_name}` : '')),
        p.admin ? h('span', { class: 'admin' }, 'admin') : null,
        !p.active ? h('span', { class: 'inactive' }, 'saiu') : null))));
    }
    openDrawer('chat', chat.type === 'group' ? 'Dados do grupo' : 'Dados do contato', parts);
  }

  function showCaseInfo() {
    const s = state.summary;
    const integ = s.integrity || {};
    const fileRows = (label, f) => f ? [[label, f.name, 'mono'], [label + ' tamanho', `${fmtBytes(f.size)} (${f.size} B)`], [label + ' SHA-256', f.sha256, 'mono']] : [];
    openDrawer('case', 'Informações do export', [
      section('Carga', kv([
        ['Conversas', String(s.chats)], ['Grupos', String(s.groups)], ['Mensagens', s.messages.toLocaleString('pt-BR')],
        ['Mídias vinculadas', `${s.media_linked} itens de mídia vinculados a ${integ.media_files ?? '—'} arquivos do export`],
        ['Contatos (agenda)', String(s.contacts)],
        ['Pastas de mídia extras', (integ.extra_media_dirs && integ.extra_media_dirs.length) ? integ.extra_media_dirs.join(' · ') : null, 'mono'],
        ['Fuso horário de exibição', TZ],
      ])),
      section('Integridade (SHA-256)', kv([
        ...fileRows('ZIP', integ.source_zip), ...fileRows('ChatStorage', integ.chat_db), ...fileRows('Contacts', integ.contacts_db),
      ])),
      section('Notas', h('div', { style: 'font-size:13px;color:#54656f;line-height:19px' },
        'Timestamps marcados com "~" ou "(aprox.)" foram truncados no export para 5 dígitos; o valor exibido é o início de uma janela de ~2h47min. ',
        'JIDs com sufixo "~N" são artefato de anonimização e foram normalizados para correlação. ',
        'Tipos MIME são detectados pelo conteúdo do arquivo, não pela extensão.')),
    ]);
  }

  function showSearch() {
    const input = h('input', { type: 'text', placeholder: 'Pesquisar mensagens…', autocomplete: 'off' });
    const results = h('div', { class: 'search-results' }, h('div', { class: 'search-hint' }, 'Pesquisar mensagens em ', b(state.currentChat.name)));
    let timer;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runSearch, 150); });
    function runSearch() {
      const q = input.value.trim().toLowerCase();
      results.textContent = '';
      if (!q) { results.appendChild(h('div', { class: 'search-hint' }, 'Digite para pesquisar')); return; }
      const hits = state.messages.filter((m) => (m.text && m.text.toLowerCase().includes(q)) || (m.sender.name && m.sender.name.toLowerCase().includes(q)) || (m.stanza_id && m.stanza_id.toLowerCase() === q) || String(m.id) === q);
      if (!hits.length) { results.appendChild(h('div', { class: 'search-hint' }, 'Nenhuma mensagem encontrada')); return; }
      const frag = document.createDocumentFragment();
      for (const m of hits.slice(0, 300)) {
        const text = m.text || MEDIA_LABEL[m.type] || TYPE_PT[m.type] || '';
        const idx = text.toLowerCase().indexOf(q);
        const snippet = idx >= 0 ? [text.slice(Math.max(0, idx - 40), idx), h('mark', null, text.slice(idx, idx + q.length)), text.slice(idx + q.length, idx + q.length + 80)] : [text];
        frag.appendChild(h('div', { class: 'search-result', onclick: () => scrollToMessage(m.id) },
          h('div', { class: 'sr-meta' }, h('span', null, m.sender.name), h('span', null, m.timestamp ? fmtDate.format(toDate(m.timestamp)) + ' ' + fmtTime.format(toDate(m.timestamp)) : '')),
          h('div', { class: 'sr-text' }, ...snippet)));
      }
      if (hits.length > 300) frag.appendChild(h('div', { class: 'search-hint' }, `${hits.length} resultados; exibindo os 300 primeiros`));
      results.appendChild(frag);
    }
    openDrawer('search', 'Pesquisar mensagens', [h('div', { class: 'drawer-search' }, h('div', { class: 'search-box' }, icon('search', 'search-icon'), input)), results]);
    input.focus();
  }

  function scrollToMessage(id) {
    const el = document.querySelector(`.msg[data-id="${id}"], .system-msg[data-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('highlight'); void el.offsetWidth; el.classList.add('highlight');
  }

  /* Visualizador forense (media.js) com navegação pelas mídias da conversa; lightbox simples como reserva. */
  function openMediaViewer(media, url) {
    if (window.WAMedia && state.currentChat) window.WAMedia.openForChat(state.currentChat.id, media.id);
    else openLightbox(url);
  }

  function openLightbox(url) {
    const lb = $('lightbox');
    const content = lb.querySelector('.lightbox-content');
    content.textContent = '';
    content.appendChild(h('img', { src: url, alt: '' }));
    lb.hidden = false;
  }

  // ---------------------------------------------------------------- eventos
  $('chat-search').addEventListener('input', (e) => { state.query = e.target.value; renderChatList(); });
  $('chat-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    $('chat-filters').querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderChatList();
  });
  $('btn-chat-info').addEventListener('click', showChatInfo);
  $('chat-avatar').addEventListener('click', showChatInfo);
  $('btn-chat-menu').addEventListener('click', showChatInfo);
  $('btn-msg-search').addEventListener('click', () => state.drawer === 'search' ? closeDrawer() : showSearch());
  $('btn-case-info').addEventListener('click', () => state.drawer === 'case' ? closeDrawer() : showCaseInfo());
  $('btn-drawer-close').addEventListener('click', closeDrawer);
  $('lightbox').addEventListener('click', (e) => { if (e.target === e.currentTarget || e.target.closest('.lightbox-close')) $('lightbox').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('lightbox').hidden) $('lightbox').hidden = true; else if (state.drawer) closeDrawer(); }
  });
  const backBtn = h('button', { class: 'icon-btn back-btn', html: ICONS.back, title: 'Voltar', onclick: () => { $('app').classList.remove('show-chat'); } });
  document.querySelector('.chat-header').prepend(backBtn);

  window.WA = {
    state, h, icon, b, append, $, ICONS, avatar, senderColor, toDate, fmtTime, fmtDate, fmtFull, fmtBytes, fmtDuration,
    approxTitle, openChat, scrollToMessage, closeDrawer, openDrawer, section, kv, reloadExport, MEDIA_LABEL, MEDIA_ICON,
    showMessage: (id) => { const m = state.messageIndex.get(id); if (m) showMessageDetails(m); },
  };

  loadChats().catch((err) => { $('intro-summary').textContent = 'Erro ao carregar export: ' + err.message; });
})();
