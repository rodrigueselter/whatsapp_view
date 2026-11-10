/* Upload de export, análise forense de mídias e visualizador de mídia. */
(function () {
  'use strict';

  const WA = window.WA;
  if (!WA) return;
  const { h, icon, $, ICONS, fmtBytes, fmtDuration, toDate, fmtDate, fmtTime, fmtFull, approxTitle } = WA;

  const STATUS = {
    ok: { label: 'Íntegra', plural: 'Íntegras', icon: 'okIcon', cls: 'st-ok' },
    missing: { label: 'Ausente', plural: 'Ausentes', icon: 'missingIcon', cls: 'st-missing' },
    corrupted: { label: 'Corrompida / divergente', plural: 'Corrompidas / divergentes', icon: 'warn', cls: 'st-corrupted' },
  };
  const KIND = {
    image: { label: 'Imagem', plural: 'Imagens', series: 'image' },
    video: { label: 'Vídeo', plural: 'Vídeos', series: 'video' },
    audio: { label: 'Áudio', plural: 'Áudios', series: 'audio' },
    document: { label: 'Documento', plural: 'Documentos', series: 'other' },
    gif: { label: 'GIF', plural: 'GIFs', series: 'other' },
    sticker: { label: 'Figurinha', plural: 'Figurinhas', series: 'other' },
  };
  // Cores categóricas em ordem fixa (validadas para daltonismo); a cor segue a entidade.
  const SERIES = [
    { key: 'image', label: 'Imagens', color: '#2a78d6' },
    { key: 'video', label: 'Vídeos', color: '#eb6834' },
    { key: 'audio', label: 'Áudios', color: '#1baf7a' },
    { key: 'other', label: 'Documentos e outros', color: '#eda100' },
  ];
  const ISSUES = {
    empty: 'arquivo vazio (0 bytes)',
    unreadable: 'arquivo ilegível',
    truncated: 'estrutura do arquivo incompleta (truncado)',
    type_mismatch: 'conteúdo incompatível com o tipo da mensagem',
    size_mismatch: 'tamanho diferente do declarado no banco',
    extension_mismatch: 'extensão não corresponde ao conteúdo',
    not_in_export: 'arquivo não incluído no export',
    no_local_path: 'mensagem sem caminho local de mídia no banco',
  };
  const issueLabel = (c) => ISSUES[c] || c;
  const fmtMonth = new Intl.DateTimeFormat('pt-BR', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const fmtMonthLong = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
  const pct = (a, b) => (b ? (a / b * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%' : '—');
  const api = async (url) => {
    const r = await fetch(url);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.message || `HTTP ${r.status}`);
    return body;
  };
  function statusPill(status) {
    const s = STATUS[status] || { label: status, icon: 'missingIcon', cls: '' };
    return h('span', { class: 'status-pill ' + s.cls }, icon(s.icon), s.label);
  }
  function itemDate(it) {
    if (!it.timestamp) return 'data desconhecida';
    const d = toDate(it.timestamp);
    return `${it.timestamp.approx ? '~' : ''}${fmtDate.format(d)} ${fmtTime.format(d)}`;
  }

  // =================================================================== UPLOAD
  const upload = { xhr: null, status: null };

  function renderUploadZone() {
    const zone = $('upload-zone');
    zone.textContent = '';
    const max = upload.status ? upload.status.max_upload : null;
    zone.appendChild(h('button', { class: 'dropzone', id: 'dropzone', type: 'button', onclick: () => $('upload-input').click() },
      h('span', { class: 'dz-icon', html: ICONS.upload }),
      h('span', { class: 'dz-title' }, upload.status && upload.status.loaded ? 'Carregar outro export (.zip)' : 'Carregar export do WhatsApp (.zip)'),
      h('span', { class: 'dz-sub' }, 'Arraste o arquivo para esta janela ou clique para selecionar',
        max ? ` · limite ${fmtBytes(max)}` : '')));
    if (upload.status && upload.status.upload) {
      const u = upload.status.upload;
      zone.appendChild(h('div', { class: 'dz-last mono', title: 'SHA-256 do ZIP recebido' }, `${u.original_name} · SHA-256 ${u.sha256.slice(0, 16)}…`));
    }
  }

  function modal(...children) {
    const m = $('upload-modal');
    m.textContent = '';
    m.appendChild(h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true' }, ...children));
    m.hidden = false;
    return m;
  }
  function closeModal() { $('upload-modal').hidden = true; }

  function validateFile(file) {
    if (!file) return 'Nenhum arquivo selecionado.';
    if (!/\.zip$/i.test(file.name)) return 'Selecione um arquivo com extensão .zip.';
    if (file.size === 0) return 'O arquivo está vazio.';
    const max = upload.status && upload.status.max_upload;
    if (max && file.size > max) return `O arquivo tem ${fmtBytes(file.size)} e excede o limite de ${fmtBytes(max)} configurado no servidor.`;
    return null;
  }

  function showUploadError(title, message) {
    modal(h('h2', null, title), h('p', { class: 'modal-error' }, message),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: closeModal }, 'Fechar'),
        h('button', { class: 'btn primary', onclick: () => { closeModal(); $('upload-input').click(); } }, 'Escolher outro arquivo')));
  }

  function startUpload(file) {
    const err = validateFile(file);
    if (err) return showUploadError('Arquivo não aceito', err);
    if (upload.status && upload.status.busy) return showUploadError('Servidor ocupado', 'Outro upload está em processamento.');
    if (upload.status && upload.status.loaded &&
        !window.confirm(`Substituir o export carregado por "${file.name}"? A análise atual será descartada.`)) return;
    const bar = h('div', { class: 'progress-bar' });
    const label = h('div', { class: 'progress-label' }, 'Enviando… 0%');
    const cancel = h('button', { class: 'btn', onclick: () => upload.xhr && upload.xhr.abort() }, 'Cancelar');
    modal(h('h2', null, 'Carregando export'), h('div', { class: 'modal-file mono' }, `${file.name} · ${fmtBytes(file.size)}`),
      h('div', { class: 'progress' }, bar), label, h('div', { class: 'modal-actions' }, cancel));
    const xhr = new XMLHttpRequest();
    upload.xhr = xhr;
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Content-Type', 'application/zip');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = Math.round(e.loaded / e.total * 100);
      bar.style.width = p + '%';
      label.textContent = `Enviando… ${p}% (${fmtBytes(e.loaded)} de ${fmtBytes(e.total)})`;
    };
    xhr.upload.onload = () => {
      bar.style.width = '100%'; bar.classList.add('indeterminate');
      label.textContent = 'Validando, extraindo e indexando no servidor…';
      cancel.disabled = true;
    };
    xhr.onload = async () => {
      upload.xhr = null;
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch (_) { /* resposta não-JSON */ }
      if (xhr.status !== 200) {
        return showUploadError('Falha no upload', body.message || `O servidor respondeu HTTP ${xhr.status}.`);
      }
      const s = body.summary, u = body.upload;
      await WA.reloadExport();
      modal(h('h2', null, 'Export carregado'),
        WA.kv([
          ['Arquivo', u.original_name], ['Tamanho', `${fmtBytes(u.size)} (${nf(u.size)} B)`],
          ['SHA-256', u.sha256, 'mono'], ['Arquivos extraídos', nf(u.files_extracted)],
          ['Conversas', `${nf(s.chats)} (${nf(s.groups)} grupos)`], ['Mensagens', nf(s.messages)],
          ['Mídias', `${nf(s.media_status.total)} referenciadas · ${nf(s.media_status.ok)} íntegras · ${nf(s.media_status.missing)} ausentes · ${nf(s.media_status.corrupted)} corrompidas`],
          ['Processado em', `${u.seconds.toLocaleString('pt-BR')} s`],
        ]),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn', onclick: closeModal }, 'Ver conversas'),
          h('button', { class: 'btn primary', onclick: () => { closeModal(); openPanel(null); } }, 'Analisar mídias')));
    };
    xhr.onerror = () => { upload.xhr = null; showUploadError('Falha de conexão', 'A conexão foi interrompida. O servidor pode ter recusado o arquivo (tamanho ou formato) ou estar indisponível.'); };
    xhr.onabort = () => { upload.xhr = null; closeModal(); };
    xhr.send(file);
  }

  $('upload-input').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) startUpload(f); });
  $('btn-upload').addEventListener('click', () => $('upload-input').click());
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    if (e.dataTransfer.files.length > 1) return showUploadError('Arquivo não aceito', 'Envie apenas um arquivo .zip por vez.');
    startUpload(e.dataTransfer.files[0]);
  });
  document.addEventListener('wa:status', (e) => {
    upload.status = e.detail;
    renderUploadZone();
    $('btn-media-panel').disabled = !e.detail.loaded;
    $('btn-media-panel').classList.toggle('disabled', !e.detail.loaded);
    if (!panel.el.hidden) closePanel();
    chatCache.clear();
  });

  // ======================================================== PAINEL DE MÍDIAS
  const panel = { el: $('media-panel'), chatId: null, status: '', kind: '', items: [], total: 0, summary: null, returnTo: null };
  const chatCache = new Map();

  function openPanel(chatId) {
    if (!upload.status || !upload.status.loaded) return;
    panel.returnTo = WA.state.currentChat && !$('conversation').hidden ? WA.state.currentChat.id : null;
    panel.chatId = chatId; panel.status = ''; panel.kind = '';
    WA.closeDrawer();
    $('intro').hidden = true; $('conversation').hidden = true; panel.el.hidden = false;
    $('app').classList.add('show-chat');
    $('btn-media-panel').classList.add('active');
    renderPanel();
  }
  function closePanel() {
    panel.el.hidden = true;
    $('btn-media-panel').classList.remove('active');
    if (panel.returnTo && WA.state.currentChat && WA.state.currentChat.id === panel.returnTo) $('conversation').hidden = false;
    else { $('intro').hidden = false; $('app').classList.remove('show-chat'); }
  }
  $('btn-media-panel').addEventListener('click', () => (panel.el.hidden ? openPanel(null) : closePanel()));

  async function renderPanel() {
    const el = panel.el;
    el.textContent = '';
    const scope = h('select', { class: 'scope-select', 'aria-label': 'Escopo da análise', onchange: (e) => { panel.chatId = e.target.value ? Number(e.target.value) : null; panel.status = ''; panel.kind = ''; renderPanel(); } },
      h('option', { value: '' }, 'Todas as conversas'),
      WA.state.chats.filter((c) => c.media && c.media.total).map((c) => h('option', { value: c.id, selected: c.id === panel.chatId ? '' : null }, `${c.name} (${c.media.total})`)));
    el.appendChild(h('header', { class: 'pane-header panel-header' },
      h('button', { class: 'icon-btn', title: 'Fechar análise', html: ICONS.back, onclick: closePanel }),
      h('div', { class: 'panel-title' }, h('div', { class: 'chat-name' }, 'Análise forense de mídias'),
        h('div', { class: 'chat-sub' }, panel.chatId ? 'Escopo: conversa selecionada' : 'Escopo: todo o export')),
      window.WAAI ? window.WAAI.panelButton(panel.chatId) : null,
      scope));
    const body = h('div', { class: 'panel-body' }, h('div', { class: 'messages-loading' }, 'Calculando…'));
    el.appendChild(body);
    try {
      panel.summary = await api('/api/media-summary' + (panel.chatId ? `?chat=${panel.chatId}` : ''));
    } catch (err) {
      body.textContent = ''; body.appendChild(h('div', { class: 'messages-loading' }, 'Erro: ' + err.message)); return;
    }
    const s = panel.summary;
    body.textContent = '';
    if (!s.totals.total) {
      body.appendChild(h('div', { class: 'search-hint' }, 'Nenhuma mídia referenciada neste escopo.'));
      return;
    }
    body.appendChild(kpis(s));
    body.appendChild(card('Por tipo de mídia', kindTable(s)));
    body.appendChild(card('Linha do tempo de envio (mensal)', timeline(s)));
    if (s.issues.length) body.appendChild(card('Verificações de integridade', issuesList(s)));
    const grid = h('div', { class: 'panel-grid' });
    if (!panel.chatId) grid.appendChild(card(`Conversas com mídia (${nf(s.chats_with_media)})`, rankTable(s.per_chat, 'chat')));
    grid.appendChild(card(`Por participante (${nf(s.per_sender.length)})`, rankTable(s.per_sender, 'sender')));
    body.appendChild(grid);
    body.appendChild(gallery());
  }

  function card(title, ...children) {
    return h('section', { class: 'panel-card' }, h('h3', null, title), ...children);
  }

  function kpis(s) {
    const t = s.totals;
    const period = s.first_unix ? `${fmtDate.format(new Date(s.first_unix * 1000))} a ${fmtDate.format(new Date(s.last_unix * 1000))}` : '—';
    const tile = (value, label, sub, cls, onclick) => h(onclick ? 'button' : 'div', { class: 'kpi ' + (cls || ''), onclick, type: onclick ? 'button' : null },
      h('div', { class: 'kpi-label' }, cls && STATUS[cls.replace('st-', '').replace('kpi-', '')] ? icon(STATUS[cls.replace('kpi-', '')].icon) : null, label),
      h('div', { class: 'kpi-value' }, value), sub ? h('div', { class: 'kpi-sub' }, sub) : null);
    const go = (status) => () => { panel.status = status; refreshGallery(true); document.getElementById('gallery').scrollIntoView({ behavior: 'smooth' }); };
    return h('div', { class: 'kpi-row' },
      tile(nf(t.total), 'Mídias referenciadas', `${nf(s.chats_with_media)} conversa(s)`, '', go('')),
      tile(nf(t.ok), 'Íntegras', pct(t.ok, t.total), 'kpi-ok', go('ok')),
      tile(nf(t.missing), 'Ausentes', pct(t.missing, t.total), 'kpi-missing', go('missing')),
      tile(nf(t.corrupted), 'Corrompidas / divergentes', pct(t.corrupted, t.total), 'kpi-corrupted', go('corrupted')),
      tile(fmtBytes(t.declared_bytes), 'Volume declarado', 'soma de ZFILESIZE'),
      tile(fmtBytes(t.present_bytes), 'Volume presente', `${pct(t.present_bytes, t.declared_bytes)} do declarado`),
      tile(period, 'Período', 'primeira e última mídia', 'kpi-period'));
  }

  function statusBar(row) {
    const total = row.total || 1;
    const seg = (k) => row[k] ? h('span', { class: 'sb-seg ' + STATUS[k].cls, style: `flex:${row[k]}`, title: `${STATUS[k].plural}: ${nf(row[k])} (${pct(row[k], total)})` }) : null;
    return h('div', { class: 'status-bar' }, seg('ok'), seg('corrupted'), seg('missing'));
  }

  function kindTable(s) {
    const rows = Object.entries(s.by_kind);
    return h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
      h('thead', null, h('tr', null, h('th', null, 'Tipo'), h('th', { class: 'num' }, 'Total'), h('th', { class: 'num' }, 'Íntegras'),
        h('th', { class: 'num' }, 'Ausentes'), h('th', { class: 'num' }, 'Corromp.'), h('th', null, 'Situação'),
        h('th', { class: 'num' }, 'Vol. declarado'), h('th', { class: 'num' }, 'Vol. presente'))),
      h('tbody', null, rows.map(([k, r]) => h('tr', { class: 'clickable', onclick: () => { panel.kind = k; panel.status = ''; refreshGallery(true); document.getElementById('gallery').scrollIntoView({ behavior: 'smooth' }); } },
        h('td', null, h('span', { class: 'swatch', style: `background:${seriesColor(k)}` }), (KIND[k] || { plural: k }).plural),
        h('td', { class: 'num' }, nf(r.total)), h('td', { class: 'num' }, nf(r.ok)), h('td', { class: 'num' }, nf(r.missing)),
        h('td', { class: 'num' }, nf(r.corrupted)), h('td', { class: 'bar-cell' }, statusBar(r)),
        h('td', { class: 'num' }, fmtBytes(r.declared_bytes)), h('td', { class: 'num' }, fmtBytes(r.present_bytes))))),
      h('tfoot', null, h('tr', null, h('td', null, 'Total'), h('td', { class: 'num' }, nf(s.totals.total)), h('td', { class: 'num' }, nf(s.totals.ok)),
        h('td', { class: 'num' }, nf(s.totals.missing)), h('td', { class: 'num' }, nf(s.totals.corrupted)), h('td', { class: 'bar-cell' }, statusBar(s.totals)),
        h('td', { class: 'num' }, fmtBytes(s.totals.declared_bytes)), h('td', { class: 'num' }, fmtBytes(s.totals.present_bytes))))),
      h('div', { class: 'legend' }, ['ok', 'corrupted', 'missing'].map((k) => h('span', { class: 'legend-item' }, h('span', { class: 'swatch ' + STATUS[k].cls }), STATUS[k].plural))));
  }
  function seriesColor(kind) { const key = (KIND[kind] || { series: 'other' }).series; return SERIES.find((x) => x.key === key).color; }

  // ------------------------------------------------------------ linha do tempo
  function timeline(s) {
    const rows = s.timeline.map((r) => {
      const v = { month: r.month, ok: r._ok || 0, missing: r._missing || 0, corrupted: r._corrupted || 0 };
      for (const ser of SERIES) v[ser.key] = 0;
      for (const [k, n] of Object.entries(r)) if (KIND[k]) v[KIND[k].series] += n;
      v.total = SERIES.reduce((a, ser) => a + v[ser.key], 0);
      return v;
    });
    const present = SERIES.filter((ser) => rows.some((r) => r[ser.key]));
    const wrap = h('div', { class: 'timeline' });
    const legend = present.length > 1 ? h('div', { class: 'legend' }, present.map((ser) => h('span', { class: 'legend-item' }, h('span', { class: 'swatch', style: `background:${ser.color}` }), ser.label))) : null;
    const chartBox = h('div', { class: 'chart-box' });
    const tip = h('div', { class: 'chart-tip', hidden: '' });
    const tableBox = h('div', { class: 'table-wrap', hidden: '' });
    const toggle = h('button', { class: 'small-btn', onclick: () => { tableBox.hidden = !tableBox.hidden; chartBox.hidden = !tableBox.hidden; toggle.textContent = tableBox.hidden ? 'Ver tabela' : 'Ver gráfico'; } }, 'Ver tabela');
    wrap.append(h('div', { class: 'chart-toolbar' }, legend, toggle), chartBox, tableBox);
    chartBox.appendChild(tip);
    tableBox.appendChild(h('table', { class: 'data-table' },
      h('thead', null, h('tr', null, h('th', null, 'Mês'), present.map((ser) => h('th', { class: 'num' }, ser.label)), h('th', { class: 'num' }, 'Total'),
        h('th', { class: 'num' }, 'Íntegras'), h('th', { class: 'num' }, 'Ausentes'), h('th', { class: 'num' }, 'Corromp.'))),
      h('tbody', null, rows.filter((r) => r.total).map((r) => h('tr', null, h('td', null, cap(fmtMonthLong.format(new Date(r.month + '-01T00:00:00Z')))),
        present.map((ser) => h('td', { class: 'num' }, nf(r[ser.key]))), h('td', { class: 'num' }, nf(r.total)),
        h('td', { class: 'num' }, nf(r.ok)), h('td', { class: 'num' }, nf(r.missing)), h('td', { class: 'num' }, nf(r.corrupted)))))));

    const draw = () => {
      const W = Math.max(320, chartBox.clientWidth || 640), H = 220;
      const m = { l: 40, r: 8, t: 10, b: 26 };
      const iw = W - m.l - m.r, ih = H - m.t - m.b;
      const max = Math.max(1, ...rows.map((r) => r.total));
      const step = niceStep(max / 4); const top = Math.ceil(max / step) * step;
      const y = (v) => m.t + ih - v / top * ih;
      const bw = iw / rows.length; const barW = Math.max(2, Math.min(28, bw - 2));
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
      svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Mídias por mês, empilhadas por tipo');
      const el = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; svg.appendChild(e); return e; };
      for (let v = 0; v <= top; v += step) {
        el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v ? 'grid' : 'axis' });
        el('text', { x: m.l - 6, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, nf(v));
      }
      const every = Math.ceil(rows.length / Math.max(1, Math.floor(iw / 56)));
      rows.forEach((r, i) => {
        const x = m.l + i * bw + (bw - barW) / 2;
        let acc = 0;
        const segs = present.filter((ser) => r[ser.key]);
        segs.forEach((ser, j) => {
          const y0 = y(acc), y1 = y(acc + r[ser.key]);
          const gap = j > 0 ? 1 : 0; // 2px de separação entre segmentos (1px de cada lado)
          const hgt = Math.max(0, y0 - y1 - gap - (j < segs.length - 1 ? 1 : 0));
          const isTop = j === segs.length - 1;
          const rx = isTop ? Math.min(4, barW / 2, hgt) : 0;
          // retângulo com cantos arredondados só no topo (extremidade dos dados)
          const yy = y1 + (j < segs.length - 1 ? 1 : 0);
          el('path', { d: roundTop(x, yy, barW, hgt, rx), fill: ser.color });
          acc += r[ser.key];
        });
        if (i % every === 0) el('text', { x: m.l + i * bw + bw / 2, y: H - 8, class: 'tick', 'text-anchor': 'middle' }, fmtMonth.format(new Date(r.month + '-01T00:00:00Z')));
        const hit = el('rect', { x: m.l + i * bw, y: m.t, width: bw, height: ih, class: 'hit' });
        hit.addEventListener('mouseenter', () => showTip(r, i));
        hit.addEventListener('mousemove', () => showTip(r, i));
        hit.addEventListener('mouseleave', () => { tip.hidden = true; hover.setAttribute('opacity', 0); });
      });
      const hover = el('rect', { x: 0, y: m.t, width: bw, height: ih, class: 'hover-band', opacity: 0 });
      hover.style.pointerEvents = 'none';
      function showTip(r, i) {
        hover.setAttribute('x', m.l + i * bw); hover.setAttribute('opacity', 1);
        tip.textContent = '';
        tip.append(h('div', { class: 'tip-title' }, cap(fmtMonthLong.format(new Date(r.month + '-01T00:00:00Z')))),
          ...present.map((ser) => h('div', { class: 'tip-row' }, h('span', { class: 'swatch', style: `background:${ser.color}` }), ser.label, h('b', null, nf(r[ser.key])))),
          h('div', { class: 'tip-row tip-sep' }, statusPill('ok'), h('b', null, nf(r.ok))),
          h('div', { class: 'tip-row' }, statusPill('missing'), h('b', null, nf(r.missing))),
          h('div', { class: 'tip-row' }, statusPill('corrupted'), h('b', null, nf(r.corrupted))));
        tip.hidden = false;
        const left = m.l + i * bw + bw / 2;
        tip.style.left = Math.min(W - 230, Math.max(0, left + 12)) + 'px';
      }
      chartBox.querySelectorAll('svg').forEach((n) => n.remove());
      chartBox.insertBefore(svg, tip);
    };
    requestAnimationFrame(draw);
    let t; const onResize = () => { clearTimeout(t); t = setTimeout(() => { if (document.body.contains(chartBox)) draw(); else window.removeEventListener('resize', onResize); }, 120); };
    window.addEventListener('resize', onResize);
    return wrap;
  }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
    const n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }
  function roundTop(x, y, w, hgt, r) {
    if (hgt <= 0) return '';
    r = Math.max(0, Math.min(r, w / 2, hgt));
    return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
  }

  function issuesList(s) {
    const total = s.totals.total;
    return h('div', { class: 'issues' }, s.issues.map((i) => {
      const severe = ['empty', 'unreadable', 'truncated', 'type_mismatch', 'size_mismatch'].includes(i.code);
      const status = severe ? 'corrupted' : (i.code === 'not_in_export' || i.code === 'no_local_path') ? 'missing' : null;
      return h('div', { class: 'issue-row' + (status ? ' clickable' : ''), onclick: status ? () => { panel.status = status; refreshGallery(true); document.getElementById('gallery').scrollIntoView({ behavior: 'smooth' }); } : null },
        h('span', { class: 'issue-icon ' + (severe ? 'st-corrupted' : status ? 'st-missing' : 'st-info'), html: ICONS[severe ? 'warn' : 'missingIcon'] }),
        h('span', { class: 'issue-label' }, i.label, !status ? h('span', { class: 'issue-note' }, ' (aviso — não invalida o arquivo)') : null),
        h('span', { class: 'issue-count' }, nf(i.count), h('small', null, ' ' + pct(i.count, total))));
    }));
  }

  function rankTable(rows, mode) {
    const LIMIT = 15;
    const tbody = h('tbody');
    const render = (all) => {
      tbody.textContent = '';
      for (const r of (all ? rows : rows.slice(0, LIMIT))) {
        const name = mode === 'chat' ? r.chat_name : r.sender_name;
        const sub = mode === 'chat' ? (r.chat_type === 'group' ? 'grupo' : 'individual') : (r.from_me ? 'titular do aparelho' : (r.sender_jid || 'não vinculado'));
        const kinds = Object.entries(r.kinds).map(([k, n]) => `${nf(n)} ${(KIND[k] || { plural: k }).plural.toLowerCase()}`).join(', ');
        tbody.appendChild(h('tr', {
          class: mode === 'chat' ? 'clickable' : '', title: kinds,
          onclick: mode === 'chat' ? () => { panel.chatId = r.chat_id; renderPanel(); } : null,
        },
          h('td', null, h('div', { class: 'cell-name' }, name), h('div', { class: 'cell-sub mono' }, sub)),
          h('td', { class: 'num' }, nf(r.total)), h('td', { class: 'num' }, nf(r.ok)), h('td', { class: 'num' }, nf(r.missing)), h('td', { class: 'num' }, nf(r.corrupted)),
          h('td', { class: 'num' }, fmtBytes(r.declared_bytes))));
      }
    };
    render(false);
    const more = rows.length > LIMIT ? h('button', { class: 'small-btn more-btn', onclick: (e) => { render(true); e.target.remove(); } }, `Mostrar todos (${nf(rows.length)})`) : null;
    return h('div', null, h('div', { class: 'table-wrap' }, h('table', { class: 'data-table compact' },
      h('thead', null, h('tr', null, h('th', null, mode === 'chat' ? 'Conversa' : 'Participante'), h('th', { class: 'num' }, 'Total'),
        h('th', { class: 'num' }, 'Íntegr.'), h('th', { class: 'num' }, 'Ausent.'), h('th', { class: 'num' }, 'Corr.'), h('th', { class: 'num' }, 'Volume'))),
      tbody)), more);
  }

  // ------------------------------------------------------------------ galeria
  function gallery() {
    const s = panel.summary;
    const sec = h('section', { class: 'panel-card', id: 'gallery' }, h('h3', null, 'Galeria de mídias'));
    const statusChips = h('div', { class: 'chip-row inline', id: 'g-status' },
      [['', 'Todas', s.totals.total], ['ok', 'Íntegras', s.totals.ok], ['missing', 'Ausentes', s.totals.missing], ['corrupted', 'Corrompidas', s.totals.corrupted]]
        .map(([v, l, n]) => h('button', { class: 'chip', dataset: { v }, onclick: () => { panel.status = v; refreshGallery(true); } }, `${l} · ${nf(n)}`)));
    const kindChips = h('div', { class: 'chip-row inline', id: 'g-kind' },
      h('button', { class: 'chip', dataset: { v: '' }, onclick: () => { panel.kind = ''; refreshGallery(true); } }, 'Todos os tipos'),
      Object.entries(s.by_kind).map(([k, r]) => h('button', { class: 'chip', dataset: { v: k }, onclick: () => { panel.kind = k; refreshGallery(true); } }, `${(KIND[k] || { plural: k }).plural} · ${nf(r.total)}`)));
    sec.append(statusChips, kindChips, h('div', { class: 'gallery-count', id: 'g-count' }), h('div', { class: 'gallery-grid', id: 'g-grid' }), h('div', { id: 'g-more' }));
    setTimeout(() => refreshGallery(true));
    return sec;
  }

  async function refreshGallery(reset) {
    const grid = document.getElementById('g-grid');
    if (!grid) return;
    document.querySelectorAll('#g-status .chip').forEach((c) => c.classList.toggle('active', c.dataset.v === panel.status));
    document.querySelectorAll('#g-kind .chip').forEach((c) => c.classList.toggle('active', c.dataset.v === panel.kind));
    if (reset) { panel.items = []; grid.textContent = ''; }
    const params = new URLSearchParams({ offset: panel.items.length, limit: 120 });
    if (panel.chatId) params.set('chat', panel.chatId);
    if (panel.status) params.set('status', panel.status);
    if (panel.kind) params.set('kind', panel.kind);
    const token = (panel.token = (panel.token || 0) + 1);
    let res;
    try { res = await api('/api/media-items?' + params); } catch (err) { grid.textContent = 'Erro: ' + err.message; return; }
    if (token !== panel.token) return;
    const start = panel.items.length;
    panel.items.push(...res.items); panel.total = res.total;
    const frag = document.createDocumentFragment();
    res.items.forEach((it, j) => frag.appendChild(tile(it, () => openViewer(panel.items, start + j, { more: loadMoreForViewer }))));
    grid.appendChild(frag);
    document.getElementById('g-count').textContent = res.total ? `${nf(res.total)} mídia(s) · exibindo ${nf(panel.items.length)}` : 'Nenhuma mídia com estes filtros.';
    const more = document.getElementById('g-more'); more.textContent = '';
    if (panel.items.length < res.total) more.appendChild(h('button', { class: 'small-btn more-btn', onclick: () => refreshGallery(false) }, 'Carregar mais'));
  }
  async function loadMoreForViewer() {
    if (panel.items.length >= panel.total) return false;
    await refreshGallery(false);
    return true;
  }

  function tile(it, onclick) {
    let thumb;
    if (it.status !== 'missing' && it.url && (it.kind === 'image' || it.kind === 'sticker' || (it.kind === 'gif' && (it.mime || '').startsWith('image/')))) {
      thumb = h('img', { src: it.url, loading: 'lazy', alt: it.filename || '' });
    } else if (it.status !== 'missing' && it.url && (it.kind === 'video' || it.kind === 'gif')) {
      thumb = h('video', { src: it.url + '#t=0.5', preload: 'metadata', muted: '' });
    } else {
      thumb = h('div', { class: 'tile-icon' }, icon(WA.MEDIA_ICON[it.kind] || 'doc'),
        h('span', null, it.kind === 'audio' && it.duration ? fmtDuration(it.duration) : (KIND[it.kind] || { label: it.kind }).label));
    }
    return h('button', { class: `tile ${it.status}`, type: 'button', onclick, title: `${it.chat_name} · ${it.sender_name} · ${itemDate(it)}` },
      h('div', { class: 'tile-media' }, thumb, it.status !== 'ok' ? h('span', { class: 'tile-flag ' + STATUS[it.status].cls }, icon(STATUS[it.status].icon), it.status === 'missing' ? 'ausente' : 'divergente') : null),
      h('div', { class: 'tile-meta' }, h('div', { class: 'tile-sender' }, it.from_me ? 'Você' : it.sender_name),
        h('div', { class: 'tile-date' }, itemDate(it))));
  }

  // ------------------------------------------- seção no painel de dados do chat
  function chatInfoSection(chatId) {
    const chat = WA.state.chats.find((c) => c.id === chatId);
    const m = chat && chat.media ? chat.media : { total: 0, ok: 0, missing: 0, corrupted: 0 };
    const strip = h('div', { class: 'thumb-strip' });
    const sec = WA.section(null,
      h('div', { class: 'section-head' }, h('h3', null, 'Mídia, links e docs'), h('span', { class: 'count' }, nf(m.total), ' ', h('span', { html: ICONS.next }))),
      m.total ? h('div', { class: 'media-stats' }, statusPill('ok'), ' ', nf(m.ok), '  ', statusPill('missing'), ' ', nf(m.missing), '  ', statusPill('corrupted'), ' ', nf(m.corrupted)) : h('div', { class: 'cell-sub' }, 'Nenhuma mídia nesta conversa.'),
      strip,
      m.total ? h('button', { class: 'small-btn', onclick: () => openPanel(chatId) }, 'Galeria e análise forense desta conversa') : null);
    sec.querySelector('.section-head').addEventListener('click', () => m.total && openPanel(chatId));
    if (m.ok) {
      api(`/api/media-items?chat=${chatId}&status=ok&kind=image,video,sticker&limit=6`).then((res) => {
        res.items.forEach((it, i) => strip.appendChild(tile(it, () => openViewer(res.items, i))));
      }).catch(() => {});
    }
    return sec;
  }

  // ============================================================ VISUALIZADOR
  const viewer = { list: [], index: 0, opts: {} };

  async function loadChatMedia(chatId) {
    if (chatCache.has(chatId)) return chatCache.get(chatId);
    const items = [];
    for (let offset = 0; ; offset += 1000) {
      const res = await api(`/api/media-items?chat=${chatId}&offset=${offset}&limit=1000`);
      items.push(...res.items);
      if (items.length >= res.total || !res.items.length) break;
    }
    chatCache.set(chatId, items);
    return items;
  }
  async function openForChat(chatId, mediaId) {
    const items = await loadChatMedia(chatId);
    const idx = items.findIndex((i) => i.media_id === mediaId);
    openViewer(items, Math.max(0, idx));
  }

  function openViewer(list, index, opts) {
    viewer.list = list; viewer.index = index; viewer.opts = opts || {};
    $('viewer').hidden = false;
    renderViewer();
  }
  function closeViewer() {
    const v = $('viewer');
    v.querySelectorAll('audio,video').forEach((m) => m.pause());
    v.hidden = true; v.textContent = '';
  }
  async function step(delta) {
    let i = viewer.index + delta;
    if (i >= viewer.list.length && viewer.opts.more && await viewer.opts.more()) i = Math.min(i, viewer.list.length - 1);
    if (i < 0 || i >= viewer.list.length) return;
    viewer.index = i; renderViewer();
  }

  function renderMedia(it) {
    if (it.status === 'missing' || !it.url) {
      return h('div', { class: 'viewer-missing' }, h('span', { class: 'vm-icon', html: ICONS[WA.MEDIA_ICON[it.kind] || 'doc'] }),
        h('div', { class: 'vm-title' }, 'Arquivo não incluído no export'),
        h('div', { class: 'vm-sub mono' }, it.local_path || 'sem caminho local registrado'),
        it.declared_size ? h('div', { class: 'vm-sub' }, `Tamanho declarado: ${fmtBytes(it.declared_size)}`) : null,
        h('div', { class: 'vm-sub' }, 'Use a opção --media apontando para a pasta de mídias da extração completa para vinculá-lo.'));
    }
    const mime = it.mime || '';
    if (mime.startsWith('image/')) return h('img', { class: 'viewer-img', src: it.url, alt: it.filename || '' });
    if (mime.startsWith('video/')) return h('video', { class: 'viewer-video', src: it.url, controls: '', autoplay: '' });
    if (mime.startsWith('audio/')) {
      return h('div', { class: 'viewer-audio' }, h('span', { class: 'va-icon', html: ICONS.micSmall.replace('width="12" height="20"', 'width="48" height="80"') }),
        h('audio', { src: it.url, controls: '', autoplay: '' }), it.duration ? h('div', { class: 'vm-sub' }, `Duração registrada: ${fmtDuration(it.duration)}`) : null);
    }
    if (mime === 'application/pdf') return h('iframe', { class: 'viewer-doc', src: it.url, title: it.filename || 'documento' });
    return h('div', { class: 'viewer-missing' }, h('span', { class: 'vm-icon', html: ICONS.doc }),
      h('div', { class: 'vm-title' }, it.filename || 'Documento'), h('div', { class: 'vm-sub' }, `${mime || 'tipo desconhecido'} · ${fmtBytes(it.actual_size)}`),
      h('a', { class: 'btn primary', href: it.url + '?download=1' }, 'Baixar arquivo'));
  }

  function renderViewer() {
    const it = viewer.list[viewer.index];
    const v = $('viewer');
    v.querySelectorAll('audio,video').forEach((m) => m.pause());
    v.textContent = '';
    if (!it) return closeViewer();
    const hashDd = h('span', { class: 'mono' });
    if (it.status !== 'missing') {
      hashDd.appendChild(h('button', { class: 'small-btn', onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = 'calculando…';
        try { hashDd.textContent = (await api(`/api/media/${it.media_id}/hash`)).sha256; } catch (err) { hashDd.textContent = 'erro: ' + err.message; }
      } }, 'calcular SHA-256'));
    }
    const problems = it.issues.concat(it.warnings);
    const details = h('aside', { class: 'viewer-details' },
      h('div', { class: 'vd-status' }, statusPill(it.status)),
      problems.length ? h('ul', { class: 'vd-issues' }, problems.map((c) => h('li', { class: it.issues.includes(c) ? 'severe' : '' }, issueLabel(c)))) : null,
      WA.kv([
        ['Tipo', (KIND[it.kind] || { label: it.kind }).label],
        ['Conversa', it.chat_name], ['Remetente', it.from_me ? 'Você (titular)' : it.sender_name], ['JID', it.sender_jid, 'mono'],
        ['Data', it.timestamp ? fmtFull.format(toDate(it.timestamp)) + (it.timestamp.approx ? ' (aprox.)' : '') : 'não registrada'],
        ['UTC', it.timestamp && it.timestamp.iso, 'mono'],
        ['Legenda', it.caption],
        ['Arquivo', it.filename, 'mono'], ['Caminho original', it.local_path, 'mono'], ['MIME (conteúdo)', it.mime, 'mono'],
        ['Tamanho declarado', it.declared_size != null ? `${fmtBytes(it.declared_size)} (${nf(it.declared_size)} B)` : null],
        ['Tamanho real', it.actual_size != null ? `${fmtBytes(it.actual_size)} (${nf(it.actual_size)} B)` : null],
        ['Duração', it.duration ? fmtDuration(it.duration) : null],
        ['ID mensagem', String(it.message_id), 'mono'], ['ID mídia', String(it.media_id), 'mono'],
      ]),
      it.status !== 'missing' ? h('dl', { class: 'kv' }, h('dt', null, 'SHA-256'), h('dd', null, hashDd)) : null);
    v.append(
      h('header', { class: 'viewer-bar' },
        WA.avatar(it.chat_type === 'group' ? 'group' : 'user', 40),
        h('div', { class: 'vb-title' }, h('div', null, it.from_me ? 'Você' : it.sender_name,
          (it.from_me || it.sender_name !== it.chat_name) ? ` · ${it.chat_name}` : ''),
          h('div', { class: 'vb-sub', title: approxTitle(it.timestamp) }, itemDate(it), ` · ${viewer.index + 1} de ${viewer.list.length}`)),
        h('button', { class: 'icon-btn', title: 'Abrir na conversa', html: ICONS.goChat, onclick: () => goToMessage(it) }),
        it.status !== 'missing' && it.url ? h('a', { class: 'icon-btn', title: 'Baixar arquivo original', href: it.url + '?download=1', html: ICONS.download }) : null,
        h('button', { class: 'icon-btn', title: 'Fechar (Esc)', html: ICONS.close, onclick: closeViewer })),
      h('div', { class: 'viewer-body' },
        h('button', { class: 'viewer-nav prev', title: 'Anterior (←)', html: ICONS.prev, disabled: viewer.index === 0 ? '' : null, onclick: () => step(-1) }),
        h('div', { class: 'viewer-stage' }, renderMedia(it)),
        h('button', { class: 'viewer-nav next', title: 'Próxima (→)', html: ICONS.next, disabled: viewer.index >= viewer.list.length - 1 && !viewer.opts.more ? '' : null, onclick: () => step(1) }),
        details));
  }

  async function goToMessage(it) {
    closeViewer();
    panel.el.hidden = true; $('btn-media-panel').classList.remove('active');
    if (!WA.state.currentChat || WA.state.currentChat.id !== it.chat_id || $('conversation').hidden || !WA.state.messageIndex.has(it.message_id)) {
      await WA.openChat(it.chat_id);
    } else {
      $('intro').hidden = true; $('conversation').hidden = false; $('app').classList.add('show-chat');
    }
    WA.scrollToMessage(it.message_id);
    WA.showMessage(it.message_id);
  }

  document.addEventListener('keydown', (e) => {
    if ($('viewer').hidden) {
      if (e.key === 'Escape' && !$('upload-modal').hidden && !upload.xhr) { closeModal(); e.stopImmediatePropagation(); }
      return;
    }
    if (e.key === 'Escape') { closeViewer(); e.stopImmediatePropagation(); }
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  }, true);

  window.WAMedia = { openForChat, openViewer, openPanel, chatInfoSection, issueLabel };
  // Caso o status já tenha chegado antes deste script ser executado.
  if (WA.state.status) document.dispatchEvent(new CustomEvent('wa:status', { detail: WA.state.status }));
  else renderUploadZone();
})();
