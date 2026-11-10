/* Análise assistida por IA (OpenCode, modelos gratuitos): por conversa e geral. */
(function () {
  'use strict';
  const WA = window.WA;
  if (!WA) return;
  const { h, icon, b, $, ICONS } = WA;
  const nf = (n) => Number(n).toLocaleString('pt-BR');

  const ai = {
    status: null,
    view: null,          // { scope, chatId, estimate, results, selected, job, error, busyElsewhere }
    poll: null,
    consent: false,      // por sessão da página; nunca persistido
    includeChat: true,
    dom: {},
  };
  const MODEL_KEY = 'wa_view.ai.model';
  function savedModel() { try { return localStorage.getItem(MODEL_KEY); } catch (e) { return null; } }
  function saveModel(v) { try { localStorage.setItem(MODEL_KEY, v); } catch (e) { /* sem armazenamento */ } }

  async function api(path, opts) {
    const init = Object.assign({}, opts);
    if (init.body && typeof init.body !== 'string') {
      init.body = JSON.stringify(init.body);
      init.headers = Object.assign({ 'Content-Type': 'application/json' }, init.headers);
    }
    const res = await fetch(path, init);
    let data = null;
    try { data = await res.json(); } catch (e) { /* corpo vazio */ }
    if (!res.ok) {
      const err = new Error((data && data.message) || `Erro HTTP ${res.status}`);
      err.code = data && data.error; err.status = res.status;
      throw err;
    }
    return data;
  }

  // ------------------------------------------------------------ markdown seguro
  // Converte o Markdown do modelo em DOM sem usar innerHTML (texto do modelo é não confiável).
  function inline(text, chatId) {
    const out = [];
    const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|#\d{3,})/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith('**')) out.push(h('strong', null, tok.slice(2, -2)));
      else if (tok.startsWith('`')) out.push(h('code', null, tok.slice(1, -1)));
      else {
        const id = Number(tok.slice(1));
        const cur = WA.state.currentChat;
        if (chatId && cur && cur.id === chatId && WA.state.messageIndex.has(id)) {
          out.push(h('button', { class: 'msg-ref', type: 'button', title: 'Ir para a mensagem na conversa', onclick: () => WA.scrollToMessage(id) }, tok));
        } else out.push(tok);
      }
      last = m.index + tok.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function renderMarkdown(md, chatId) {
    const root = h('div', { class: 'ai-md' });
    let para = [], list = null, fence = null;
    const flushPara = () => { if (para.length) { root.appendChild(h('p', null, ...inline(para.join(' '), chatId))); para = []; } };
    const flushList = () => { list = null; };
    for (const raw of String(md).split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      if (/^```/.test(line.trim())) {
        if (fence) { root.appendChild(h('pre', null, fence.join('\n'))); fence = null; }
        else { flushPara(); flushList(); fence = []; }
        continue;
      }
      if (fence) { fence.push(raw); continue; }
      let m;
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if ((m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line))) {
        flushPara(); flushList();
        root.appendChild(h('h4', { class: 'ai-h' + Math.min(m[1].length, 3) }, ...inline(m[2], chatId)));
      } else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) {
        flushPara();
        if (!list || list.tagName !== 'UL') { list = h('ul'); root.appendChild(list); }
        list.appendChild(h('li', null, ...inline(m[1], chatId)));
      } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
        flushPara();
        if (!list || list.tagName !== 'OL') { list = h('ol'); root.appendChild(list); }
        list.appendChild(h('li', null, ...inline(m[1], chatId)));
      } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        flushPara(); flushList(); root.appendChild(h('hr'));
      } else {
        flushList(); para.push(line.trim());
      }
    }
    if (fence) root.appendChild(h('pre', null, fence.join('\n')));
    flushPara();
    return root;
  }

  // ------------------------------------------------------------------- painel
  function scopeKey(v) { return v.scope === 'chat' ? `chat:${v.chatId}` : 'general'; }
  function chatName(id) { const c = WA.state.chats.find((x) => x.id === id); return c ? c.name : `#${id}`; }
  function fmtWhen(iso) { try { return WA.fmtFull.format(new Date(iso)); } catch (e) { return iso; } }

  async function open(scope, chatId) {
    stopPolling();
    ai.consent = false;   // o envio de dados é autorizado a cada abertura do painel, por escopo
    ai.view = { scope, chatId: chatId || null, estimate: null, results: [], selected: 0, job: null, error: null, other: null };
    renderPanel(true);
    try {
      ai.status = await api('/api/ai/status');
      const v = ai.view;
      const q = scope === 'chat' ? `?chat=${chatId}` : '';
      const [results, estimate] = await Promise.all([
        api('/api/ai/results' + q),
        scope === 'chat' ? api(`/api/ai/estimate?chat=${chatId}`) : Promise.resolve(null),
      ]);
      v.results = results; v.estimate = estimate;
      const act = ai.status.active_job;
      if (act) {
        if (act.scope === scope && (scope === 'general' || act.chat_id === chatId)) { v.job = act; startPolling(act.id); }
        else v.other = act;
      }
    } catch (err) { if (ai.view) ai.view.error = err.message; }
    renderPanel(false);
  }

  function modelSelect() {
    const models = (ai.status && ai.status.models) || [];
    const current = savedModel() && models.some((m) => m.id === savedModel()) ? savedModel() : (ai.status && ai.status.default_model);
    const sel = h('select', { class: 'ai-select', 'aria-label': 'Modelo gratuito', onchange: (e) => saveModel(e.target.value) },
      models.map((m) => h('option', { value: m.id, selected: m.id === current ? '' : null }, `${m.name} (${m.id})`)));
    ai.dom.model = sel;
    return sel;
  }

  function keySection() {
    const st = ai.status;
    if (!st) return null;
    const msg = h('div', { class: 'ai-note', id: 'ai-key-msg' });
    if (st.has_key) {
      const row = h('div', { class: 'ai-row' },
        h('span', { class: 'ai-ok' }, icon('okIcon'), st.key_source === 'env' ? ' Chave definida na variável OPENCODE_API_KEY' : ' Chave informada nesta sessão (somente em memória)'),
        h('button', { class: 'small-btn', onclick: async () => {
          msg.textContent = 'Testando…';
          try { const r = await api('/api/ai/test', { method: 'POST', body: { model: ai.dom.model.value } }); msg.textContent = `Conexão OK com ${r.model} (resposta: “${r.reply}”).`; msg.className = 'ai-note ok'; }
          catch (e) { msg.textContent = 'Falha: ' + e.message; msg.className = 'ai-note err'; }
        } }, 'testar modelo'),
        st.key_source === 'session' ? h('button', { class: 'small-btn', onclick: async () => { ai.status = await api('/api/ai/key', { method: 'POST', body: { key: '' } }); renderPanel(false); } }, 'remover chave') : null);
      return WA.section('Chave de API (OpenCode)', row, msg);
    }
    const input = h('input', { type: 'password', class: 'ai-input', placeholder: 'Cole a chave de API do OpenCode', autocomplete: 'off', spellcheck: 'false' });
    const save = async () => {
      if (!input.value.trim()) return;
      try { ai.status = await api('/api/ai/key', { method: 'POST', body: { key: input.value } }); input.value = ''; renderPanel(false); }
      catch (e) { msg.textContent = e.message; msg.className = 'ai-note err'; }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    return WA.section('Chave de API (OpenCode)',
      h('div', { class: 'ai-note' }, 'Crie a chave na sua conta do OpenCode (opencode.ai, menu Zen). Ela fica só na memória deste servidor, nunca é gravada em disco. Alternativa: variável de ambiente OPENCODE_API_KEY ou ./iniciar.ps1 -AskKey.'),
      h('div', { class: 'ai-row' }, input, h('button', { class: 'small-btn', onclick: save }, 'usar chave')), msg);
  }

  function consentSection() {
    const v = ai.view;
    const parts = [];
    if (v.scope === 'chat') {
      const e = v.estimate;
      parts.push(h('div', { class: 'ai-warn' }, icon('warn'), h('div', null,
        'Ao analisar, o ', b('texto das mensagens desta conversa'), e ? ` (${nf(e.messages)} mensagens, ${nf(Math.round(e.chars / 1024))} KB)` : '',
        ' é enviado ao OpenCode e ao provedor do modelo escolhido, fora deste computador. Imagens, vídeos e áudios não são enviados. ',
        'Modelos gratuitos podem registrar e reutilizar os dados: confirme a política do OpenCode antes de usar com material sigiloso.')));
      if (e) parts.push(h('div', { class: 'ai-note' }, `Estimativa: ~${e.calls} chamada${e.calls > 1 ? 's' : ''} ao modelo`,
        e.chunks > 1 ? ` (${e.chunks} blocos + síntese)` : '', e.truncated ? ' — conversa muito longa: só os blocos mais recentes serão analisados.' : '.'));
    } else {
      parts.push(h('div', { class: 'ai-warn' }, icon('warn'), h('div', null,
        'Serão enviados ', b('apenas estatísticas e metadados'), ' (nomes das conversas, contagens, datas, situação das mídias), sem o texto das mensagens. ',
        'Modelos gratuitos podem registrar e reutilizar os dados: confirme a política do OpenCode.')));
      const inc = h('input', { type: 'checkbox', checked: ai.includeChat ? '' : null, onchange: (e) => { ai.includeChat = e.target.checked; } });
      parts.push(h('label', { class: 'toggle-row' }, inc, h('span', null, 'Incluir os resultados das análises por conversa já geradas nesta sessão',
        h('small', null, 'Contêm trechos derivados das mensagens; desmarque para enviar somente estatísticas.'))));
    }
    const cb = h('input', { type: 'checkbox', checked: ai.consent ? '' : null, onchange: (e) => { ai.consent = e.target.checked; updateRun(); } });
    parts.push(h('label', { class: 'toggle-row ai-consent' }, cb, h('span', null, 'Entendo e autorizo o envio destes dados ao serviço de IA.')));
    return WA.section('Envio de dados', ...parts);
  }

  function runSection() {
    const v = ai.view;
    const running = v.job && (v.job.status === 'queued' || v.job.status === 'running');
    const wrap = h('div', { class: 'ai-run' });
    if (running) {
      const bar = h('div', { class: 'ai-bar' }, h('div', { class: 'ai-bar-fill' }));
      const label = h('div', { class: 'ai-note' });
      ai.dom.bar = bar; ai.dom.label = label;
      wrap.append(bar, label, h('button', { class: 'small-btn', onclick: cancelJob }, 'cancelar análise'));
      updateProgress();
    } else {
      const label = v.scope === 'chat' ? 'Analisar esta conversa' : 'Gerar visão geral do export';
      const btn = h('button', { class: 'ai-primary', type: 'button', onclick: run }, icon('ai'), label);
      ai.dom.run = btn;
      wrap.appendChild(btn);
      if (v.other) wrap.appendChild(h('div', { class: 'ai-note err' }, `Há outra análise em andamento (${v.other.scope === 'chat' ? chatName(v.other.chat_id) : 'visão geral'}). Aguarde terminar.`));
      updateRun();
    }
    if (v.job && v.job.status === 'cancelled') wrap.appendChild(h('div', { class: 'ai-note' }, 'Análise cancelada.'));
    if (v.job && v.job.status === 'error') wrap.appendChild(h('div', { class: 'ai-note err' }, 'Falha na análise: ' + v.job.error.message));
    if (v.error) wrap.appendChild(h('div', { class: 'ai-note err' }, v.error));
    return wrap;
  }

  function updateRun() {
    const btn = ai.dom.run;
    if (!btn) return;
    const v = ai.view, st = ai.status;
    const ready = st && st.has_key && ai.consent && !v.other;
    btn.disabled = !ready;
    btn.title = !st || !st.has_key ? 'Informe a chave de API' : !ai.consent ? 'Marque a autorização de envio' : '';
  }

  function updateProgress() {
    const j = ai.view && ai.view.job;
    if (!j || !ai.dom.bar) return;
    const p = j.progress || { done: 0, total: 1, label: '' };
    ai.dom.bar.firstChild.style.width = Math.min(100, Math.round(p.done / p.total * 100)) + '%';
    ai.dom.label.textContent = `${p.label} (${p.done}/${p.total})`;
  }

  function resultSection() {
    const v = ai.view;
    if (!v.results.length) return null;
    const r = v.results[Math.min(v.selected, v.results.length - 1)];
    const models = (ai.status && ai.status.models) || [];
    const nameOf = (id) => (models.find((m) => m.id === id) || { name: id }).name;
    const pick = h('select', { class: 'ai-select', 'aria-label': 'Resultados salvos', onchange: (e) => { v.selected = Number(e.target.value); renderPanel(false); } },
      v.results.map((x, i) => h('option', { value: i, selected: i === v.selected ? '' : null }, `${nameOf(x.model)} · ${fmtWhen(x.created_at)}`)));
    const meta = [`Modelo: ${nameOf(r.model)}`, `gerado em ${fmtWhen(r.created_at)}`, `${r.calls} chamada${r.calls > 1 ? 's' : ''} ao modelo`];
    if (r.messages_total) meta.push(`${nf(r.messages_analysed)} de ${nf(r.messages_total)} mensagens analisadas`);
    if (r.scope === 'general' && r.chat_results_used) meta.push(`${r.chat_results_used} análise(s) por conversa incluída(s)`);
    const title = r.scope === 'chat' ? `Análise por IA — ${chatName(r.chat_id)}` : 'Visão geral por IA — export';
    const md = `# ${title}\n\n_${meta.join(' · ')}. Texto gerado por IA: conferir nas mensagens citadas; não substitui análise pericial._\n\n${r.markdown}\n`;
    return WA.section('Resultado',
      v.results.length > 1 ? pick : null,
      h('div', { class: 'ai-disclaimer' }, icon('warn'), 'Gerado por IA. Confira cada afirmação nas mensagens citadas (#id). Não substitui a análise pericial.'),
      h('div', { class: 'ai-meta' }, meta.join(' · ')),
      ...(r.notes || []).map((n) => h('div', { class: 'ai-note err' }, n)),
      renderMarkdown(r.markdown, r.scope === 'chat' ? r.chat_id : null),
      h('div', { class: 'ai-row' },
        h('button', { class: 'small-btn', onclick: async (e) => { try { await navigator.clipboard.writeText(md); e.target.textContent = 'copiado'; } catch (err) { e.target.textContent = 'não foi possível copiar'; } } }, 'copiar Markdown'),
        h('button', { class: 'small-btn', onclick: () => download(md, r) }, 'baixar .md')));
  }

  function download(md, r) {
    const slug = (r.scope === 'chat' ? chatName(r.chat_id) : 'geral').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'analise';
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    const a = h('a', { href: url, download: `analise-ia-${slug}.md` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function renderPanel(loading) {
    const v = ai.view;
    if (!v) return;
    ai.dom = {};
    const title = v.scope === 'chat' ? 'Análise por IA' : 'Visão geral por IA';
    const head = h('div', { class: 'drawer-section' },
      h('div', { class: 'ai-target' }, v.scope === 'chat' ? chatName(v.chatId) : 'Todo o export (estatísticas e metadados)'));
    if (loading) { WA.openDrawer('ai', title, [head, h('div', { class: 'messages-loading' }, 'Carregando…')]); return; }
    const parts = [head];
    if (!ai.status) { parts.push(h('div', { class: 'ai-note err', style: 'padding:0 30px' }, v.error || 'Serviço indisponível.')); WA.openDrawer('ai', title, parts); return; }
    parts.push(WA.section('Modelo (somente gratuitos)', modelSelect(),
      h('div', { class: 'ai-note' }, 'A lista contém apenas modelos de custo zero; o servidor recusa qualquer outro.')));
    parts.push(keySection());
    parts.push(consentSection());
    parts.push(WA.section(null, runSection()));
    parts.push(resultSection());
    WA.openDrawer('ai', title, parts.filter(Boolean));
  }

  // --------------------------------------------------------------------- jobs
  async function run() {
    const v = ai.view;
    v.error = null;
    try {
      v.job = await api('/api/ai/analyze', { method: 'POST', body: {
        scope: v.scope, chat_id: v.chatId, model: ai.dom.model.value, confirm: ai.consent === true, include_chat_results: ai.includeChat } });
      startPolling(v.job.id);
    } catch (err) { v.error = err.message; if (err.code === 'busy') v.other = (await api('/api/ai/status')).active_job; }
    renderPanel(false);
  }
  async function cancelJob() {
    const v = ai.view;
    if (v && v.job) { try { await api(`/api/ai/jobs/${v.job.id}/cancel`, { method: 'POST', body: {} }); } catch (e) { /* já terminou */ } }
  }
  function stopPolling() { if (ai.poll) { clearInterval(ai.poll); ai.poll = null; } }
  function startPolling(jobId) {
    stopPolling();
    ai.poll = setInterval(async () => {
      try {
        const j = await api(`/api/ai/jobs/${jobId}`);
        const v = ai.view;
        if (!v || !v.job || v.job.id !== jobId) { stopPolling(); return; }
        v.job = j;
        if (j.status === 'queued' || j.status === 'running') { updateProgress(); return; }
        stopPolling();
        if (j.status === 'done') {
          v.results = await api('/api/ai/results' + (v.scope === 'chat' ? `?chat=${v.chatId}` : ''));
          v.selected = 0; v.job = null;
        }
        if (WA.state.drawer === 'ai') renderPanel(false);
      } catch (err) { stopPolling(); if (ai.view) ai.view.error = err.message; if (WA.state.drawer === 'ai') renderPanel(false); }
    }, 1500);
  }

  // ----------------------------------------------------------- pontos de entrada
  const headerBtn = h('button', { class: 'icon-btn', id: 'btn-chat-ai', title: 'Analisar esta conversa com IA (modelos gratuitos)', html: ICONS.ai,
    onclick: () => { if (WA.state.currentChat) open('chat', WA.state.currentChat.id); } });
  const hdr = document.querySelector('#conversation .chat-header .header-icons');
  if (hdr) hdr.prepend(headerBtn);

  window.WAAI = {
    openChat: (id) => open('chat', id),
    openGeneral: () => open('general'),
    chatInfoSection(chatId) {
      return WA.section(null,
        h('div', { class: 'section-head' }, h('h3', null, 'Análise por IA')),
        h('div', { class: 'cell-sub' }, 'Resumo, linha do tempo e pontos de atenção da conversa, com modelos gratuitos do OpenCode.'),
        h('button', { class: 'small-btn', onclick: () => open('chat', chatId) }, 'Analisar esta conversa com IA'));
    },
    /* Botão para o cabeçalho do painel de análise forense (geral, ou da conversa quando há escopo). */
    panelButton(chatId) {
      return h('button', { class: 'ai-primary compact', type: 'button',
        title: chatId ? 'Analisar a conversa selecionada com IA' : 'Gerar visão geral do export com IA (somente estatísticas)',
        onclick: () => (chatId ? open('chat', chatId) : open('general')) }, icon('ai'), chatId ? 'Analisar conversa com IA' : 'Análise geral com IA');
    },
  };
})();
