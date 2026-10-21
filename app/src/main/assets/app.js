/* LLM Chat — client-side app. No filters, no prompt rewriting: what you type is what gets sent. */
(function () {
  'use strict';

  var K_LAST = 'llmchat.lastSession';
  var MAX_IMAGES = 4;
  var MAX_PACK_STICKERS = 24;

  var state = {
    providers: [],
    sessions: [],
    activeProviderId: '',
    cur: null,
    streamingId: null,
    images: [],
    meta: {
      avatars: { user: '', assistant: '' },
      bubble: { user: 'classic', assistant: 'cream' },
      stickerGlobal: 0,
      showQuota: false,
      petPos: null,
      usage: { p: 0, c: 0, rounds: 0 },
      particleDensity: 0.6,
      stickerPacks: [],
      search: { engine: 'duckduckgo' },
      chatBackground: { preset: 'none', image: '', dim: 0.45 },
      stickerProb: {}
    },
    packId: '',
    stickers: { tree: false, categories: [] },
    tts: { cloneTts: false, voice: '', rate: 1.0, preferApi: true, speakingId: '', engines: [] },
    hasSearchKey: false,
    searchPending: null,
    toolPending: null,
    searchCount: 0,
    open: { drawer: false, settings: false, sheet: false }
  };

  // ---------------------------------------------------------------- helpers

  function $(sel, root) { return (root || document).querySelector(sel); }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function now() { return Date.now(); }

  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function fmtWhen(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var diff = (now() - ts) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' 天前';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function provider(id) {
    for (var i = 0; i < state.providers.length; i++) {
      if (state.providers[i].id === id) return state.providers[i];
    }
    return null;
  }

  /**
   * Resolves the provider a session should talk to and heals the session in place.
   * Needed because a session created before any provider existed carries providerId ''.
   */
  function resolveProvider(s) {
    if (!s) return null;
    var p = s.providerId ? provider(s.providerId) : null;
    if (!p) p = provider(state.activeProviderId) || state.providers[0] || null;
    if (!p) return null;
    if (s.providerId !== p.id) s.providerId = p.id;
    if (!s.model) s.model = p.defaultModel || (p.models && p.models.length ? p.models[0].id : '');
    if (!state.activeProviderId) state.activeProviderId = p.id;
    return p;
  }

  // localStorage can be unavailable for file:// origins on some WebViews; degrade gracefully.
  var mem = {};
  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { return mem[k] || null; }
  }
  function lsSet(k, v) {
    mem[k] = v;
    try { localStorage.setItem(k, v); } catch (e) { }
  }

  // ---------------------------------------------------------------- 诊断日志（同时进 logcat）
  var DEBUG = [];

  function dbg(tag, data) {
    var ts = new Date().toISOString().slice(11, 19);
    var line = ts + ' [' + tag + '] ' + (data === undefined ? '' : JSON.stringify(data));
    DEBUG.push(line);
    if (DEBUG.length > 120) DEBUG.shift();
    try { console.log('dbg ' + line); } catch (e) { }
  }
  function saveTts() {
    state.meta.tts = { voice: state.tts.voice || '', rate: state.tts.rate || 1, preferApi: !!state.tts.preferApi };
    saveMeta();
  }
  function saveMeta() {
    try {
      // 整份存：以前用白名单，导致 bubble / stickerProb / stickerGlobal / tts 全部丢失
      state.meta.packId = state.packId;
      Native.saveMeta(JSON.stringify(state.meta));
    } catch (e) { }
  }

  // ---------------------------------------------------------------- markdown

  function inlineFmt(s) {
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
    return s;
  }

  function codeBlockHtml(c) {
    var lang = String(c.lang || 'code').replace(/[^\w+#.-]/g, '') || 'code';
    return '<div class="code"><div class="code-head"><span>' + esc(lang) + '</span>' +
      '<button class="copy-code" data-code="' + encodeURIComponent(c.body) + '">复制</button></div>' +
      '<pre><code>' + esc(c.body.replace(/\n$/, '')) + '</code></pre></div>';
  }

  function md(src) {
    if (!src) return '';
    var text = String(src).replace(/\r\n?/g, '\n');
    var codes = [];
    text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, function (m, lang, body) {
      codes.push({ lang: lang, body: body });
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    text = esc(text);

    var lines = text.split('\n');
    var html = '';
    var para = [];
    var listType = null;
    var i = 0;

    function closeList() {
      if (listType) { html += '</' + listType + '>'; listType = null; }
    }

    function flushPara() {
      if (!para.length) return;
      var joined = para.join(' ');
      if (/^\u0000\d+\u0000$/.test(joined)) html += joined;
      else html += '<p>' + inlineFmt(joined) + '</p>';
      para = [];
    }

    while (i < lines.length) {
      var line = lines[i];
      var m;

      if (/^\s*$/.test(line)) { flushPara(); closeList(); i++; continue; }

      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
        flushPara(); closeList();
        var lvl = m[1].length + 1;
        html += '<h' + lvl + '>' + inlineFmt(m[2]) + '</h' + lvl + '>';
        i++; continue;
      }

      if (/^\s*([-*_]\s*){3,}$/.test(line)) { flushPara(); closeList(); html += '<hr/>'; i++; continue; }

      if (line.indexOf('|') >= 0 && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        flushPara(); closeList();
        var parseRow = function (l) {
          return l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
        };
        var head = parseRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) {
          rows.push(parseRow(lines[i]));
          i++;
        }
        html += '<table><thead><tr>' +
          head.map(function (c) { return '<th>' + inlineFmt(c) + '</th>'; }).join('') +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + inlineFmt(c) + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table>';
        continue;
      }

      if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        flushPara();
        if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
        html += '<li>' + inlineFmt(m[1]) + '</li>';
        i++; continue;
      }

      if ((m = line.match(/^\s*(\d{1,2})[.)]\s+(.*)$/))) {
        flushPara();
        if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
        html += '<li>' + inlineFmt(m[2]) + '</li>';
        i++; continue;
      }

      if ((m = line.match(/^\s*(?:>|&gt;)\s?(.*)$/))) {
        flushPara(); closeList();
        html += '<blockquote>' + inlineFmt(m[1]) + '</blockquote>';
        i++; continue;
      }

      closeList();
      para.push(line.trim());
      i++;
    }

    flushPara();
    closeList();

    return html.replace(/\u0000(\d+)\u0000/g, function (mm, idx) {
      return codeBlockHtml(codes[Number(idx)]);
    });
  }

  // ---------------------------------------------------------------- session model

  function blankSession() {
    var p = provider(state.activeProviderId) || state.providers[0] || null;
    var defModel = '';
    if (p) {
      if (p.defaultModel) defModel = p.defaultModel;
      else if (p.models && p.models.length) defModel = p.models[0].id;
    }
    return {
      id: uid(),
      title: '新会话',
      createdAt: now(),
      updatedAt: now(),
      providerId: p ? p.id : '',
      model: defModel,
      system: '',
      temperature: 0.7,
      maxTokens: 0,
      topP: -1,
      contextLimit: 0,
      stream: true,
      webSearch: false,
      stickerAuto: false,
      autoRead: false,
      messages: []
    };
  }

  function persist(immediate) {
    var s = state.cur;
    if (!s) return;
    s.updatedAt = now();
    var json = JSON.stringify(s, function (k, v) { return k === 'streaming' ? undefined : v; });
    clearTimeout(persist.timer);
    if (immediate) {
      Native.saveSession(json);
    } else {
      persist.timer = setTimeout(function () { Native.saveSession(json); }, 450);
    }
    var meta = null;
    for (var i = 0; i < state.sessions.length; i++) if (state.sessions[i].id === s.id) meta = state.sessions[i];
    if (!meta) {
      meta = { id: s.id, title: s.title, updatedAt: s.updatedAt, model: s.model, providerId: s.providerId, count: s.messages.length };
      state.sessions.unshift(meta);
    } else {
      meta.title = s.title;
      meta.updatedAt = s.updatedAt;
      meta.model = s.model;
      meta.providerId = s.providerId;
      meta.count = s.messages.length;
    }
  }

  function refreshSessions() {
    try { state.sessions = JSON.parse(Native.listSessions()); } catch (e) { state.sessions = []; }
  }

  function openSession(id) {
    var raw = '';
    try { raw = Native.loadSession(id); } catch (e) { raw = ''; }
    if (!raw) return;
    var s;
    try { s = JSON.parse(raw); } catch (e) { toast('会话文件损坏'); return; }
    s.messages = (s.messages || []).map(function (m) { m.streaming = false; return m; });
    if (s.temperature == null) s.temperature = 0.7;

    if (s.maxTokens == null) s.maxTokens = 0;

    if (s.topP == null) s.topP = -1;

    if (s.contextLimit == null) s.contextLimit = 0;

    if (s.stream == null) s.stream = true;

    if (s.webSearch == null) s.webSearch = false;
    if (s.stickerAuto == null) s.stickerAuto = false;
    state.cur = s;
    lsSet(K_LAST, s.id);
    // heal a session that points at a provider which no longer exists
    resolveProvider(s);
    if (state.streamingId) { state.streamingId = null; Native.stop(); }
    closeDrawer();
    renderAll();
  }

  function newSession() {
    var s = blankSession();
    state.cur = s;
    state.images = [];
    state.streamingId = null;
    lsSet(K_LAST, s.id);
    state.sessions.unshift({ id: s.id, title: s.title, updatedAt: s.updatedAt, model: s.model, providerId: s.providerId, count: 0 });
    Native.saveSession(JSON.stringify(s));
    closeDrawer();
    renderAll();
    $('#input').focus();
  }

  function deleteSession(id) {
    Native.deleteSession(id);
    state.sessions = state.sessions.filter(function (x) { return x.id !== id; });
    if (state.cur && state.cur.id === id) {
      state.cur = null;
      if (state.sessions.length) openSession(state.sessions[0].id);
      else newSession();
    }
    renderSessions();
    renderHeader();
  }

  // ---------------------------------------------------------------- rendering

  function renderHeader() {
    var s = state.cur;
    $('#title').textContent = s && s.title ? s.title : '新会话';
    if (!s) { $('#subtitle').textContent = '未配置'; return; }
    var p = provider(s.providerId);
    var bits = [];
    if (p) bits.push(p.name);
    bits.push(s.model || '未选模型');
    $('#subtitle').textContent = bits.join(' · ');
  }

  /** 会话按时间分组 */
  function sessionGroup(ts) {
    var t = Number(ts) || 0;
    var now = new Date();
    var dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (t >= dayStart) return '今天';
    if (t >= dayStart - 86400000) return '昨天';
    if (t >= dayStart - 6 * 86400000) return '本周';
    return '更早';
  }

  function renderSessions() {
    var box = $('#session-list');
    box.innerHTML = '';

    var countEl = $('#session-count');
    if (countEl) countEl.textContent = state.sessions.length + ' 个会话';

    if (!state.sessions.length) {
      box.innerHTML = '<div class="s-empty">' +
        '<img src="mascot-empty.webp" alt="">' +
        '<div class="s-empty-text">还没有对话<br><span>点上面「新建对话」开始</span></div></div>';
      return;
    }

    var order = ['今天', '昨天', '本周', '更早'];
    var groups = { '今天': [], '昨天': [], '本周': [], '更早': [] };
    state.sessions.forEach(function (meta) {
      var g = sessionGroup(meta.updatedAt);
      groups[g].push(meta);
    });

    order.forEach(function (g) {
      if (!groups[g].length) return;
      var head = document.createElement('div');
      head.className = 's-group';
      head.textContent = g;
      box.appendChild(head);

      groups[g].forEach(function (meta) {
        var item = document.createElement('div');
        item.className = 's-item' + (state.cur && state.cur.id === meta.id ? ' active' : '');
        item.dataset.id = meta.id;
        item.innerHTML = '<div class="s-main"><div class="s-title"></div><div class="s-meta"></div></div>' +
          '<button class="s-more" data-more="1">⋯</button>';
        item.querySelector('.s-title').textContent = meta.title || '新会话';
        var bits = [];
        if (meta.model) bits.push(meta.model);
        bits.push(fmtWhen(meta.updatedAt));
        bits.push((meta.count || 0) + ' 条');
        item.querySelector('.s-meta').textContent = bits.join(' · ');
        box.appendChild(item);
      });
    });
  }

  function avatarEl(role) {
    var d = document.createElement('div');
    var custom = state.meta.avatars && state.meta.avatars[role === 'user' ? 'user' : 'assistant'];
    d.className = 'avatar ' + (role === 'user' ? 'user' : 'ai');
    if (custom) {
      d.style.backgroundImage = 'url(' + custom + ')';
      d.textContent = '';
    } else if (role !== 'user') {
      d.style.backgroundImage = 'url(avatar-ai.webp)';
      d.textContent = '';
      d.classList.add('img');
    } else {
      d.textContent = '我';
    }
    return d;
  }

  /** 等待首字的占位（带思考表情） */
  function waitingHtml() {
    return '<span class="waiting">' +
      '<img class="wait-face" src="face-normal.webp" alt="">' +
      '<span class="wait-dots"><i></i><i></i><i></i></span></span>';
  }

  /** 报错块（带生气表情） */
  function buildErrorNode(text) {
    var e = document.createElement('div');
    e.className = 'msg-error';
    var img = document.createElement('img');
    img.className = 'err-face';
    img.src = 'face-angry.webp';
    img.alt = '';
    e.appendChild(img);
    var span = document.createElement('span');
    span.className = 'err-text';
    span.textContent = text || '';
    e.appendChild(span);
    return e;
  }
  function msgNode(m) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + m.role;
    wrap.dataset.id = m.id;

    var lastAi = null;
    var sCur = state.cur;
    if (sCur) {
      for (var i = sCur.messages.length - 1; i >= 0; i--) {
        var mm = sCur.messages[i];
        if (mm.role === 'assistant' && mm.kind !== 'sticker' && !mm.error) { lastAi = mm.id; break; }
      }
    }
    var aiCream = !state.meta || !state.meta.bubble || state.meta.bubble.assistant !== 'classic';
    var showPeek = aiCream && m.role === 'assistant' && m.id === lastAi && (m.content || '').trim();
    if (showPeek) wrap.classList.add('has-peek');

    var inner = document.createElement('div');
    inner.className = 'msg-inner';
    var col = document.createElement('div');
    col.className = 'col';

    if (m.role === 'user') {
      if (m.images && m.images.length) {
        var imgs = document.createElement('div');
        imgs.className = 'imgs';
        m.images.forEach(function (u) {
          var img = document.createElement('img');
          img.src = u;
          imgs.appendChild(img);
        });
        col.appendChild(imgs);
      }
      if (m.content) {
        var b = document.createElement('div');
        b.className = 'bubble';
        b.textContent = m.content;
        col.appendChild(b);
      }
      inner.appendChild(col);
      inner.appendChild(avatarEl('user'));
      wrap.appendChild(inner);
      return wrap;
    }

    var tag = document.createElement('div');
    tag.className = 'role-tag';

    // 搜索工具卡片
    if (m.role === 'tool') {
      wrap.className = 'msg tool';
      var card = document.createElement('div');
      card.className = 'tool-card' + (m.pending ? ' pending' : '');
      var head = m.pending ? '🔍 正在搜索「' + esc(m.query || '') + '」…'
        : (m.error ? '🔍 搜索「' + esc(m.query || '') + '」失败'
          : '🔍 搜索「' + esc(m.query || '') + '」' +
            (m.engine ? ' · ' + esc(ENGINE_NAMES[m.engine] || m.engine) : ''));
      card.innerHTML = '<div class="tool-head">' + head + '</div>';
      if (!m.pending && m.content) {
        var det = document.createElement('details');
        det.innerHTML = '<summary>查看结果</summary><pre class="tres"></pre>';
        det.querySelector('.tres').textContent = m.content;
        card.appendChild(det);
      }
      if (!m.pending && m.error) {
        var errEl = document.createElement('div');
        errEl.className = 'tool-err';
        errEl.textContent = m.error;
        card.appendChild(errEl);
      }
      col.appendChild(card);
      inner.appendChild(col);
      wrap.appendChild(inner);
      return wrap;
    }

    var webLabel = m.webQuery ? ('🌐 ' + esc(String(m.webQuery).slice(0, 16))) : '🌐 联网';
    var webBadge = m.web
      ? '<span class="badge-web">' + webLabel + '</span>'
      : (m.webEnabled ? '<span class="badge-web dim">🌐 未调用</span>' : '');
    tag.innerHTML = '<span class="dot' + (m.streaming ? ' live' : '') + '"></span><span class="tname"></span>'
      + webBadge;
    tag.querySelector('.tname').textContent = m.model || 'assistant';
    col.appendChild(tag);

    // 纯表情消息
    if (m.kind === 'sticker' && m.sticker) {
      var st = document.createElement('div');
      st.className = 'sticker';
      st.innerHTML = '<img src="' + m.sticker + '">';
      col.appendChild(st);
      inner.appendChild(avatarEl('assistant'));
      inner.appendChild(col);
      wrap.appendChild(inner);
      return wrap;
    }

    if (m.reasoning) col.appendChild(thinkNode(m));

    var waiting = m.streaming && !(m.content || '').trim();
    var body = document.createElement('div');
    body.className = 'body md';
    if (waiting) {
      body.innerHTML = waitingHtml();
    } else {
      body.innerHTML = md(stripSearchDisplay(stripEmo(m.content))) + (m.streaming ? '<span class="caret"></span>' : '');
    }
    // 必须在 innerHTML 之后插入，否则会被覆盖
    if (showPeek) {
      var peek = document.createElement('img');
      peek.className = 'peek';
      peek.src = 'bubble-peek.webp';
      peek.alt = '';
      body.insertBefore(peek, body.firstChild);
    }
    col.appendChild(body);

    if (m.error) col.appendChild(buildErrorNode(m.error));

    var acts = document.createElement('div');
    acts.className = 'msg-actions';
    var forceBtn = (m.webEnabled && !m.web && !(m.toolCalls && m.toolCalls.length))
      ? '<button class="mini-btn" data-act="forceSearch">搜一下</button>'
      : '';
    var speakBtn = (m.content && String(m.content).trim())
      ? '<button class="mini-btn" data-act="speak">' + (state.tts && state.tts.speakingId === m.id ? '停止' : '朗读') + '</button>'
      : '';
    acts.innerHTML = '<button class="mini-btn" data-act="copy">复制</button>' +
      '<button class="mini-btn" data-act="retry">重新生成</button>' + speakBtn + forceBtn;
    col.appendChild(acts);

    inner.appendChild(avatarEl('assistant'));
    inner.appendChild(col);
    wrap.appendChild(inner);
    return wrap;
  }

  function thinkNode(m) {
    var d = document.createElement('details');
    d.className = 'think';
    if (m.streaming) d.open = true;
    d.innerHTML = '<summary>思考过程</summary><div class="think-body"></div>';
    d.querySelector('.think-body').textContent = m.reasoning || '';
    return d;
  }

  function renderMessages() {
    var box = $('#messages');
    box.innerHTML = '';
    var s = state.cur;
    if (!s) return;

    if (!s.messages.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      var hasProvider = state.providers.length > 0;
      empty.innerHTML = '<img class="mascot" src="mascot-empty.webp" alt="">' +
        '<h3>' + (hasProvider ? '说点什么吧' : '开始使用') + '</h3><p>' +
        (hasProvider
          ? '消息直接发给模型，客户端不做过滤、改写或拦截。'
          : '还没有配置服务商。点右上角设置，添加 OpenRouter 或 DeepSeek 的 API Key。') +
        '</p>' +
        (hasProvider
          ? '<div class="chip-row empty-chips">' +
            '<button class="chip" data-q="今天有什么值得关注的新闻？">今天有什么新闻</button>' +
            '<button class="chip" data-q="帮我把下面这段文字润色一下：">帮我润色文字</button>' +
            '<button class="chip" data-q="随便聊点什么吧">随便聊聊</button>' +
            '</div>'
          : '<button class="btn primary" id="empty-setup">去配置</button>');
      box.appendChild(empty);
      var setup = $('#empty-setup');
      if (setup) setup.addEventListener('click', openSettings);
      Array.prototype.forEach.call(empty.querySelectorAll('[data-q]'), function (el) {
        el.addEventListener('click', function () {
          var inp = $('#input');
          if (!inp) return;
          inp.value = el.dataset.q;
          autosize();
          inp.focus();
        });
      });
      return;
    }

    s.messages.forEach(function (m) { box.appendChild(msgNode(m)); });
    var bgNow = state.meta.chatBackground || {};
    if (!bgNow.image && IMAGE_BG[bgNow.preset]) ensureParticles(IMAGE_BG[bgNow.preset].kind);
    scrollBottom(true);
  }

  function updateMessageNode(m) {
    var node = document.querySelector('.msg[data-id="' + m.id + '"]');
    if (!node) return;
    var box = $('#messages');
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 180;

    var dot = node.querySelector('.role-tag .dot');
    if (dot) dot.classList.toggle('live', !!m.streaming);

    var body = node.querySelector('.body');
    if (body) {
      var keepPeek = body.querySelector('.peek');
      if (m.streaming && !(m.content || '').trim()) {
        body.innerHTML = waitingHtml();
      } else {
        body.innerHTML = md(stripSearchDisplay(stripEmo(m.content))) + (m.streaming ? '<span class="caret"></span>' : '');
      }
      if (keepPeek) body.insertBefore(keepPeek, body.firstChild);
    }

    if (m.reasoning) {
      var think = node.querySelector('.think');
      if (!think && body) {
        think = thinkNode(m);
        body.parentNode.insertBefore(think, body);
      }
      if (think) {
        var tb = think.querySelector('.think-body');
        if (tb) tb.textContent = m.reasoning;
      }
    }

    if (m.error) {
      var err = node.querySelector('.msg-error');
      if (!err) {
        err = buildErrorNode(m.error);
        var acts = node.querySelector('.msg-actions');
        if (acts && acts.parentNode) acts.parentNode.insertBefore(err, acts); else node.appendChild(err);
      } else {
        var etxt = err.querySelector('.err-text');
        if (etxt) etxt.textContent = m.error;
        else {
          // 旧节点没有表情，重建
          var fresh = buildErrorNode(m.error);
          err.parentNode.replaceChild(fresh, err);
        }
      }
    }

    if (nearBottom) scrollBottom(true);
  }

  // ---- 额度桌宠 ----
  function fmtTok(n) {
    n = n || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function petFaceSize() {
    return 42;
  }

  function clampPet(x, y) {
    var s = petFaceSize();
    var maxX = Math.max(0, (window.innerWidth || 360) - s);
    var maxY = Math.max(0, (window.innerHeight || 640) - s);
    return {
      x: Math.max(0, Math.min(maxX, Math.round(x))),
      y: Math.max(0, Math.min(maxY, Math.round(y)))
    };
  }

  function petDefaultPos() {
    var h = 0;
    try {
      var c = document.querySelector('.composer');
      if (c && c.getBoundingClientRect) h = c.getBoundingClientRect().height || 0;
    } catch (e) { }
    return clampPet((window.innerWidth || 360) - 62, (window.innerHeight || 640) - h - 62);
  }

  function ensurePetEl() {
    var box = document.querySelector('#pet');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'pet';
    box.className = 'pet';
    box.innerHTML = '<div class="pet-bubble" id="pet-text"></div>' +
      '<img class="pet-face" src="avatar-ai.webp" alt="">';
    try { document.body.appendChild(box); } catch (e) { }
    bindPetDrag(box);
    return box;
  }

  function setPetBubble(text, ms) {
    var box = document.querySelector('#pet');
    if (!box) return;
    var el = document.querySelector('#pet-text');
    if (el) el.textContent = text || '';
    box.classList.add('bubble-on');
    if (state.petTimer) { clearTimeout(state.petTimer); state.petTimer = null; }
    if (ms > 0) {
      state.petTimer = setTimeout(function () {
        var b = document.querySelector('#pet');
        if (b) b.classList.remove('bubble-on');
        state.petTimer = null;
      }, ms);
    }
  }

  function hidePetBubble() {
    var box = document.querySelector('#pet');
    if (box) box.classList.remove('bubble-on');
    if (state.petTimer) { clearTimeout(state.petTimer); state.petTimer = null; }
  }

  function bindPetDrag(box) {
    var dragging = false, moved = false;
    var sx = 0, sy = 0, ox = 0, oy = 0;

    function point(e) {
      var t = e.touches && e.touches[0] ? e.touches[0] : e;
      return { x: t.clientX, y: t.clientY };
    }

    function down(e) {
      var p = point(e);
      dragging = true;
      moved = false;
      sx = p.x; sy = p.y;
      var r = box.getBoundingClientRect();
      ox = r.left; oy = r.top;
      box.classList.add('dragging');
      if (e.preventDefault && e.cancelable) e.preventDefault();
    }

    function move(e) {
      if (!dragging) return;
      var p = point(e);
      var dx = p.x - sx, dy = p.y - sy;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      var pos = clampPet(ox + dx, oy + dy);
      box.style.left = pos.x + 'px';
      box.style.top = pos.y + 'px';
      box.classList.toggle('flip', pos.x < 140);
      if (e.preventDefault && e.cancelable) e.preventDefault();
    }

    function up() {
      if (!dragging) return;
      dragging = false;
      box.classList.remove('dragging');
      var r = box.getBoundingClientRect();
      state.meta.petPos = clampPet(r.left, r.top);
      saveMeta();
      if (!moved) {
        // 单击：查余额
        try {
          Native.fetchBalance((state.cur && state.cur.providerId) || '');
        } catch (err) { }
      }
    }

    box.addEventListener('touchstart', down, { passive: false });
    box.addEventListener('touchmove', move, { passive: false });
    box.addEventListener('touchend', up);
    box.addEventListener('mousedown', down);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  function renderPet() {
    var box = ensurePetEl();
    var on = !!state.meta.showQuota;
    box.classList.toggle('show', on);
    if (!on) { hidePetBubble(); return; }
    if (!state.meta.petPos) state.meta.petPos = petDefaultPos();
    var pos = clampPet(state.meta.petPos.x, state.meta.petPos.y);
    box.style.left = pos.x + 'px';
    box.style.top = pos.y + 'px';
    box.classList.toggle('flip', pos.x < 140);
    if (box.classList.contains('bubble-on')) return;
    var el = document.querySelector('#pet-text');
    if (el && !el.textContent) el.textContent = '点我查余额';
  }

  function renderComposer() {
    var btn = $('#btn-send');
    if (state.streamingId) {
      btn.classList.add('stop');
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>';
    } else {
      btn.classList.remove('stop');
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="19" height="19"><path d="M12 19V5M6 11l6-6 6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    renderAttachments();
    renderToolbar();
  }

  function renderToolbar() {
    var s = state.cur;
    var web = $('#btn-web');
    if (web) web.classList.toggle('active', !!(s && s.webSearch));
    var st = $('#btn-sticker');
    if (st) st.classList.toggle('active', !!(s && s.stickerAuto));
    var nameEl = $('#model-name');
    if (nameEl) nameEl.textContent = (s && s.model) || '选择模型';
  }

  function renderAttachments() {
    var row = $('#attach-row');
    if (!state.images.length) { row.hidden = true; row.innerHTML = ''; return; }
    row.hidden = false;
    row.innerHTML = '';
    state.images.forEach(function (u, idx) {
      var d = document.createElement('div');
      d.className = 'thumb';
      d.innerHTML = '<img src="' + u + '"><button class="rm" data-idx="' + idx + '">×</button>';
      row.appendChild(d);
    });
  }

  function scrollBottom(force) {
    var box = $('#messages');
    if (!box) return;
    if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 180) {
      box.scrollTop = box.scrollHeight;
    }
  }

  function renderAll() {
    renderHeader();
    renderSessions();
    renderMessages();
    renderComposer();
  }

  // ---------------------------------------------------------------- send / stream

  function buildHistory(s, excludeId) {
    var out = [];
    for (var i = 0; i < s.messages.length; i++) {
      var m = s.messages[i];
      if (m.id === excludeId) break;
      if (m.role === 'user') {
        var hasText = !!(m.content && m.content.trim());
        if (m.images && m.images.length) {
          var parts = [];
          if (hasText) parts.push({ type: 'text', text: m.content });
          m.images.forEach(function (u) { parts.push({ type: 'image_url', image_url: { url: u } }); });
          out.push({ role: 'user', content: parts });
        } else if (hasText) {
          out.push({ role: 'user', content: m.content });
        }
      } else if (m.role === 'assistant') {
        if (m.content && m.content.trim() && !m.error) {
          out.push({ role: 'assistant', content: stripSearchDisplay(m.content) });
        }
      } else if (m.role === 'tool') {
        if (m.pending) continue;
        var text = m.error ? ('搜索失败：' + m.error) : (m.content && m.content.trim() ? m.content : '（没有搜到结果）');
        out.push({
          role: 'user',
          content: '【搜索结果】\n' + text +
            '\n\n请基于上面的结果回答；如果结果与问题无关，就说明没有查到并基于已有知识回答。'
        });
      }
    }
    // 上下文长度：只带最近 N 条消息，0 表示全部
    var limit = s.contextLimit > 0 ? s.contextLimit : 0;
    if (limit > 0 && out.length > limit) out = out.slice(out.length - limit);
    // 裁剪后若以 assistant 开头就丢掉，多数接口要求第一条是 user
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }

  function autoTitle(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '图片对话';
    return t.length > 22 ? t.slice(0, 22) + '…' : t;
  }

  // ---------------------------------------------------------------- 搜索工具（模型在回复里调用的）
  var MAX_SEARCH_PER_TURN = 2;
  var SEARCH_MARK = /<<\s*search\s*[:：]\s*([^>]{1,160})>>/gi;

  function nowText() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function buildSearchToolPrompt(allowTools) {
    var base = '当前时间：' + nowText() + '。';
    if (!allowTools) return base;
    return '【联网搜索 · 强制规则】\n' +
      '你具备联网能力：有 web_search 工具，也可以用 <<search:关键词>> 文本指令触发搜索。\n' +
      '凡涉及下列任一情况，必须先搜索、拿到结果再回答，禁止凭记忆作答，也禁止说"我无法联网/我的知识有截止时间"：\n' +
      '- 遇到你不认识的词、术语、人名、地名、作品名、缩写、代号（先查清是什么再回答）\n' +
      '- 新闻、时事、近期事件、最新进展、突发消息\n' +
      '- 价格、汇率、股价、天气、比分、库存、版本号\n' +
      '- 具体人物/公司/产品的近况、最新动态\n' +
      '- 任何你不确定、可能已过时、或需要引证的事实\n' +
      '调用方式（任选其一）：\n' +
      'A. 直接调用 web_search 工具，参数 {"query":"关键词"}；\n' +
      'B. 在回复中单独一行写 <<search:关键词>>。\n' +
      '客户端会立刻执行搜索，并把【搜索结果】作为下一条消息发给你，你再据此作答。\n' +
      '示例：\n' +
      '用户：北京今天有什么新闻？\n' +
      '你：我先查一下最新报道。\n' +
      '<<search:北京 新闻>>\n' +
      '规则：\n' +
      '1) 查询词是关键词、不超过 12 个词，保留专有名词，带上时间限定（今天/最新）；\n' +
      '2) 一次只调一次，已搜过的不要重复；最多 ' + MAX_SEARCH_PER_TURN + ' 次；\n' +
      '3) 结果到达后直接基于结果回答，用到的事实在句末标注来源链接；\n' +
      '4) 闲聊、写作、翻译、代码、数学、纯常识不需要搜索；\n' +
      '5) 标记不要写进代码块，也不要解释或复述这个标记本身。\n' +
      '再次强调：新闻/实时类问题，不搜索就回答视为错误。\n\n' + base;
  }

  function isOpenRouter(s) {
    var p = s && s.providerId ? provider(s.providerId) : null;
    var url = (p && p.baseUrl ? p.baseUrl : '').toLowerCase();
    return url.indexOf('openrouter.ai') >= 0;
  }
  function searchTools() {
    return [{
      type: 'function',
      function: {
        name: 'web_search',
        description: '搜索互联网获取实时信息：新闻、天气、价格、赛事比分、近期事件、具体事实、陌生名词。返回若干条结果的标题、链接和摘要。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索引擎关键词，不超过 12 个词；问"今天/最新"时把时间词写进去；' +
                '问新闻时写成「主体 + 新闻」（客户端会自动走新闻源）'
            }
          },
          required: ['query']
        }
      }
    }];
  }

  /** 统一的表情开关：面板、设置页都调它。 */
  function toggleStickerAuto(el) {
    var s = state.cur;
    if (!s) return;
    var n = stickerCategoryNames().length;
    if (!s.stickerAuto && n === 0) {
      toast('先导入表情分类，再打开开关');
      openStickerSheet();
      return;
    }
    s.stickerAuto = !s.stickerAuto;
    if (el) el.classList.toggle('on', s.stickerAuto);
    persist(true);
    renderToolbar();
    toast(s.stickerAuto ? ('已开启自动表情（' + n + ' 个分类）') : '已关闭自动表情');
  }
  /** 表情包分类：优先用导入的分类，其次兼容旧的本地槽位。 */
  function stickerCategoryNames() {
    var names = [];
    var folderCats = (state.stickers && state.stickers.categories) || [];
    for (var i = 0; i < folderCats.length; i++) {
      // 「默认」是兜底分类，不参与模型选择，模型看不到它
      if (folderCats[i].count > 0 && folderCats[i].name !== '默认') names.push(folderCats[i].name);
    }
    if (!names.length) {
      var packs = state.meta.stickerPacks || [];
      for (var j = 0; j < packs.length; j++) {
        if (packs[j].stickers && packs[j].stickers.length) names.push(packs[j].name);
      }
    }
    return names;
  }

  function stickerTools(names) {
    // 注意：不要用 enum。实测 deepseek-flash / v4-pro 遇到中文 enum 会直接返回空内容，
    // 改成在 description 里列分类、参数用普通 string，模型能正常调用。
    return [{
      type: 'function',
      function: {
        name: 'send_sticker',
        description: '发一张情绪表情包。客户端会从指定分类里随机挑一张图发出去。' +
          '只有在对话情绪明显、且分类列表里有合适选项时才调用；' +
          '没有合适的分类就不要调用这个工具，直接正常回复文字。' +
          '分类名必须原样来自列表，不要自己编造、不要翻译、不要加引号。',
        parameters: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              description: '情绪分类名，只能从以下列表里选一个（原样输出，不要加引号或解释）：' +
                names.join('、')
            }
          },
          required: ['category']
        }
      }
    }];
  }

  /** 本轮要声明给模型的工具。 */
  function chatTools(s, allowSearch) {
    var list = [];
    if (s && allowSearch) list = list.concat(searchTools());
    if (s && s.stickerAuto) {
      var names = stickerCategoryNames();
      if (names.length) list = list.concat(stickerTools(names));
    }
    return list;
  }

  /** 解析 tool_calls，返回 {kind:'search',query,id} / {kind:'sticker',category,id} / null。 */
  function parseToolCall(tools) {
    if (!tools || !tools.length) return null;
    for (var i = 0; i < tools.length; i++) {
      var t = tools[i] || {};
      var name = t.name || (t['function'] && t['function'].name) || '';
      var raw = t.args || (t['function'] && t['function'].arguments) || '';
      var parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parsed = null;
      }
      if (name === 'send_sticker') {
        var cat = parsed ? String(parsed.category || '').trim() : '';
        if (!cat) {
          var mc = String(raw).match(/"category"\s*:\s*"([^"]*)"/);
          if (mc) cat = mc[1].trim();
        }
        if (cat) return { kind: 'sticker', category: cat, id: t.id || '' };
        continue;
      }
      if (name === 'web_search' || name === '') {
        var q = parsed ? String(parsed.query || parsed.q || '').trim() : '';
        if (!q) {
          var mq = String(raw).match(/"query"\s*:\s*"([^"]*)"/);
          if (mq) q = mq[1].trim();
        }
        if (q) return { kind: 'search', query: q, id: t.id || '' };
      }
    }
    return null;
  }

  function toApiToolCalls(tools) {
    return (tools || []).map(function (t) {
      return {
        id: t.id || ('call_' + uid()),
        type: 'function',
        function: { name: t.name || 'web_search', arguments: t.args || '{}' }
      };
    });
  }
  /** 把 <<search:xxx>> 从正文里摘掉（流式过程中没闭合的半截也吃掉）。 */
  function stripSearchDisplay(text) {
    if (!text) return text || '';
    var out = String(text).replace(SEARCH_MARK, '');
    out = out.replace(/<<[^>]*$/, '');
    return out.replace(/\s+$/, '');
  }

  function takeSearchQuery(m) {
    if (!m || !m.content) return '';
    SEARCH_MARK.lastIndex = 0;
    var hit = SEARCH_MARK.exec(m.content);
    if (!hit) return '';
    m.content = stripSearchDisplay(m.content);
    return String(hit[1] || '').trim();
  }

  /** 新闻类查询改走新闻源（带日期的资讯流），而不是通用网页搜索。 */
  var NEWS_HINT = /新闻|头条|热点|最新|今日|今天|昨天|突发|通报|发布会|进展|官宣|回应|事故|选举|政策/;

  function isNewsQuery(q) {
    return NEWS_HINT.test(String(q || ''));
  }

  function sendCore(text, images) {
    var s = state.cur;
    if (!s) return;
    if (state.streamingId) return;
    if (!resolveProvider(s)) { toast('先添加服务商'); openSettings(); return; }
    if (!s.model) { toast('先选择一个模型'); openChatSettings(); return; }

    var hasText = !!(text && text.trim());
    if (!hasText && (!images || !images.length)) return;

    state.searchCount = 0;
    state.toolPending = null;
    dbg('send', { web: !!s.webSearch, model: s.model, chars: (text || '').length });

    // 搜索只由模型通过 web_search 工具触发，客户端不再猜关键词
    doSend(text, images, '', '');
  }

  function composeSystem(s, webText, allowTools) {
    var system = s.system || '';
    if (webText) {
      system = (system ? system + '\n\n' : '') +
        '【以下是刚刚联网搜索到的实时结果，请结合它们回答；引用事实时在句末标注来源链接。若结果与问题无关可以忽略。】\n' + webText;
    }
    if (allowTools) {
      system = (system ? system + '\n\n' : '') + buildSearchToolPrompt(true);
    }
    if (s.stickerAuto) {
      var stickerRule = buildStickerInstruction();
      if (stickerRule) system = (system ? system + '\n\n' : '') + stickerRule;
    }
    return system;
  }

  function doSend(text, images, webText, webQuery) {
    var s = state.cur;
    if (!s) return;
    if (state.streamingId) return;

    state.searchCount = 0;

    var um = {
      id: uid(), role: 'user', content: text || '', images: images || [], ts: now(),
      web: !!webText, webQuery: webQuery || ''
    };
    var isFirstUser = !s.messages.some(function (m) { return m.role === 'user'; });
    s.messages.push(um);
    if (isFirstUser && (!s.title || s.title === '新会话')) s.title = autoTitle(text);

    var am = {
      id: uid(), role: 'assistant', content: '', reasoning: '', ts: now(),
      streaming: true, model: s.model, web: !!webText, webQuery: webQuery || '',
      webEnabled: !!s.webSearch
    };
    s.messages.push(am);
    state.streamingId = am.id;

    var allowTools = !!(s.webSearch && !webText);
    var system = composeSystem(s, webText, allowTools);

    renderHeader();
    renderMessages();
    renderComposer();
    scrollBottom(true);
    persist(true);
    renderSessions();

    var payload = {
      msgId: am.id,
      providerId: s.providerId,
      model: s.model,
      system: system,
      messages: buildHistory(s, am.id),
      temperature: typeof s.temperature === 'number' ? s.temperature : 0.7,
      maxTokens: s.maxTokens || 0,
      topP: typeof s.topP === 'number' ? s.topP : -1,
      stream: s.stream !== false
    };
    if (payload.stream) payload.streamOptions = { include_usage: true };
    var tools = chatTools(s, allowTools);
    if (tools.length) {
      payload.tools = tools;
      if (isOpenRouter(s)) payload.requireParams = true;
    }
    dbg('chat', {
      tools: tools.map(function (t) { return t['function'].name; }),
      auto: !!s.stickerAuto,
      cats: stickerCategoryNames().length,
      sys: system.length, msgs: payload.messages.length, stream: payload.stream
    });
    Native.chat(JSON.stringify(payload));
  }

  /** 模型在回复里调用了搜索：执行 → 回填结果 → 让它继续写。 */
  function runSearchStep(assistantMsg, query, toolCallId) {
    var s = state.cur;
    if (!s) return false;
    if (state.searchCount >= MAX_SEARCH_PER_TURN) return false;

    state.searchCount += 1;
    var news = isNewsQuery(query);
    dbg('search-start', { query: query, callId: toolCallId || '(marker)', news: news });
    var tool = {
      id: uid(), role: 'tool', content: '', query: query, toolCallId: toolCallId || '',
      engine: '', ts: now(), pending: true
    };
    s.messages.push(tool);
    assistantMsg.streaming = false;
    state.streamingId = null;
    state.toolPending = { toolId: tool.id, assistantId: assistantMsg.id };

    renderMessages();
    renderComposer();
    persist(true);

    try {
      if (news) Native.webSearchNews(query);
      else Native.webSearch(query);
    } catch (e) {
      state.toolPending = null;
      tool.pending = false;
      tool.content = '';
      tool.error = '搜索没能发起';
      continueAfterSearch();
    }
    return true;
  }

  /** 搜索结束后，把结果塞进历史，再让模型接着写。 */
  function continueAfterSearch() {
    var s = state.cur;
    if (!s) return;

    var am = {
      id: uid(), role: 'assistant', content: '', reasoning: '', ts: now(),
      streaming: true, model: s.model, web: true, webQuery: ''
    };
    s.messages.push(am);
    state.streamingId = am.id;

    var allowTools = !!(s.webSearch && state.searchCount < MAX_SEARCH_PER_TURN);
    var system = composeSystem(s, '', allowTools);

    renderMessages();
    renderComposer();
    scrollBottom(true);
    persist(true);

    var payload = {
      msgId: am.id,
      providerId: s.providerId,
      model: s.model,
      system: system,
      messages: buildHistory(s, am.id),
      temperature: typeof s.temperature === 'number' ? s.temperature : 0.7,
      maxTokens: s.maxTokens || 0,
      topP: typeof s.topP === 'number' ? s.topP : -1,
      stream: s.stream !== false
    };
    if (payload.stream) payload.streamOptions = { include_usage: true };
    var tools = chatTools(s, allowTools);
    if (tools.length) {
      payload.tools = tools;
      if (isOpenRouter(s)) payload.requireParams = true;
    }
    Native.chat(JSON.stringify(payload));
  }

  function send() {
    var input = $('#input');
    var text = input.value;
    var imgs = state.images.slice();
    if (!text.trim() && !imgs.length) return;
    input.value = '';
    autosize();
    state.images = [];
    renderAttachments();
    sendCore(text, imgs);
  }

  function stopStream() {
    Native.stop();
    var s = state.cur;
    if (!s) return;
    var m = null;
    for (var i = 0; i < s.messages.length; i++) if (s.messages[i].id === state.streamingId) m = s.messages[i];
    if (m) {
      m.streaming = false;
      if (!m.content) m.error = '已停止';
      updateMessageNode(m);
    }
    state.streamingId = null;
    renderComposer();
    persist(true);
  }

  function regenerate(msgId) {
    var s = state.cur;
    if (!s || state.streamingId) return;
    var idx = -1;
    for (var i = 0; i < s.messages.length; i++) if (s.messages[i].id === msgId) idx = i;
    if (idx < 0) return;
    var u = -1;
    for (var j = idx - 1; j >= 0; j--) if (s.messages[j].role === 'user') { u = j; break; }
    if (u < 0) return;
    var userMsg = s.messages[u];
    var text = userMsg.content;
    var imgs = (userMsg.images || []).slice();
    s.messages = s.messages.slice(0, u);
    renderMessages();
    sendCore(text, imgs);
  }

  function autosize() {
    var t = $('#input');
    t.style.height = 'auto';
    t.style.height = Math.min(132, Math.max(24, t.scrollHeight)) + 'px';
  }

  // ---------------------------------------------------------------- overlays

  function syncOverlay() {
    var any = state.open.drawer || state.open.sheet;
    $('#scrim').classList.toggle('show', any);
    try { if (Native.setOverlay) Native.setOverlay(any || state.open.settings); } catch (e) { }
  }

  function openDrawer() {
    renderSessions();
    $('#drawer').classList.add('open');
    state.open.drawer = true;
    syncOverlay();
  }

  function closeDrawer() {
    $('#drawer').classList.remove('open');
    state.open.drawer = false;
    syncOverlay();
  }

  function openSettings() {
    renderSettings();
    $('#page-settings').classList.add('open');
    state.open.settings = true;
    syncOverlay();
  }

  function closeSettings() {
    $('#page-settings').classList.remove('open');
    state.open.settings = false;
    syncOverlay();
  }

  function openSheet(html) {
    $('#sheet-body').innerHTML = html;
    $('#sheet').classList.add('open');
    state.open.sheet = true;
    syncOverlay();
  }

  function closeSheet() {
    $('#sheet').classList.remove('open');
    state.open.sheet = false;
    var wasSection = !!state.sheetSection;
    state.sheetSection = null;
    syncOverlay();
    // 分区面板关掉后重建设置页，让摘要跟着状态更新
    if (wasSection && state.open.settings) renderSettings();
  }

  function closeTop() {
    if (state.open.sheet) { closeSheet(); return true; }
    if (state.open.settings) { closeSettings(); return true; }
    if (state.open.drawer) { closeDrawer(); return true; }
    return false;
  }

  // ---------------------------------------------------------------- settings UI

  var PRESETS = {
    openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
    deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
    custom: { name: '', baseUrl: '' }
  };

  var ENGINE_NAMES = {
    duckduckgo: 'DuckDuckGo', bing: 'Bing', baidu: '百度',
    tavily: 'Tavily', serper: 'Serper', brave: 'Brave', news: '新闻源'
  };
  var KEYLESS = { duckduckgo: true, bing: true, baidu: true };

  function currentEngine() {
    return state.meta.search.engine || 'duckduckgo';
  }

  function engineNeedsKey() {
    return !KEYLESS[currentEngine()];
  }

  /** 搜索是否可用：免 Key 引擎永远可用，其它引擎要求存过 Key。 */
  /** 重新查询系统 TTS 引擎状态（装完 CloneTTS 后不必重启 App）。 */
  function refreshTts() {
    try {
      var ti = JSON.parse(Native.ttsStatus());
      state.tts.cloneTts = !!ti.cloneTts;
      state.tts.engines = ti.engines || [];
      state.tts.engineCount = typeof ti.engineCount === 'number' ? ti.engineCount : (ti.engines || []).length;
      state.tts.sysEngine = ti.sysEngine || '';
      state.tts.engineError = ti.engineError || '';
    } catch (e) { }
    return state.tts;
  }
  function searchReady() {
    return !engineNeedsKey() || state.hasSearchKey;
  }

  function browserSearchUrl(q) {
    var query = encodeURIComponent(q || '');
    var e = currentEngine();
    if (e === 'baidu') return 'https://www.baidu.com/s?wd=' + query;
    if (e === 'duckduckgo') return 'https://duckduckgo.com/?q=' + query;
    return 'https://www.bing.com/search?q=' + query;
  }
  var BG_PRESETS = {
    none: '',
    space: 'radial-gradient(120% 90% at 18% 0%, #1b2440 0%, #0f1115 62%)',
    dusk: 'linear-gradient(165deg, #2a1f3a 0%, #141620 55%, #0f1115 100%)',
    mist: 'linear-gradient(180deg, #17242f 0%, #0f1115 72%)',
    sand: 'linear-gradient(160deg, #3a2f24 0%, #1a1512 58%, #0f1115 100%)',
    pink: '',
    starry: '',
    moon: '',
    fox: 'radial-gradient(120% 80% at 82% 108%, rgba(210, 86, 78, .22) 0%, rgba(15, 17, 21, 0) 58%), linear-gradient(170deg, #201821 0%, #140f15 55%, #0f1115 100%)'
  };

  /** 气泡主题：按角色分别应用（默认 我=经典红，AI=奶白） */
  function applyBubbles() {
    var b = (state.meta && state.meta.bubble) || {};
    document.body.classList.toggle('bubble-user-cream', b.user === 'cream');
    document.body.classList.toggle('bubble-ai-classic', b.assistant === 'classic');
    var a = typeof state.meta.bubbleAlpha === 'number' ? state.meta.bubbleAlpha : 1;
    try {
      if (document.documentElement.style.setProperty) {
        document.documentElement.style.setProperty('--bubble-alpha', a);
      }
    } catch (e) { }
  }
  // ---- 粉霞背景的花瓣粒子 ----
  var PARTICLE_MAX = { petal: 24, mote: 30 };

  function particleDensity() {
    var d = state.meta && typeof state.meta.particleDensity === 'number' ? state.meta.particleDensity : 0.6;
    return Math.max(0, Math.min(1, d));
  }

  function particleCount(kind) {
    return Math.round(PARTICLE_MAX[kind] * particleDensity());
  }

  function buildMoteHtml(count) {
    var out = '';
    for (var i = 0; i < count; i++) {
      var size = 2 + Math.round(Math.random() * 3);          // 2-5px
      var left = Math.round(Math.random() * 100);
      var top = Math.round(Math.random() * 100);
      var dur = (16 + Math.random() * 14).toFixed(1);
      var delay = (-Math.random() * 30).toFixed(1);
      var op = (0.18 + Math.random() * 0.4).toFixed(2);
      var dx = Math.round(-30 + Math.random() * 60);
      var dy = Math.round(-80 - Math.random() * 120);
      out += '<span style="left:' + left + '%;top:' + top + '%;width:' + size + 'px;height:' + size + 'px;' +
        'opacity:' + op + ';animation-duration:' + dur + 's;animation-delay:' + delay + 's;' +
        '--dx:' + dx + 'px;--dy:' + dy + 'px"></span>';
    }
    return out;
  }

  function buildPetalHtml(count) {
    var out = '';
    for (var i = 0; i < count; i++) {
      var size = 7 + Math.round(Math.random() * 7);          // 7-14px
      var left = Math.round(Math.random() * 100);            // 0-100%
      var dur = (14 + Math.random() * 12).toFixed(1);        // 14-26s
      var delay = (-Math.random() * 26).toFixed(1);          // 负延迟，一开始就有花瓣在半空
      var drift = Math.round(-40 + Math.random() * 120);     // 水平漂移
      var op = (0.25 + Math.random() * 0.35).toFixed(2);
      out += '<span style="left:' + left + '%;width:' + size + 'px;height:' + size + 'px;' +
        'opacity:' + op + ';animation-duration:' + dur + 's;animation-delay:' + delay + 's;' +
        '--drift:' + drift + 'px"></span>';
    }
    return out;
  }

  function syncComposerHeight() {
    try {
      var c = document.querySelector('.composer');
      var h = (c && c.getBoundingClientRect) ? Math.round(c.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty('--composer-h', (h || 0) + 'px');
    } catch (e) { }
  }

  function ensureParticles(kind) {
    var el = $('#messages');
    if (!el) return;
    syncComposerHeight();
    var cls = kind === 'mote' ? 'motes' : 'petals';
    var have = el.querySelector('.petals') || el.querySelector('.motes');
    if (have && have.className === cls) return;
    if (have && have.parentNode && have.parentNode.removeChild) have.parentNode.removeChild(have);
    var n = particleCount(kind === 'mote' ? 'mote' : 'petal');
    if (n <= 0) return;
    var box = document.createElement('div');
    box.className = cls;
    box.innerHTML = kind === 'mote' ? buildMoteHtml(n) : buildPetalHtml(n);
    el.insertBefore(box, el.firstChild);
  }

  function removeParticles() {
    try {
      var el = $('#messages');
      if (!el) return;
      ['petals', 'motes'].forEach(function (c) {
        var box = el.querySelector('.' + c);
        if (!box) return;
        if (box.parentNode && box.parentNode.removeChild) box.parentNode.removeChild(box);
        else if (box.remove) box.remove();
      });
    } catch (e) { }
  }
  // 带图片 + 粒子的预设主题
  var IMAGE_BG = {
    pink:   { file: 'bg-pink.webp',   kind: 'petal' },
    starry: { file: 'bg-starry.webp', kind: 'mote' },
    moon:   { file: 'bg-moon.webp',   kind: 'mote' }
  };

  function applyBackground() {
    var el = $('#messages');
    if (!el) return;
    var bg = state.meta.chatBackground || {};
    var dim = typeof bg.dim === 'number' ? bg.dim : 0.45;
    var imgPreset = (!bg.image && IMAGE_BG[bg.preset]) ? IMAGE_BG[bg.preset] : null;
    el.classList.toggle('bg-fox', !bg.image && bg.preset === 'fox');
    el.classList.toggle('bg-pink', !!imgPreset);
    if (imgPreset) ensureParticles(imgPreset.kind); else removeParticles();

    // 亮度调节 = 在图上叠一层深色遮罩，0 = 原图，越大越暗
    var shade = 'linear-gradient(rgba(15,17,21,' + dim + '), rgba(15,17,21,' + dim + '))';

    if (bg.image) {
      el.style.backgroundImage = shade + ', url("' + bg.image + '")';
      el.style.backgroundSize = 'cover, cover';
      el.style.backgroundPosition = 'center, center';
      el.style.backgroundRepeat = 'no-repeat, no-repeat';
      el.style.backgroundAttachment = 'fixed, fixed';
    } else if (imgPreset) {
      el.style.backgroundImage = shade + ', url("' + imgPreset.file + '")';
      el.style.backgroundSize = 'cover, cover';
      el.style.backgroundPosition = 'center, center';
      el.style.backgroundRepeat = 'no-repeat, no-repeat';
      el.style.backgroundAttachment = 'fixed, fixed';
    } else if (bg.preset && bg.preset !== 'none' && BG_PRESETS[bg.preset]) {
      el.style.backgroundImage = BG_PRESETS[bg.preset];
      el.style.backgroundSize = '';
      el.style.backgroundPosition = '';
      el.style.backgroundRepeat = '';
      el.style.backgroundAttachment = '';
    } else {
      el.style.backgroundImage = '';
      el.style.backgroundSize = '';
      el.style.backgroundPosition = '';
      el.style.backgroundRepeat = '';
      el.style.backgroundAttachment = '';
    }
  }

  /** 设置页分区：把长页面收进摘要卡片，点开才展示 */
  var SECTION_GROUPS = {
    providers: ['服务商'],
    appearance: ['头像', '聊天气泡', '聊天背景'],
    voice: ['语音朗读'],
    stickers: ['表情包'],
    about: ['诊断', '额度', '关于']
  };

  var SECTION_TITLES = {
    providers: '服务商与模型',
    appearance: '外观',
    voice: '语音朗读',
    stickers: '表情包',
    about: '诊断与关于'
  };

  function sectionSummary(key) {
    var s = state.cur || {};
    if (key === 'providers') {
      var p = provider(s.providerId);
      if (!p) return '未配置';
      return (p.name || '服务商') + ' · ' + (s.model || '未选模型');
    }
    if (key === 'appearance') {
      var b = state.meta.bubble || {};
      var av = state.meta.avatars || {};
      var bgNames = { none: '无', space: '深空', dusk: '暮色', mist: '青灰', sand: '暖沙', fox: '语见', pink: '粉霞漫天', starry: '纸灯夜航', moon: '月照重楼' };
      var bg = state.meta.chatBackground || {};
      var bgTxt = bg.image ? '自定义图片' : (bgNames[bg.preset] || '无');
      return '头像 ' + ((av.user || av.assistant) ? '自定义' : '默认') +
        ' · 气泡 ' + (b.user === 'cream' ? '奶白' : '经典红') +
        ' / ' + (b.assistant === 'classic' ? '深色' : '奶白') +
        ' · 背景 ' + bgTxt;
    }
    if (key === 'voice') {
      var n = stickerCategoryNames().length;
      var rate = (state.tts && state.tts.rate ? state.tts.rate : 1).toFixed(1);
      var txt = (s.autoRead ? '自动朗读' : '手动朗读') + ' · ' + rate + 'x';
      if (!state.tts.engineCount) txt += ' · 未装引擎';
      else if (state.tts.cloneTts) txt += ' · CloneTTS';
      return txt;
    }
    if (key === 'stickers') {
      var cats = (state.stickers && state.stickers.categories) || [];
      if (!cats.length) return '未导入分类';
      var g = typeof state.meta.stickerGlobal === 'number' ? state.meta.stickerGlobal : 0;
      return cats.length + ' 个分类 · 主动 ' + g + '% · ' + (s.stickerAuto ? '开' : '关');
    }
    return 'v' + (window.APP_VERSION || '') + ' · 诊断日志';
  }

  function buildSummaryCards() {
    var keys = ['providers', 'appearance', 'voice', 'stickers', 'about'];
    return keys.map(function (k) {
      return '<button class="set-card" data-section="' + k + '">' +
        '<div class="set-card-main">' +
        '<div class="set-card-title">' + SECTION_TITLES[k] + '</div>' +
        '<div class="set-card-sub">' + esc(sectionSummary(k)) + '</div>' +
        '</div><div class="set-card-arrow">›</div></button>';
    }).join('');
  }

  /** 把已渲染的区块收进隐藏容器，页面上只放摘要卡 */
  function groupSettingsSections() {
    var body = $('#settings-body');
    if (!body) return;
    var all = document.createElement('div');
    all.className = 'set-all';
    while (body.firstChild) all.appendChild(body.firstChild);
    body.appendChild(all);

    var cards = document.createElement('div');
    cards.id = 'set-cards';
    cards.innerHTML = buildSummaryCards();
    body.insertBefore(cards, all);

    var map = {};
    var cur = null;
    Array.prototype.slice.call(all.children).forEach(function (node) {
      if (node.classList.contains('section-title')) {
        cur = node.textContent.trim();
        map[cur] = map[cur] || [];
        map[cur].push(node);
      } else if (cur) {
        map[cur].push(node);
      } else {
        body.insertBefore(node, cards); // hero 等，留在页面上
      }
    });
    state.setSections = map;

    Array.prototype.forEach.call(cards.querySelectorAll('[data-section]'), function (el) {
      el.addEventListener('click', function () { openSection(el.dataset.section); });
    });
  }

  /** 取出某个分区当前的所有节点 */
  function collectSection(key) {
    var names = SECTION_GROUPS[key] || [];
    var nodes = [];
    var map = state.setSections || {};
    names.forEach(function (n) {
      (map[n] || []).forEach(function (x) { nodes.push(x); });
    });
    return nodes;
  }

  /** 打开某个分区的控制面板（把已绑好事件的节点搬进 sheet） */
  function openSection(key) {
    var nodes = collectSection(key);
    if (!nodes.length) return;
    var map = state.setSections || {};
    var all = document.querySelector('#settings-body .set-all');
    if (all) {
      for (var k in map) {
        if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
        map[k].forEach(function (n) {
          if (n.parentNode !== all) all.appendChild(n);
        });
      }
    }
    openSheet('<div class="row between"><div class="section-title" style="margin:0">' +
      (SECTION_TITLES[key] || '设置') + '</div>' +
      '<button class="btn small" id="sec-done">完成</button></div>');
    var sheetBody = $('#sheet-body');
    nodes.forEach(function (n) { sheetBody.appendChild(n); });
    $('#sec-done').addEventListener('click', closeSheet);
    state.sheetSection = key;
  }

  /** 设置项变了：重建设置页，并把当前分区面板重新铺一遍，否则面板内容不会更新 */
  function refreshSection() {
    var key = state.sheetSection;
    renderSettings();
    if (key) openSection(key);
  }
  function renderSettings() {
    refreshTts();
    var body = $('#settings-body');
    var html = '';

    html += '<div class="set-hero">' +
      '<img class="set-hero-img" src="mascot-empty.webp" alt="">' +
      '<div class="set-hero-text">' +
      '<div class="set-hero-title">语见</div>' +
      '<div class="set-hero-sub">本地界面 · 请求直连模型<br>不做过滤与改写</div>' +
      '</div></div>';

    if (!state.providers.length) {
      html += '<div class="card">' +
        '<div class="row between"><b>先添加一个服务商</b><span class="badge off">未配置</span></div>' +
        '<div class="muted" style="margin:9px 0 12px">客户端不内置任何内容审查或改写：请求按你填的地址和 Key 原样发出，只负责收发、渲染与本地保存。</div>' +
        '<div class="chip-row">' +
        '<button class="btn small primary" data-act="preset" data-k="openrouter">OpenRouter</button>' +
        '<button class="btn small primary" data-act="preset" data-k="deepseek">DeepSeek</button>' +
        '<button class="btn small" data-act="preset" data-k="custom">自定义</button>' +
        '</div></div>';
    } else {
      html += '<div class="section-title">服务商</div>';
      state.providers.forEach(function (p) {
        html += '<div class="card" data-pid="' + esc(p.id) + '">' +
          '<div class="row between"><b>' + esc(p.name || '未命名') + '</b>' +
          '<span class="badge ' + (p.hasKey ? '' : 'off') + '">' + (p.hasKey ? '已配置' : '缺少 Key') + '</span></div>' +
          '<div class="muted" style="margin-top:6px">' + esc(p.baseUrl) + '</div>' +
          '<div class="muted" style="margin-top:3px">模型 ' + ((p.models || []).length) + ' 个 · 默认 ' + esc(p.defaultModel || '未设置') + '</div>' +
          '<div class="row wrap" style="margin-top:11px;gap:6px">' +
          '<button class="btn small" data-act="models" data-pid="' + esc(p.id) + '">拉取模型</button>' +
          '<button class="btn small" data-act="edit" data-pid="' + esc(p.id) + '">编辑</button>' +
          '<button class="btn small danger" data-act="del" data-pid="' + esc(p.id) + '">删除</button>' +
          '</div></div>';
      });
      html += '<button class="btn block" data-act="add">+ 添加服务商</button>';
    }

    html += '<div class="section-title">头像</div>' +
      '<div class="card">' +
      '<div class="avatar-row">' +
      '<div class="avatar-big user" id="av-user-preview"' + (state.meta.avatars.user ? ' style="background-image:url(' + state.meta.avatars.user + ')"' : '') + '>' +
      (state.meta.avatars.user ? '' : '我') + '</div>' +
      '<div class="s-label" style="flex:1">我的头像</div>' +
      '<button class="btn small" data-act="avatar" data-role="user">更换</button>' +
      (state.meta.avatars.user ? '<button class="btn small ghost" data-act="avatar-reset" data-role="user">默认</button>' : '') +
      '</div>' +
      '<div class="avatar-row">' +
      '<div class="avatar-big ai" style="background-image:url(' + (state.meta.avatars.assistant || 'avatar-ai.webp') + ')"></div>' +
      '<div class="s-label" style="flex:1">AI 头像</div>' +
      '<button class="btn small" data-act="avatar" data-role="assistant">更换</button>' +
      (state.meta.avatars.assistant ? '<button class="btn small ghost" data-act="avatar-reset" data-role="assistant">默认</button>' : '') +
      '</div>' +
      '<div class="muted" style="margin-top:6px">头像会裁成方形并压缩到 192px，仅保存在本机。表情包槽位在聊天页底部的笑脸按钮里。</div>' +
      '</div>';

    html += '<div class="section-title">联网搜索</div>' +
      '<div class="card">' +
      '<div class="hint" style="margin-bottom:8px">免 Key 引擎直接抓搜索结果页；配了 Key 的引擎会优先用于新闻类查询（Tavily 走 topic=news，只返回近 7 天的资讯）。</div>' +
      '<div class="chip-row" style="margin-bottom:10px">' +
      ['duckduckgo', 'bing', 'baidu'].map(function (e) {
        var active = (state.meta.search.engine || 'duckduckgo') === e;
        return '<button class="chip' + (active ? ' active' : '') + '" data-act="engine" data-engine="' + e + '">' + ENGINE_NAMES[e] + '</button>';
      }).join('') +
      '</div>' +
      '<div class="hint" style="margin-bottom:8px">以下三个需要注册拿 Key（结果更干净、限速更宽松）：</div>' +
      '<div class="chip-row" style="margin-bottom:10px">' +
      ['tavily', 'serper', 'brave'].map(function (e) {
        var active = (state.meta.search.engine || 'duckduckgo') === e;
        return '<button class="chip' + (active ? ' active' : '') + '" data-act="engine" data-engine="' + e + '">' + ENGINE_NAMES[e] + '</button>';
      }).join('') +
      '</div>' +
      (engineNeedsKey()
        ? ('<div class="field" style="margin-bottom:8px"><label>搜索 API Key' + (state.hasSearchKey ? '（已加密保存，留空则不修改）' : '') + '</label>' +
          '<input id="sk-key" type="password" placeholder="' + (state.hasSearchKey ? '已保存' : 'tvly-… / serper / brave key') + '" autocapitalize="off" autocomplete="off"></div>' +
          '<button class="btn block" data-act="save-search">保存搜索 Key</button>')
        : '<div class="muted">当前引擎「' + ENGINE_NAMES[state.meta.search.engine || 'duckduckgo'] + '」不需要 Key，开箱可用。</div>') +
      '<div class="muted" style="margin-top:9px">开启后，发送前会用这条消息去搜索，把前 5 条结果的标题、链接、摘要拼成上下文交给模型；消息上会显示「🌐 联网」标记。</div>' +
      '</div>';

    var bb = state.meta.bubble || { user: 'classic', assistant: 'cream' };
    html += '<div class="section-title">聊天气泡</div>' +
      '<div class="card">' +
      '<div class="row between" style="align-items:center;margin-bottom:10px">' +
      '<div class="s-label">我的气泡</div>' +
      '<div class="chip-row" style="margin:0">' +
      '<button class="chip' + (bb.user !== 'cream' ? ' active' : '') + '" data-act="bubble" data-role="user" data-style="classic">经典红</button>' +
      '<button class="chip' + (bb.user === 'cream' ? ' active' : '') + '" data-act="bubble" data-role="user" data-style="cream">奶白</button>' +
      '</div></div>' +
      '<div class="row between" style="align-items:center">' +
      '<div class="s-label">AI 气泡</div>' +
      '<div class="chip-row" style="margin:0">' +
      '<button class="chip' + (bb.assistant === 'classic' ? ' active' : '') + '" data-act="bubble" data-role="assistant" data-style="classic">深色</button>' +
      '<button class="chip' + (bb.assistant !== 'classic' ? ' active' : '') + '" data-act="bubble" data-role="assistant" data-style="cream">奶白</button>' +
      '</div></div>' +
      '<div class="slider-row" style="margin-top:10px"><label>气泡透明度</label>' +
      '<input type="range" id="set-bubble-alpha" min="0.35" max="1" step="0.05" value="' + (typeof state.meta.bubbleAlpha === 'number' ? state.meta.bubbleAlpha : 1) + '">' +
      '<div class="val" id="set-bubble-alpha-v">' + Math.round((typeof state.meta.bubbleAlpha === 'number' ? state.meta.bubbleAlpha : 1) * 100) + '%</div></div>' +
      '</div>';
    html += '<div class="section-title">聊天背景</div>' +
      '<div class="card">' +
      '<div class="chip-row" style="margin-bottom:10px">' +
      ['none', 'space', 'dusk', 'mist', 'sand', 'fox', 'pink', 'starry', 'moon'].map(function (k) {
        var names = { none: '无', space: '深空', dusk: '暮色', mist: '青灰', sand: '暖沙', fox: '语见', pink: '粉霞漫天', starry: '纸灯夜航', moon: '月照重楼' };
        var active = (state.meta.chatBackground.preset || 'none') === k && !state.meta.chatBackground.image;
        return '<button class="chip' + (active ? ' active' : '') + '" data-act="bg-preset" data-key="' + k + '">' + names[k] + '</button>';
      }).join('') +
      '</div>' +
      '<div class="row wrap" style="gap:6px">' +
      '<button class="btn small" data-act="bg-image">选择图片</button>' +
      (state.meta.chatBackground.image ? '<button class="btn small ghost" data-act="bg-clear">清除图片</button>' : '') +
      '</div>' +
      '<div class="slider-row" style="margin-top:12px"><label>特效密度</label>' +
      '<input type="range" id="bg-particles" min="0" max="1" step="0.1" value="' + (typeof state.meta.particleDensity === 'number' ? state.meta.particleDensity : 0.6) + '">' +
      '<div class="val" id="bg-particles-v">' + Math.round((typeof state.meta.particleDensity === 'number' ? state.meta.particleDensity : 0.6) * 100) + '%</div></div>' +
      '<div class="slider-row" style="margin-top:12px"><label>亮度</label>' +
      '<input type="range" id="bg-dim" min="0" max="0.9" step="0.05" value="' + (typeof state.meta.chatBackground.dim === 'number' ? state.meta.chatBackground.dim : 0.45) + '">' +
      '<div class="val" id="bg-dim-v">' + Math.round((typeof state.meta.chatBackground.dim === 'number' ? state.meta.chatBackground.dim : 0.45) * 100) + '%</div></div>' +
      '<div class="muted" style="margin-top:9px">亮度是叠在背景图上的暗色层：0% 显示原图，越高越暗、文字越清楚。图片会按长边 1080 压缩后存在本机。</div>' +
      '<button class="btn small ghost block" style="margin-top:14px" data-act="reset-appearance">重置外观设置</button>' +
      '</div>';
    html += '<div class="section-title">数据</div>' +
      '<div class="card">' +
      '<div class="row wrap" style="gap:6px">' +
      '<button class="btn small" data-act="exportAll">导出全部会话</button>' +
      '<button class="btn small" data-act="importAll">导入会话</button>' +
      '</div>' +
      '<div class="muted" style="margin-top:10px">会话存在应用私有目录；导出的 JSON 含完整对话与图片。API Key 用 Android Keystore 加密，不会进入导出文件。</div>' +
      '</div>';

    var ttsInfo = state.tts || {};
    html += '<div class="section-title">语音朗读</div>' +
      '<div class="card">' +
      '<div class="switch-row" style="padding:4px 2px"><div><div class="s-label">自动朗读回复</div>' +
      '<div class="s-desc">每条回复生成完自动读出来</div></div>' +
      '<div class="switch' + (state.cur && state.cur.autoRead ? ' on' : '') + '" id="set-autoread"></div></div>' +
      '<div class="hint" style="margin-top:8px">' +
      (state.tts.engineCount === 0
        ? '手机里没有 TTS 引擎，先安装 CloneTTS 或 Google 语音服务'
        : (ttsInfo.cloneTts
          ? '已检测到 CloneTTS（' + state.tts.engineCount + ' 个引擎），优先走本地接口 127.0.0.1:8080'
          : '系统 TTS（' + state.tts.engineCount + ' 个引擎），未检测到 CloneTTS')) +
      '</div>' +
      '<button class="btn small block" data-act="tts-settings" style="margin-top:6px">打开系统 TTS 设置</button>' +
      '<div class="slider-row" style="margin-top:8px"><label>语速</label>' +
      '<input type="range" id="set-tts-rate" min="0.5" max="2" step="0.1" value="' + (ttsInfo.rate || 1) + '">' +
      '<div class="val" id="set-tts-rate-v">' + (ttsInfo.rate || 1).toFixed(1) + 'x</div></div>' +
      '<div class="field"><input id="set-tts-voice" placeholder="CloneTTS 音色代号（留空用默认音色）" value="' + esc(ttsInfo.voice || '') + '"></div>' +
      '<div class="switch-row" style="padding:4px 2px"><div><div class="s-label">优先用本地接口</div>' +
      '<div class="s-desc">CloneTTS 的 HTTP 服务（失败自动回落系统 TTS）</div></div>' +
      '<div class="switch' + (ttsInfo.preferApi ? ' on' : '') + '" id="set-tts-api"></div></div>' +
      '<button class="btn small block" id="set-tts-test" style="margin-top:8px">试听一句</button>' +
      '</div>';
    var stickerCats = stickerCategoryNames();
    html += '<div class="section-title">表情包</div>' +
      '<div class="card">' +
      '<div class="switch-row" style="padding:4px 2px"><div><div class="s-label">自动表情</div>' +
      '<div class="s-desc">' + (stickerCats.length ? '已导入 ' + stickerCats.length + ' 个分类' : '还没有导入分类，先点下面的「导入文件夹」') + '</div></div>' +
      '<div class="switch' + (state.cur && state.cur.stickerAuto ? ' on' : '') + '" id="set-sticker"></div></div>' +
      '<div class="slider-row" style="margin-top:6px"><label>主动表情</label>' +
      '<input type="range" id="set-sticker-global" min="0" max="100" step="10" value="' + (typeof state.meta.stickerGlobal === 'number' ? state.meta.stickerGlobal : 0) + '">' +
      '<div class="val" id="set-sticker-global-v">' + (typeof state.meta.stickerGlobal === 'number' ? state.meta.stickerGlobal : 0) + '%</div></div>' +
      '<div class="hint" style="margin-top:-2px">0 = 由模型决定；100 = 每轮回复都补一张「默认」分类的表情（模型没情绪时兜底）</div>' +
      '<div class="row wrap" style="gap:6px;margin-top:8px">' +
      '<button class="btn small" data-act="sticker-manage">管理表情包</button>' +
      '<button class="btn small" data-act="sticker-import">导入文件夹</button>' +
      '</div></div>';
    html += '<div class="section-title">诊断</div>' +
      '<div class="card">' +
      '<div class="muted" style="margin-bottom:8px">联网事件记录（同时输出到 logcat）。反馈问题时复制这段。</div>' +
      '<pre class="diag">' + esc(DEBUG.join('\n') || '（还没有记录）') + '</pre>' +
      '<button class="btn small" data-act="copy-diag">复制日志</button>' +
      '</div>';

    var u = state.meta.usage || { p: 0, c: 0, rounds: 0 };
    var bal = state.balance && state.balance.ok
      ? ('余额 ' + (state.balance.currency === 'USD' ? '$' : '¥') + Number(state.balance.balance).toFixed(2))
      : '未查询';
    html += '<div class="section-title">额度</div>' +
      '<div class="card">' +
      '<div class="switch-row" style="padding:2px"><div><div class="s-label">额度桌宠</div>' +
      '<div class="s-desc">聊天页右下角显示余额或本轮 token</div></div>' +
      '<div class="switch' + (state.meta.showQuota ? ' on' : '') + '" id="set-quota"></div></div>' +
      '<div class="muted" style="margin-top:10px">' + esc(bal) +
      ' · 累计 ' + fmtTok((u.p || 0) + (u.c || 0)) + ' tokens / ' + (u.rounds || 0) + ' 轮</div>' +
      '<button class="btn small block" data-act="fetch-balance" style="margin-top:10px">立即查询余额</button>' +
      '<div class="muted" style="margin-top:9px">余额接口只支持 DeepSeek、OpenRouter 和 one-api 系中转；' +
      '其他服务商查询会提示不支持（token 统计不受影响）。</div>' +
      '</div>' +
      '<div class="section-title">关于</div>' +
      '<div class="card"><div class="muted">语见 3.30 · 本地 WebView 界面 + 原生 HTTP 层。<br>' +
      '客户端不做内容审查、不注入审查提示词、不改写你的消息；模型与服务端自身的策略不受本应用控制。</div></div>';

    body.innerHTML = html;
    groupSettingsSections();

    var autoReadEl = $('#set-autoread');
    if (autoReadEl) {
      autoReadEl.addEventListener('click', function () {
        if (!state.cur) return;
        state.cur.autoRead = !state.cur.autoRead;
        this.classList.toggle('on', state.cur.autoRead);
        persist(true);
      });
    }
    var rateEl = $('#set-tts-rate');
    if (rateEl) {
      rateEl.addEventListener('input', function () {
        state.tts.rate = Number(this.value);
        $('#set-tts-rate-v').textContent = state.tts.rate.toFixed(1) + 'x';
        saveTts();
      });
    }
    var voiceEl = $('#set-tts-voice');
    if (voiceEl) {
      voiceEl.addEventListener('change', function () {
        state.tts.voice = this.value.trim();
        saveTts();
      });
    }
    var apiEl = $('#set-tts-api');
    if (apiEl) {
      apiEl.addEventListener('click', function () {
        state.tts.preferApi = !state.tts.preferApi;
        this.classList.toggle('on', state.tts.preferApi);
        saveTts();
      });
    }
    var testEl = $('#set-tts-test');
    if (testEl) {
      testEl.addEventListener('click', function () {
        try {
          Native.ttsConfigure(JSON.stringify({ voice: state.tts.voice, rate: state.tts.rate, preferApi: !!state.tts.preferApi }));
          Native.ttsSpeak('你好，这是语音测试。今天天气不错。');
        } catch (e) { toast('朗读失败：' + e.message); }
      });
    }
    var gEl = $('#set-sticker-global');
    if (gEl) {
      gEl.addEventListener('input', function () {
        state.meta.stickerGlobal = Number(this.value);
        var v = $('#set-sticker-global-v');
        if (v) v.textContent = this.value + '%';
        saveMeta();
      });
    }
    var alphaEl = $('#set-bubble-alpha');
    if (alphaEl) {
      alphaEl.addEventListener('input', function () {
        state.meta.bubbleAlpha = Number(this.value);
        var v = $('#set-bubble-alpha-v');
        if (v) v.textContent = Math.round(state.meta.bubbleAlpha * 100) + '%';
        applyBubbles();
        saveMeta();
      });
    }
    var partEl = $('#bg-particles');
    if (partEl) {
      partEl.addEventListener('input', function () {
        state.meta.particleDensity = Number(this.value);
        var v = $('#bg-particles-v');
        if (v) v.textContent = Math.round(state.meta.particleDensity * 100) + '%';
        removeParticles();
        var bgp = state.meta.chatBackground || {};
        if (!bgp.image && IMAGE_BG[bgp.preset]) ensureParticles(IMAGE_BG[bgp.preset].kind);
        saveMeta();
      });
    }
    var dimEl2 = $('#bg-dim');
    if (dimEl2) {
      dimEl2.addEventListener('input', function () {
        state.meta.chatBackground.dim = Number(this.value);
        var v = $('#bg-dim-v');
        if (v) v.textContent = Math.round(state.meta.chatBackground.dim * 100) + '%';
        applyBackground();
        saveMeta();
      });
    }
    var quotaEl = $('#set-quota');
    if (quotaEl) {
      quotaEl.addEventListener('click', function () {
        state.meta.showQuota = !state.meta.showQuota;
        this.classList.toggle('on', state.meta.showQuota);
        saveMeta();
        renderPet();
        if (state.meta.showQuota) {
          setPetBubble('查余额中…', 4000);
          try { Native.fetchBalance((state.cur && state.cur.providerId) || ''); } catch (e) { }
        }
      });
    }
    var setSticker = $('#set-sticker');
    if (setSticker) {
      setSticker.addEventListener('click', function () {
        toggleStickerAuto(this);
        renderSettings();
      });
    }
    var dimEl = $('#bg-dim');
    if (dimEl) {
      dimEl.addEventListener('input', function (e) {
        state.meta.chatBackground.dim = Number(e.target.value);
        var label = $('#bg-dim-v');
        if (label) label.textContent = Math.round(state.meta.chatBackground.dim * 100) + '%';
        applyBackground();
        saveMeta();
      });
    }
  }

  function openProviderForm(existing, presetKey) {
    var p = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: uid(), name: '', baseUrl: '', defaultModel: '', models: [], hasKey: false
    };
    if (presetKey && PRESETS[presetKey]) {
      p.name = PRESETS[presetKey].name;
      p.baseUrl = PRESETS[presetKey].baseUrl;
    }
    var isNew = !existing;

    openSheet(
      '<div class="section-title" style="margin-top:0">' + (isNew ? '添加服务商' : '编辑服务商') + '</div>' +
      '<div class="field"><label>名称</label><input id="pf-name" value="' + esc(p.name) + '" placeholder="OpenRouter"></div>' +
      '<div class="field"><label>Base URL（写到 /v1 为止）</label><input id="pf-url" value="' + esc(p.baseUrl) + '" placeholder="https://openrouter.ai/api/v1" autocapitalize="off" autocomplete="off"></div>' +
      '<div class="field"><label>API Key' + (p.hasKey ? '（已加密保存，留空则不修改）' : '') + '</label><input id="pf-key" type="password" placeholder="' + (p.hasKey ? '已保存' : 'sk-…') + '" autocapitalize="off" autocomplete="off"></div>' +
      '<div class="field"><label>默认模型（可留空，之后在模型面板选）</label><input id="pf-model" value="' + esc(p.defaultModel || '') + '" placeholder="deepseek-chat" autocapitalize="off"></div>' +
      '<div class="row" style="gap:8px;margin-top:16px">' +
      '<button class="btn" style="flex:1" id="pf-cancel">取消</button>' +
      '<button class="btn primary" style="flex:1" id="pf-save">保存</button></div>' +
      '<div class="hint" style="margin-top:12px">OpenRouter：https://openrouter.ai/api/v1<br>DeepSeek：https://api.deepseek.com/v1</div>'
    );

    $('#pf-cancel').addEventListener('click', closeSheet);
    $('#pf-save').addEventListener('click', function () {
      var name = $('#pf-name').value.trim() || '未命名';
      var url = $('#pf-url').value.trim().replace(/\/+$/, '');
      var key = $('#pf-key').value.trim();
      var defModel = $('#pf-model').value.trim();
      if (!url) { toast('Base URL 不能为空'); return; }
      if (!/^https?:\/\//i.test(url)) { toast('Base URL 需要以 http(s):// 开头'); return; }

      var obj = { id: p.id, name: name, baseUrl: url, defaultModel: defModel, models: p.models || [], hasKey: p.hasKey };
      if (key) obj.key = key;

      var idx = -1;
      for (var i = 0; i < state.providers.length; i++) if (state.providers[i].id === obj.id) idx = i;
      if (idx >= 0) state.providers[idx] = obj; else state.providers.push(obj);
      if (!state.activeProviderId) state.activeProviderId = obj.id;

      // backfill the current session so sending works right after adding the first provider
      if (state.cur) {
        var curP = state.cur.providerId ? provider(state.cur.providerId) : null;
        if (!curP) {
          state.cur.providerId = obj.id;
          if (!state.cur.model) state.cur.model = obj.defaultModel || '';
          persist(true);
        }
      }

      Native.saveProviders(JSON.stringify(state.providers));
      Native.setActiveProvider(state.activeProviderId);
      closeSheet();
      renderSettings();
      renderHeader();
      toast('已保存');
      // if the session still has no model, help the user pick one right away
      if (state.cur && !state.cur.model && state.cur.providerId === obj.id) {
        setTimeout(openModelSheet, 260);
      }
    });
  }

  function openChatSettings() {
    var s = state.cur;
    if (!s) return;
    var p = resolveProvider(s);
    if (!p) { toast('先添加服务商'); openSettings(); return; }

    var models = p.models || [];
    var listHtml = models.length
      ? models.map(function (m) {
        return '<div class="model-item' + (m.id === s.model ? ' active' : '') + '" data-mid="' + esc(m.id) + '">' +
          '<span class="mid">' + esc(m.id) + '</span>' + (m.id === s.model ? '<span class="check">✓</span>' : '') + '</div>';
      }).join('')
      : '<div class="hint" style="padding:10px 2px">还没有模型列表。点右上「拉取」从服务端获取，或在设置里手填默认模型。</div>';

    var chips = state.providers.map(function (p2) {
      return '<button class="chip' + (p2.id === s.providerId ? ' active' : '') + '" data-pid="' + esc(p2.id) + '">' + esc(p2.name) + '</button>';
    }).join('');

    var ctx = s.contextLimit || 0;

    openSheet(
      '<div class="row between"><div class="section-title" style="margin:0">服务商</div>' +
      '<button class="btn small" id="ms-manage">管理</button></div>' +
      '<div class="chip-row" style="margin:8px 0 4px">' + chips + '</div>' +

      '<div class="row between" style="margin-top:14px"><div class="section-title" style="margin:0">模型</div>' +
      '<button class="btn small" id="ms-fetch">拉取</button></div>' +
      '<div class="search" style="margin-top:8px"><input id="ms-search" placeholder="搜索模型…" autocapitalize="off"></div>' +
      '<div class="model-list" id="ms-list">' + listHtml + '</div>' +

      '<div class="section-title">参数</div>' +
      '<div class="slider-row"><label>温度</label><input type="range" id="ms-temp" min="0" max="2" step="0.05" value="' + s.temperature + '"><div class="val" id="ms-temp-v">' + Number(s.temperature).toFixed(2) + '</div></div>' +
      '<div class="slider-row"><label>上下文长度</label><input type="range" id="ms-ctx" min="0" max="60" step="2" value="' + Math.min(60, ctx) + '"><div class="val" id="ms-ctx-v">' + (ctx ? ctx + ' 条' : '全部') + '</div></div>' +
      '<div class="slider-row"><label>最大 tokens</label><input type="range" id="ms-max" min="0" max="16384" step="256" value="' + (s.maxTokens || 0) + '"><div class="val" id="ms-max-v">' + (s.maxTokens ? s.maxTokens : '默认') + '</div></div>' +
      '<div class="slider-row"><label>top_p</label><input type="range" id="ms-top" min="-1" max="1" step="0.05" value="' + s.topP + '"><div class="val" id="ms-top-v">' + (s.topP < 0 ? '默认' : Number(s.topP).toFixed(2)) + '</div></div>' +

      '<div class="section-title">开关</div>' +
      '<div class="switch-row"><div><div class="s-label">流式输出</div>' +
      '<div class="s-desc">逐字显示；关闭后等整段返回再显示</div></div>' +
      '<div class="switch' + (s.stream !== false ? ' on' : '') + '" id="ms-stream"></div></div>' +
      '<div class="switch-row"><div><div class="s-label">联网搜索</div>' +
      '<div class="s-desc" id="ms-web-desc">' + (searchReady()
        ? '发送前先用 ' + ENGINE_NAMES[currentEngine()] + ' 搜一次，再把结果交给模型'
        : ENGINE_NAMES[currentEngine()] + ' 需要 Key，点一下去设置') + '</div></div>' +
      '<div class="switch' + (s.webSearch ? ' on' : '') + '" id="ms-web"></div></div>' +
      '<div class="row" style="margin:8px 2px 2px;gap:8px"><button class="btn small" id="ms-browser">用系统浏览器搜索</button>' +
      '<span class="hint">' + ENGINE_NAMES[currentEngine()] + '</span></div>' +
      '<div class="switch-row"><div><div class="s-label">自动表情</div>' +
      '<div class="s-desc">' + stickerAutoDesc() + '</div></div>' +
      '<div class="switch' + (s.stickerAuto ? ' on' : '') + '" id="ms-sticker"></div></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn small" id="ms-packs">管理表情包分类</button></div>' +

      '<div class="field" style="margin-top:14px"><label>系统提示词（默认留空，应用不预置任何内容）</label>' +
      '<textarea id="ms-sys" placeholder="留空则不发送 system 消息">' + esc(s.system || '') + '</textarea></div>' +
      '<button class="btn primary block" id="ms-done">完成</button>'
    );

    $('#ms-manage').addEventListener('click', function () { closeSheet(); openSettings(); });
    $('#ms-done').addEventListener('click', function () {
      s.system = $('#ms-sys').value;
      persist(true);
      closeSheet();
      renderHeader();
      renderToolbar();
    });

    $('#ms-fetch').addEventListener('click', function () {
      toast('正在拉取模型…');
      Native.fetchModels(s.providerId);
    });

    $('#ms-search').addEventListener('input', function (e) {
      var q = e.target.value.trim().toLowerCase();
      var items = $('#ms-list').querySelectorAll('.model-item');
      for (var i = 0; i < items.length; i++) {
        items[i].style.display = !q || items[i].dataset.mid.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
      }
    });

    $('#ms-list').addEventListener('click', function (e) {
      var item = e.target.closest('.model-item');
      if (!item) return;
      s.model = item.dataset.mid;
      var items = $('#ms-list').querySelectorAll('.model-item');
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('active', items[i].dataset.mid === s.model);
        var chk = items[i].querySelector('.check');
        if (items[i].dataset.mid === s.model && !chk) {
          var span = document.createElement('span');
          span.className = 'check';
          span.textContent = '✓';
          items[i].appendChild(span);
        } else if (items[i].dataset.mid !== s.model && chk) {
          chk.remove();
        }
      }
      var pp = provider(s.providerId);
      if (pp) { pp.defaultModel = s.model; Native.saveProviders(JSON.stringify(state.providers)); }
      persist(true);
      renderHeader();
      renderToolbar();
    });

    $('#sheet-body').querySelectorAll('.chip[data-pid]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        s.providerId = chip.dataset.pid;
        var np = provider(s.providerId);
        s.model = np && np.defaultModel ? np.defaultModel : (np && np.models && np.models.length ? np.models[0].id : '');
        persist(true);
        openChatSettings();
      });
    });

    $('#ms-temp').addEventListener('input', function (e) {
      s.temperature = Number(e.target.value);
      $('#ms-temp-v').textContent = s.temperature.toFixed(2);
      persist();
    });
    $('#ms-ctx').addEventListener('input', function (e) {
      s.contextLimit = Number(e.target.value);
      $('#ms-ctx-v').textContent = s.contextLimit ? s.contextLimit + ' 条' : '全部';
      persist();
    });
    $('#ms-max').addEventListener('input', function (e) {
      s.maxTokens = Number(e.target.value);
      $('#ms-max-v').textContent = s.maxTokens ? s.maxTokens : '默认';
      persist();
    });
    $('#ms-top').addEventListener('input', function (e) {
      s.topP = Number(e.target.value);
      $('#ms-top-v').textContent = s.topP < 0 ? '默认' : s.topP.toFixed(2);
      persist();
    });

    $('#ms-stream').addEventListener('click', function () {
      s.stream = s.stream === false;
      this.classList.toggle('on', s.stream !== false);
      persist();
    });

    $('#ms-web').addEventListener('click', function () {
      if (s.webSearch) {
        s.webSearch = false;
        this.classList.toggle('on', false);
        persist();
        renderToolbar();
        return;
      }
      if (!searchReady()) {
        toast('搜索引擎还没配好 Key，先去设置里填一下（或换成免 Key 引擎）');
        closeSheet();
        openSettings();
        return;
      }
      s.webSearch = true;
      this.classList.toggle('on', true);
      persist();
      renderToolbar();
    });

    $('#ms-browser').addEventListener('click', function () {
      var q = ($('#input') && $('#input').value ? $('#input').value : '').trim();
      if (!q && state.cur) {
        for (var i = state.cur.messages.length - 1; i >= 0; i--) {
          var mm = state.cur.messages[i];
          if (mm.role === 'user' && mm.content) { q = mm.content; break; }
        }
      }
      if (!q) { toast('先输入要搜索的内容'); return; }
      Native.openUrl(browserSearchUrl(q));
    });

    $('#ms-sticker').addEventListener('click', function () { toggleStickerAuto(this); });

    $('#ms-packs').addEventListener('click', function () {
      closeSheet();
      openStickerSheet();
    });
  }

  function stickerAutoDesc() {
    var names = stickerCategoryNames();
    if (!names.length) return '还没有表情图，点下面「管理表情包」导入';
    var parts = names.map(function (n) {
      var p = typeof state.meta.stickerProb[n] === 'number' ? state.meta.stickerProb[n] : 100;
      var folderHit = false;
      var cats = (state.stickers && state.stickers.categories) || [];
      for (var i = 0; i < cats.length; i++) if (cats[i].name === n) folderHit = true;
      if (!folderHit) {
        var pack = findPackByName(n);
        if (pack && typeof pack.prob === 'number') p = pack.prob;
      }
      return n + ' ' + p + '%';
    });
    return '模型情绪命中分类时按概率发图（' + parts.join('、') + '）';
  }

  var openModelSheet = openChatSettings;

  // ---------------------------------------------------------------- sticker packs

  function ensurePacks() {
    if (!state.meta.stickerPacks || !state.meta.stickerPacks.length) {
      var legacy = (state.meta.stickers || []).filter(Boolean);
      state.meta.stickerPacks = [{
        id: uid(),
        name: '默认',
        prob: 100,
        stickers: legacy
      }];
      delete state.meta.stickers;
    }
    state.meta.stickerPacks.forEach(function (p) {
      if (!p.id) p.id = uid();
      if (!p.name) p.name = '分类';
      if (typeof p.prob !== 'number') p.prob = 100;
      if (!Array.isArray(p.stickers)) p.stickers = [];
    });
    if (!packById(state.packId)) state.packId = state.meta.stickerPacks[0].id;
  }

  function packById(id) {
    var packs = state.meta.stickerPacks || [];
    for (var i = 0; i < packs.length; i++) if (packs[i].id === id) return packs[i];
    return null;
  }

  function findPackByName(name) {
    var packs = state.meta.stickerPacks || [];
    var n = String(name || '').trim();
    for (var i = 0; i < packs.length; i++) {
      if (packs[i].name === n) return packs[i];
    }
    return null;
  }

  function openStickerSheet() {
    var folderCats = state.stickers && state.stickers.categories ? state.stickers.categories : [];

    if (folderCats.length) {
      openFolderStickerSheet(folderCats);
      return;
    }

    ensurePacks();
    var packs = state.meta.stickerPacks;
    var pack = packById(state.packId) || packs[0];

    var chips = packs.map(function (p) {
      return '<button class="chip' + (p.id === pack.id ? ' active' : '') + '" data-pack="' + esc(p.id) + '">' +
        esc(p.name) + (p.stickers.length ? ' ' + p.stickers.length : '') + '</button>';
    }).join('') + '<button class="chip" data-addpack="1">＋ 分类</button>';

    var tiles = pack.stickers.map(function (d, i) {
      return '<div class="slot filled" data-slot="' + i + '"><img src="' + d + '">' +
        '<button class="clear" data-clear="' + i + '">×</button></div>';
    }).join('');
    if (pack.stickers.length < MAX_PACK_STICKERS) {
      tiles += '<div class="slot" data-addsticker="1">＋<div class="hint-mini">加图</div></div>';
    }

    openSheet(
      '<div class="row between"><div class="section-title" style="margin:0">表情包</div>' +
      '<button class="btn small" id="sk-done">完成</button></div>' +
      '<div class="card" style="margin:8px 0 10px;padding:10px">' +
      '<div class="row between"><div><div class="s-label">用文件夹导入（推荐）</div>' +
      '<div class="muted" style="margin-top:4px">在手机里建一个文件夹，每个子文件夹是一种情绪（开心/悲伤/傲娇…），把图片或 GIF 放进去，导入后复制进应用，删原文件也不影响。</div></div></div>' +
      '<button class="btn small primary block" id="sk-pickdir" style="margin-top:8px">导入表情文件夹</button>' +
      '</div>' +
      '<div class="switch-row" style="margin-top:4px"><div><div class="s-label">自动表情</div>' +
      '<div class="s-desc">打开后模型才能在对话里发图</div></div>' +
      '<div class="switch' + (state.cur && state.cur.stickerAuto ? ' on' : '') + '" id="sk-auto2"></div></div>' +
      '<div class="chip-row" style="margin:8px 0 4px">' + chips + '</div>' +
      '<div class="slider-row" style="margin-top:10px"><label>触发概率</label>' +
      '<input type="range" id="sk-prob" min="0" max="100" step="10" value="' + (pack.prob || 0) + '">' +
      '<div class="val" id="sk-prob-v">' + (pack.prob || 0) + '%</div></div>' +
      '<div class="hint" style="line-height:1.6;margin-bottom:4px">' +
      '模型觉得当前情绪命中「' + esc(pack.name) + '」时，有 ' + (pack.prob || 0) + '% 的概率从这一栏随机发一张。' +
      '点已保存的图会附加到输入框；点 ＋ 从相册加图。</div>' +
      '<div class="slot-grid">' + tiles + '</div>' +
      (packs.length > 1 ? '<button class="btn danger block" id="sk-delpack" style="margin-top:14px">删除「' + esc(pack.name) + '」分类</button>' : '')
    );

    $('#sk-pickdir').addEventListener('click', function () { Native.importStickers(); });
    $('#sk-done').addEventListener('click', closeSheet);
    var legacyAuto = $('#sk-auto2');
    if (legacyAuto) legacyAuto.addEventListener('click', function () { toggleStickerAuto(this); });

    $('#sk-prob').addEventListener('input', function (e) {
      pack.prob = Number(e.target.value);
      $('#sk-prob-v').textContent = pack.prob + '%';
      saveMeta();
    });

    Array.prototype.forEach.call($('#sheet-body').querySelectorAll('.chip[data-pack]'), function (el) {
      el.addEventListener('click', function () {
        state.packId = el.dataset.pack;
        openStickerSheet();
      });
    });

    var addPack = $('#sheet-body').querySelector('[data-addpack]');
    if (addPack) addPack.addEventListener('click', openPackForm);

    var delPack = $('#sk-delpack');
    if (delPack) {
      delPack.addEventListener('click', function () {
        state.meta.stickerPacks = packs.filter(function (p) { return p.id !== pack.id; });
        state.packId = state.meta.stickerPacks[0].id;
        saveMeta();
        openStickerSheet();
      });
    }

    Array.prototype.forEach.call($('#sheet-body').querySelectorAll('.slot'), function (el) {
      el.addEventListener('click', function (e) {
        if (el.dataset.addsticker) {
          Native.pickSmallImage(256, 'sticker:' + pack.id);
          return;
        }
        var idx = Number(el.dataset.slot);
        if (e.target.closest('.clear')) {
          pack.stickers.splice(idx, 1);
          saveMeta();
          openStickerSheet();
          return;
        }
        if (pack.stickers[idx]) {
          if (state.images.length >= MAX_IMAGES) { toast('最多 ' + MAX_IMAGES + ' 张图片'); return; }
          state.images.push(pack.stickers[idx]);
          renderAttachments();
          closeSheet();
          toast('已附加表情');
        }
      });
    });
  }

  /** 导入模式：每个子文件夹是一种情绪，概率可按分类单独调。 */
  function openFolderStickerSheet(cats) {
    var rows = cats.map(function (c) {
      var prob = typeof state.meta.stickerProb[c.name] === 'number' ? state.meta.stickerProb[c.name] : 100;
      return '<div class="switch-row" style="align-items:center;gap:8px;padding:9px 2px">' +
        '<div style="flex:1;min-width:0"><div class="s-label">' + esc(c.name) +
        '<span class="muted" style="margin-left:6px">' + c.count + ' 张</span></div></div>' +
        '<input type="range" class="sk-p" data-cat="' + esc(c.name) + '" min="0" max="100" step="10" value="' + prob + '" style="width:86px;accent-color:#4f8cff">' +
        '<div class="val sk-pv" data-cat="' + esc(c.name) + '" style="width:38px">' + prob + '%</div>' +
        '<button class="btn small" data-view="' + esc(c.name) + '" style="padding:4px 8px">管理</button>' +
        '<button class="btn small danger" data-delcat="' + esc(c.name) + '" style="padding:4px 8px">删除</button>' +
        '</div>';
    }).join('');

    openSheet(
      '<div class="row between"><div class="section-title" style="margin:0">表情包 · 分类</div>' +
      '<button class="btn small" id="sk-done">完成</button></div>' +
      '<div class="row wrap" style="gap:6px;margin:8px 0 4px">' +
      '<button class="btn small primary" id="sk-import">导入文件夹</button>' +
      '<button class="btn small" id="sk-refresh">刷新</button></div>' +
      '<div class="switch-row" style="margin-top:6px"><div><div class="s-label">自动表情</div>' +
      '<div class="s-desc">打开后模型才能在对话里发表情</div></div>' +
      '<div class="switch' + (state.cur && state.cur.stickerAuto ? ' on' : '') + '" id="sk-auto"></div></div>' +
      '<div class="slider-row" style="margin-top:4px"><label>主动表情</label>' +
      '<input type="range" id="sk-global" min="0" max="100" step="10" value="' + (typeof state.meta.stickerGlobal === 'number' ? state.meta.stickerGlobal : 0) + '">' +
      '<div class="val" id="sk-global-v">' + (typeof state.meta.stickerGlobal === 'number' ? state.meta.stickerGlobal : 0) + '%</div></div>' +
      '<div class="hint" style="margin-top:-2px">0 = 由模型决定；100 = 每轮都补一张「默认」分类的表情</div>' +
      '<div class="hint" style="line-height:1.6">选一个文件夹，里面每个子文件夹是一种情绪（开心/悲伤/傲娇…），图片和 GIF 会被<strong>复制进应用</strong>，之后删原文件也不影响。只有这里列出的分类，模型才可能发。</div>' +
      rows
    );

    $('#sk-done').addEventListener('click', closeSheet);
    $('#sk-auto').addEventListener('click', function () { toggleStickerAuto(this); });
    var skG = $('#sk-global');
    if (skG) {
      skG.addEventListener('input', function () {
        state.meta.stickerGlobal = Number(this.value);
        var v = $('#sk-global-v');
        if (v) v.textContent = this.value + '%';
        saveMeta();
      });
    }
    $('#sk-import').addEventListener('click', function () { Native.importStickers(); });
    $('#sk-refresh').addEventListener('click', function () {
      toast('正在刷新…');
      Native.rescanStickers();
    });

    Array.prototype.forEach.call($('#sheet-body').querySelectorAll('.sk-p'), function (el) {
      el.addEventListener('input', function () {
        var cat = el.dataset.cat;
        state.meta.stickerProb[cat] = Number(el.value);
        var v = $('#sheet-body').querySelector('.sk-pv[data-cat="' + cat + '"]');
        if (v) v.textContent = el.value + '%';
        saveMeta();
      });
    });

    Array.prototype.forEach.call($('#sheet-body').querySelectorAll('[data-view]'), function (el) {
      el.addEventListener('click', function () { openCategoryManage(el.dataset.view); });
    });

    Array.prototype.forEach.call($('#sheet-body').querySelectorAll('[data-delcat]'), function (el) {
      el.addEventListener('click', function () {
        var cat = el.dataset.delcat;
        Native.deleteStickerCategory(cat);
        toast('已删除分类「' + cat + '」');
      });
    });
  }

  /** 单张管理：看得到每一张，也能单独删。 */
  function openCategoryManage(cat) {
    var files = [];
    try { files = JSON.parse(Native.listStickerFiles(cat)); } catch (e) { files = []; }

    var tiles = files.map(function (f) {
      return '<div class="slot filled" style="position:relative">' +
        '<img src="' + f.url + '">' +
        '<button class="clear" data-delfile="' + esc(f.name) + '">×</button>' +
        '</div>';
    }).join('');

    openSheet(
      '<div class="row between"><div class="section-title" style="margin:0">' + esc(cat) +
      ' · ' + files.length + ' 张</div>' +
      '<button class="btn small" id="cm-back">返回</button></div>' +
      (files.length ? '<div class="slot-grid">' + tiles + '</div>' : '<div class="hint" style="padding:12px 2px">这个分类里还没有图片</div>') +
      '<button class="btn danger block" id="cm-delcat" style="margin-top:14px">删除整个分类</button>'
    );

    $('#cm-back').addEventListener('click', openStickerSheet);
    $('#cm-delcat').addEventListener('click', function () {
      Native.deleteStickerCategory(cat);
      toast('已删除分类「' + cat + '」');
      openStickerSheet();
    });

    Array.prototype.forEach.call($('#sheet-body').querySelectorAll('[data-delfile]'), function (el) {
      el.addEventListener('click', function () {
        Native.deleteSticker(cat, el.dataset.delfile);
        toast('已删除');
        setTimeout(function () { openCategoryManage(cat); }, 200);
      });
    });
  }

  function openPackForm() {
    openSheet(
      '<div class="section-title" style="margin-top:0">新建分类</div>' +
      '<div class="field"><input id="pk-name" placeholder="悲伤 / 开心 / 摸鱼…" maxlength="12"></div>' +
      '<button class="btn primary block" id="pk-ok">创建</button>'
    );
    $('#pk-ok').addEventListener('click', function () {
      var name = $('#pk-name').value.trim();
      if (!name) { toast('名字不能为空'); return; }
      if (findPackByName(name)) { toast('已经有同名分类了'); return; }
      var pack = { id: uid(), name: name, prob: 100, stickers: [] };
      state.meta.stickerPacks.push(pack);
      state.packId = pack.id;
      saveMeta();
      openStickerSheet();
    });
  }

  /** 把模型给的分类名匹配到实际存在的分类：精确 → 包含 → 共享字符 */
  function matchCategory(name, cats) {
    var norm = function (x) {
      return String(x || '').replace(/[\s"'"'「」『』（）()\[\]【】*`~～·、,，.。!！?？:：;；-]/g, '');
    };
    var want = norm(name);
    if (!want) return null;
    var best = null, bestScore = 0;
    for (var i = 0; i < cats.length; i++) {
      var have = norm(cats[i].name);
      if (!have) continue;
      var score = 0;
      if (have === want) score = 100;
      else if (have.indexOf(want) >= 0 || want.indexOf(have) >= 0) score = 60 + Math.min(20, Math.min(have.length, want.length));
      else {
        var shared = 0;
        for (var k = 0; k < want.length; k++) if (have.indexOf(want.charAt(k)) >= 0) shared++;
        if (shared > 0) score = 10 + shared * 5;
      }
      if (score > bestScore) { bestScore = score; best = cats[i]; }
    }
    // 阈值：至少共享一个字符，避免乱配
    return bestScore >= 15 ? best : null;
  }

  /** 全局概率兜底：模型没发表情时，按总开关概率补一张「默认」分类的图 */
  function maybeGlobalSticker(m) {
    var s = state.cur;
    if (!s || !m) return false;
    var g = typeof state.meta.stickerGlobal === 'number' ? state.meta.stickerGlobal : 0;
    if (g <= 0) return false;                                  // 未开启主动表情
    if (m.error) { dbg('sticker', '兜底跳过：本轮报错'); return false; }
    if (m.stickerSent || m.kind === 'sticker') { dbg('sticker', '兜底跳过：本轮已有表情'); return false; }
    if ((m.content || '').trim().length < 6) { dbg('sticker', '兜底跳过：回复太短'); return false; }
    if (Math.random() * 100 >= g) { dbg('sticker', '兜底跳过：概率未中(' + g + '%)'); return false; }

    var cats = (state.stickers && state.stickers.categories) || [];
    var defFolder = null;
    var list = [];
    for (var i = 0; i < cats.length; i++) {
      list.push(cats[i].name + '(' + cats[i].count + ')');
      if (cats[i].count > 0 && String(cats[i].name).trim() === '默认') defFolder = cats[i];
    }
    if (defFolder) {
      try { Native.pickSticker(defFolder.name); } catch (e) { return false; }
      m.stickerSent = true;
      dbg('sticker', '全局兜底：发「默认」');
      return true;
    }

    // 兼容旧的本地槽位分类
    ensurePacks();
    var defPack = findPackByName('默认');
    if (defPack && defPack.stickers && defPack.stickers.length) {
      s.messages.push({
        id: uid(), role: 'assistant', kind: 'sticker',
        sticker: defPack.stickers[Math.floor(Math.random() * defPack.stickers.length)],
        ts: now(), model: s.model
      });
      m.stickerSent = true;
      dbg('sticker', '全局兜底：发「默认」（本地槽位）');
      persist(true);
      return true;
    }

    dbg('sticker', '兜底跳过：没有「默认」分类，现有 ' + (list.length ? list.join('、') : '(空)'));
    return false;
  }
  /** 按分类发一张：文件夹模式走原生随机取图，旧槽位模式直接用 base64。 */
  function sendStickerByCategory(cat) {
    var s = state.cur;
    if (!s) return false;
    var raw = String(cat || '').trim();
    if (!raw) return false;

    var folderCats = (state.stickers && state.stickers.categories) || [];
    var hit = matchCategory(raw, folderCats);
    if (hit) {
      var name = hit.name;
      if (name !== raw) dbg('sticker', '分类「' + raw + '」匹配到「' + name + '」');
      var p = typeof state.meta.stickerProb[name] === 'number' ? state.meta.stickerProb[name] : 100;
      if (Math.random() * 100 >= p) return false;
      try { Native.pickSticker(name); } catch (e) { return false; }
      return true;
    }

    var pack = findPackByName(raw);
    if (pack && pack.stickers && pack.stickers.length) {
      var prob = typeof pack.prob === 'number' ? pack.prob : 100;
      if (Math.random() * 100 >= prob) return false;
      s.messages.push({
        id: uid(), role: 'assistant', kind: 'sticker',
        sticker: pack.stickers[Math.floor(Math.random() * pack.stickers.length)],
        ts: now(), model: s.model
      });
      persist(true);
      return true;
    }
    return false;
  }
  /** 朗读一条消息；再点一次停止。 */
  function toggleSpeak(m) {
    if (!m || !m.content) return;
    if (state.tts.speakingId === m.id) {
      try { Native.ttsStop(); } catch (e) { }
      state.tts.speakingId = '';
      renderMessages();
      return;
    }
    state.tts.speakingId = m.id;
    renderMessages();
    try {
      Native.ttsConfigure(JSON.stringify({
        voice: state.tts.voice || '', rate: state.tts.rate || 1.0, preferApi: !!state.tts.preferApi
      }));
      Native.ttsSpeak(plainForSpeech(m.content));
    } catch (e) {
      state.tts.speakingId = '';
      toast('朗读失败：' + (e && e.message ? e.message : '未知错误'));
    }
  }

  /** 去掉标记和代码块，只留能读的文字。 */
  function plainForSpeech(text) {
    var s = String(text || '');
    s = s.replace(/```[\s\S]*?```/g, ' 代码略 ');
    s = s.replace(/\[\[emo:[^\]]*\]\]/g, ' ');
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    s = s.replace(/\[([^\]]{1,40})\]\([^)]*\)/g, '$1');
    s = s.replace(/[`*_~|>#]/g, '');
    return s.trim();
  }
  /** 把 [[emo:分类]] 标记从展示文本里摘掉，顺便吃掉流式过程中没闭合的半截标记。 */
  var EMO_RE = /\[\[emo:([^\]]*)\]\]/g;

  function stripEmo(text) {
    if (!text) return text || '';
    var out = String(text).replace(EMO_RE, '');
    out = out.replace(/\[\[emo:[^\]]*$/, '');
    out = out.replace(/\n{3,}$/, '\n\n');
    return out.replace(/\s+$/, '');
  }

  function extractEmoCats(text) {
    var cats = [];
    if (!text) return cats;
    var m;
    EMO_RE.lastIndex = 0;
    while ((m = EMO_RE.exec(text))) {
      var name = m[1].trim();
      if (name) cats.push(name);
    }
    return cats;
  }

  /** 掷骰子决定要不要发，命中就插一条表情消息。 */
  function maybeSendSticker(m) {
    var s = state.cur;
    if (!s || !s.stickerAuto) return false;
    var cats = extractEmoCats(m.content || '');
    if (!cats.length) return false;
    m.content = stripEmo(m.content);

    var folderCats = (state.stickers && state.stickers.categories) || [];

    for (var i = 0; i < cats.length; i++) {
      var name = cats[i];
      var folderHit = null;
      for (var k = 0; k < folderCats.length; k++) {
        if (folderCats[k].name === name) { folderHit = folderCats[k]; break; }
      }

      // ① 文件夹模式：交给原生随机取一张真实文件（支持 GIF）
      if (folderHit) {
        var fp = typeof state.meta.stickerProb[name] === 'number' ? state.meta.stickerProb[name] : 100;
        if (Math.random() * 100 >= fp) return false;
        try { Native.pickSticker(name); } catch (e) { return false; }
        persist(true);
        return true;
      }

      // ② 兼容旧的本地槽位
      var pack = findPackByName(name);
      if (!pack || !pack.stickers.length) continue;
      var prob = typeof pack.prob === 'number' ? pack.prob : 100;
      if (Math.random() * 100 >= prob) return false;
      var img = pack.stickers[Math.floor(Math.random() * pack.stickers.length)];
      s.messages.push({
        id: uid(), role: 'assistant', kind: 'sticker', sticker: img, ts: now(),
        model: s.model
      });
      persist(true);
      return true;
    }
    return false;
  }

  function buildStickerInstruction() {
    var folderCats = (state.stickers && state.stickers.categories) || [];
    var names = [];
    for (var i = 0; i < folderCats.length; i++) {
      if (folderCats[i].count > 0) names.push(folderCats[i].name);
    }
    if (!names.length) {
      var packs = state.meta.stickerPacks || [];
      for (var j = 0; j < packs.length; j++) {
        if (packs[j].stickers && packs[j].stickers.length) names.push(packs[j].name);
      }
    }
    if (!names.length) return '';
    return '【表情包】你可以根据对话情绪发一张表情包，两种方式任选其一：\n' +
      'A. 直接调用 send_sticker 工具，参数 {"category":"分类"}；\n' +
      'B. 在回复最末尾另起一行写标记 [[emo:分类]]。\n' +
      '可选分类（只能用这些，写错不会发出）：' + names.join('、') + '\n' +
      '规则：\n' +
      '1) 只有情绪明显（开心、难过、无语、傲娇、惊讶…）时才发，不要每句都发；\n' +
      '2) 分类必须严格使用上面列表里的名字，区分大小写；\n' +
      '3) 一次回复最多一个标记，放在最后一行；\n' +
      '4) 标记本身不会展示给用户，不要解释它，也不要在正文里提到它；\n' +
      '5) 你不需要看到图片内容——按情绪选分类即可，客户端会随机挑一张该分类的图发出去。';
  }

  function openSessionMenu(id) {
    var meta = null;
    for (var i = 0; i < state.sessions.length; i++) if (state.sessions[i].id === id) meta = state.sessions[i];
    if (!meta) return;
    openSheet(
      '<div class="section-title" style="margin-top:0">' + esc(meta.title || '会话') + '</div>' +
      '<div class="card" style="padding:4px">' +
      '<button class="btn block ghost" id="sm-rename" style="text-align:left">重命名</button>' +
      '<button class="btn block ghost" id="sm-export" style="text-align:left">导出这个会话</button>' +
      '<button class="btn block ghost" id="sm-del" style="text-align:left;color:#ff9b9b">删除</button>' +
      '</div>'
    );
    $('#sm-rename').addEventListener('click', function () {
      var raw = Native.loadSession(id);
      if (!raw) return;
      var s = JSON.parse(raw);
      openSheet(
        '<div class="section-title" style="margin-top:0">重命名</div>' +
        '<div class="field"><input id="rn-input" value="' + esc(s.title || '') + '"></div>' +
        '<button class="btn primary block" id="rn-ok">保存</button>'
      );
      $('#rn-ok').addEventListener('click', function () {
        s.title = $('#rn-input').value.trim() || '新会话';
        s.updatedAt = now();
        Native.saveSession(JSON.stringify(s));
        if (state.cur && state.cur.id === s.id) { state.cur.title = s.title; renderHeader(); }
        refreshSessions();
        renderSessions();
        closeSheet();
      });
    });
    $('#sm-export').addEventListener('click', function () {
      var raw = Native.loadSession(id);
      if (!raw) return;
      var s = JSON.parse(raw);
      Native.exportFile((s.title || 'chat').replace(/[\\/:*?"<>|]/g, '_') + '.json', JSON.stringify(s, null, 1));
      closeSheet();
    });
    $('#sm-del').addEventListener('click', function () {
      closeSheet();
      deleteSession(id);
      toast('已删除');
    });
  }

  function exportAll() {
    var used = {};
    var sessions = [];
    state.sessions.forEach(function (meta) {
      var raw = Native.loadSession(meta.id);
      if (!raw || used[meta.id]) return;
      used[meta.id] = 1;
      try { sessions.push(JSON.parse(raw)); } catch (e) { }
    });
    if (state.cur && !used[state.cur.id]) sessions.push(state.cur);
    Native.exportFile('llm-chat-' + stamp() + '.json', JSON.stringify({
      app: 'llm-chat', version: 1, exportedAt: new Date().toISOString(), sessions: sessions
    }, null, 1));
  }

  function importSessions(text) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { toast('不是合法的 JSON 文件'); return; }
    var arr = [];
    if (Array.isArray(obj)) arr = obj;
    else if (obj && Array.isArray(obj.sessions)) arr = obj.sessions;
    else if (obj && obj.messages) arr = [obj];
    else { toast('文件里没有可导入的会话'); return; }

    var existing = {};
    state.sessions.forEach(function (s) { existing[s.id] = 1; });

    var n = 0;
    arr.forEach(function (s) {
      if (!s || !Array.isArray(s.messages)) return;
      if (!s.id || existing[s.id]) s.id = uid();
      existing[s.id] = 1;
      s.createdAt = s.createdAt || now();
      s.updatedAt = s.updatedAt || now();
      s.title = s.title || '导入的会话';
      Native.saveSession(JSON.stringify(s));
      n++;
    });

    refreshSessions();
    renderSessions();
    toast('已导入 ' + n + ' 个会话');
  }

  // ---------------------------------------------------------------- native callbacks

  var raf = 0;
  var pendingMsg = null;

  function scheduleNodeUpdate(m) {
    pendingMsg = m;
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      if (pendingMsg) updateMessageNode(pendingMsg);
      pendingMsg = null;
    });
  }

  /** Guards against JSON null leaking into the transcript as the literal text "null". */
  function chunkText(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (s === 'null') return '';
    return s;
  }
  /** 取某条回复之前最近一条用户消息，作为手动"搜一下"的查询词。 */
  function queryBefore(id) {
    var s = state.cur;
    if (!s) return '';
    var idx = -1;
    for (var i = 0; i < s.messages.length; i++) if (s.messages[i].id === id) idx = i;
    if (idx < 0) return '';
    for (var j = idx - 1; j >= 0; j--) {
      var m = s.messages[j];
      if (m.role === 'user' && m.content && m.content.trim()) {
        return m.content.replace(/\s+/g, ' ').trim().slice(0, 60);
      }
    }
    return '';
  }
  function findMessage(id) {
    var s = state.cur;
    if (!s) return null;
    for (var i = 0; i < s.messages.length; i++) if (s.messages[i].id === id) return s.messages[i];
    return null;
  }

  window.__bridge = {
    onChunk: function (raw) {
      var o = JSON.parse(raw);
      var m = findMessage(o.id);
      if (!m) return;
      var r = chunkText(o.r);
      var c = chunkText(o.c);
      if (r) m.reasoning = (m.reasoning || '') + r;
      if (c) m.content = (m.content || '') + c;
      scheduleNodeUpdate(m);
    },

    onDone: function (raw) {
      var o = JSON.parse(raw);
      var m = findMessage(o.id);
      if (state.streamingId === o.id) state.streamingId = null;
      if (m) {
        m.streaming = false;

        // ① 原生 tool_calls（搜索 / 发表情）
        if (!m.error && o.tools && o.tools.length) {
          var call = parseToolCall(o.tools);
          if (call && call.kind === 'search' && state.cur && state.cur.webSearch) {
            m.toolCalls = o.tools;
            if (runSearchStep(m, call.query, call.id)) return;
          }
          if (call && call.kind === 'sticker') {
            dbg('sticker-call', call.category);
            m.stickerRequested = true;
            if (sendStickerByCategory(call.category)) {
              m.stickerSent = true;
            }
          }
        }

        // 只调用工具、没有文字的回复是合法的：把空白的助手气泡去掉
        if (m.stickerRequested && !(m.content || '').trim() && !m.error) {
          var s0 = state.cur;
          if (s0) {
            var sent = !!m.stickerSent;
            s0.messages = s0.messages.filter(function (x) { return x.id !== m.id; });
            renderMessages();
            renderComposer();
            persist(true);
            dbg('done', { id: o.id, tools: (o.tools || []).length, len: 0, stickerOnly: true, sent: sent });
            if (!sent) toast('这次没发表情（概率未命中或分类为空）');
            return;
          }
        }

        // ② 提示词协议（端点不支持 tools 时走这条）
        if (!m.error) {
          var q = takeSearchQuery(m);
          if (q && state.cur && state.cur.webSearch) {
            if (runSearchStep(m, q, '')) return;
          }
        }

        if (!m.content && !m.error) m.error = '模型没有返回内容';

        if (o.usage) {
          var u = state.meta.usage || { p: 0, c: 0, rounds: 0 };
          u.p += (o.usage.p || 0);
          u.c += (o.usage.c || 0);
          u.rounds = (u.rounds || 0) + 1;
          state.meta.usage = u;
          m.usage = { p: o.usage.p || 0, c: o.usage.c || 0 };
          saveMeta();
          renderPet();
          if (state.meta.showQuota) {
            setPetBubble('本轮 ' + fmtTok(m.usage.p + m.usage.c) +
              '（入 ' + fmtTok(m.usage.p) + ' / 出 ' + fmtTok(m.usage.c) + '）', 3000);
          }
        }

        dbg('done', {
          id: o.id, tools: (o.tools || []).length, len: (m.content || '').length,
          err: m.error || '', web: !!m.web,
          tok: o.usage ? (o.usage.p + '+' + o.usage.c) : ''
        });

        if (!m.error && state.cur && state.cur.autoRead && (m.content || '').trim()) {
          state.tts.speakingId = m.id;
          try {
            Native.ttsConfigure(JSON.stringify({
              voice: state.tts.voice || '', rate: state.tts.rate || 1.0, preferApi: !!state.tts.preferApi
            }));
            Native.ttsSpeak(plainForSpeech(m.content));
          } catch (e) { state.tts.speakingId = ''; }
        }

        // 联网开着但整轮没搜：标记出来，方便判断是不是模型没调用
        var noSearch = !!(!m.error && m.webEnabled && !m.web && !(m.toolCalls && m.toolCalls.length));
        if (noSearch) m.noSearch = true;

        var stuck = false;
        if (!m.error) {
          stuck = maybeSendSticker(m);
          if (stuck) m.stickerSent = true;
          if (!stuck) stuck = maybeGlobalSticker(m);
        }
        if (stuck || noSearch) renderMessages(); else updateMessageNode(m);
      }
      renderComposer();
      persist(true);
      renderSessions();
    },

    onError: function (raw) {
      var o = JSON.parse(raw);
      var m = o.id ? findMessage(o.id) : null;
      if (state.streamingId === o.id) state.streamingId = null;
      if (m) {
        m.streaming = false;
        m.error = o.msg || '请求失败';
        updateMessageNode(m);
      } else {
        toast(o.msg || '请求失败');
      }
      renderComposer();
      persist(true);
    },

    onModels: function (raw) {
      var o = JSON.parse(raw);
      var p = provider(o.providerId);
      if (!p) return;
      if (!o.ok) { toast('拉取失败：' + (o.error || '未知错误')); return; }
      p.models = o.models || [];
      if (!p.defaultModel && p.models.length) p.defaultModel = p.models[0].id;
      if (state.cur && !state.cur.model && p.models.length) {
        state.cur.model = p.defaultModel;
        renderHeader();
      }
      if (state.cur && !state.cur.providerId) state.cur.providerId = p.id;
      Native.saveProviders(JSON.stringify(state.providers));
      toast('已获取 ' + p.models.length + ' 个模型');
      if (state.open.sheet) {
        var hadSearch = $('#ms-search') ? $('#ms-search').value : '';
        openModelSheet();
        if (hadSearch && $('#ms-search')) $('#ms-search').value = hadSearch;
      }
      if (state.open.settings) renderSettings();
    },

    onImage: function (raw) {
      var o = JSON.parse(raw);
      if (state.images.length >= MAX_IMAGES) { toast('最多 ' + MAX_IMAGES + ' 张图片'); return; }
      state.images.push(o.dataUrl);
      renderAttachments();
    },

    onBackground: function (raw) {
      var o = JSON.parse(raw);
      if (!o.dataUrl) return;
      state.meta.chatBackground.image = o.dataUrl;
      state.meta.chatBackground.preset = 'none';
      saveMeta();
      applyBackground();
      if (state.open.settings) renderSettings();
      toast('背景已更新');
    },
    onImported: function (raw) {
      var o = JSON.parse(raw);
      importSessions(o.text);
    },

    onSmallImage: function (raw) {
      var o = JSON.parse(raw);
      var tag = String(o.tag || '');
      if (tag.indexOf('avatar:') === 0) {
        var role = tag.slice(7);
        if (role !== 'user' && role !== 'assistant') return;
        state.meta.avatars[role] = o.dataUrl;
        saveMeta();
        if (state.open.settings) renderSettings();
        renderMessages();
        toast('头像已更新');
      } else if (tag.indexOf('sticker:') === 0) {
        var pack = packById(tag.slice(8));
        if (!pack) return;
        if (pack.stickers.length >= MAX_PACK_STICKERS) { toast('这一栏最多 ' + MAX_PACK_STICKERS + ' 张'); return; }
        pack.stickers.push(o.dataUrl);
        saveMeta();
        if (state.open.sheet) openStickerSheet();
        toast('已加入「' + pack.name + '」');
      }
    },

    onSearch: function (raw) {
      var o = JSON.parse(raw);

      dbg('search-done', {
        ok: !!o.ok, engine: o.engine || '', len: (o.text || '').length, err: o.error || ''
      });

      // ① 模型主动调用搜索后的回填
      if (state.toolPending) {
        var ctx = state.toolPending;
        state.toolPending = null;
        var s = state.cur;
        if (!s) return;
        var tool = findMessage(ctx.toolId);
        if (tool) {
          tool.pending = false;
          tool.engine = o.engine || '';
          if (o.ok && o.text) {
            tool.content = o.text;
          } else {
            tool.error = o.ok ? '没有搜到结果' : (o.error || '搜索失败');
            tool.content = '';
          }
        }
        if (!o.ok) toast('搜索失败：' + (o.error || '未知错误'));
        else if (!o.text) toast('没有搜到结果');
        else if (o.engine && o.engine !== currentEngine()) {
          toast('已用 ' + (ENGINE_NAMES[o.engine] || o.engine) + ' 搜到结果');
        }
        persist(true);
        continueAfterSearch();
      }
    },

    onStickerState: function (raw) {
      var o = JSON.parse(raw);
      state.stickers = { tree: !!o.tree, categories: o.categories || [] };
      dbg('stickers', (state.stickers.categories.length) + ' 个分类' + (o.error ? ' / ' + o.error : ''));
      if (o.error) toast('表情文件夹读取失败：' + o.error);
      if (state.open.sheet) openStickerSheet();
      else if (state.open.settings) renderSettings();
    },

    onBalance: function (raw) {
      var o = JSON.parse(raw);
      state.balance = o;
      dbg('balance', o.ok ? (o.source + ' ' + o.currency + ' ' + o.balance) : ('失败 ' + (o.error || '')));
      if (!o.ok) toast(o.error || '这个服务商查不到余额');
      renderPet();
      if (state.meta.showQuota) {
        if (o.ok) {
          var cur = o.currency === 'USD' ? '$' : '¥';
          setPetBubble('余额 ' + cur + Number(o.balance).toFixed(2), 6000);
        } else {
          var msg = state.meta.usage && (state.meta.usage.p + state.meta.usage.c) > 0
            ? ('累计 ' + fmtTok(state.meta.usage.p + state.meta.usage.c))
            : '查不到余额';
          setPetBubble(msg, 3000);
        }
      }
    },

    onTts: function (raw) {
      var o = JSON.parse(raw);
      dbg('tts', o.state + (o.detail ? ':' + o.detail : ''));
      if (o.state === 'warn') { toast(o.detail || '朗读警告'); }
      if (o.state === 'api-fallback') { dbg('tts', 'API 不可用，改用系统 TTS'); }
      if (o.state === 'done' || o.state === 'stop' || o.state === 'error') {
        state.tts.speakingId = '';
        renderMessages();
        if (o.state === 'error') toast('朗读失败：' + (o.detail || ''));
      }
    },
    onSticker: function (raw) {
      var o = JSON.parse(raw);
      if (!o.ok) { toast('表情发送失败：' + (o.error || '未知错误')); return; }
      var s = state.cur;
      if (!s) return;
      s.messages.push({
        id: uid(), role: 'assistant', kind: 'sticker', sticker: o.url,
        stickerCategory: o.category || '', ts: now(), model: s.model
      });
      renderMessages();
      persist(true);
    },
    onDebug: function (raw) {
      var o = JSON.parse(raw);
      dbg(o.tag || 'native', o.msg || '');
    },

    onToast: function (raw) {
      var o = JSON.parse(raw);
      toast(o.msg || '');
    },

    onProviders: function (raw) {
      var o = JSON.parse(raw);
      state.providers = o.providers || [];
      if (state.cur && state.cur.providerId && !provider(state.cur.providerId)) {
        state.cur.providerId = '';
        state.cur.model = '';
      }
      if (state.cur) resolveProvider(state.cur);
      if (state.open.settings) renderSettings();
      renderHeader();
    },

    onBack: function () {
      closeTop();
    }
  };

  // ---------------------------------------------------------------- init

  function bind() {
    $('#btn-menu').addEventListener('click', openDrawer);
    $('#btn-new').addEventListener('click', newSession);
    $('#btn-drawer-new').addEventListener('click', newSession);
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-settings-back').addEventListener('click', closeSettings);
    $('#scrim').addEventListener('click', function () {
      if (state.open.sheet) closeSheet();
      else closeDrawer();
    });

    $('#btn-send').addEventListener('click', function () {
      if (state.streamingId) stopStream(); else send();
    });

    $('#btn-img').addEventListener('click', function () { Native.pickImage(); });
    $('#btn-sticker').addEventListener('click', openStickerSheet);
    $('#btn-params').addEventListener('click', openChatSettings);
    $('#btn-model').addEventListener('click', openChatSettings);
    $('#title-wrap').addEventListener('click', openChatSettings);

    $('#btn-web').addEventListener('click', function () {
      var s = state.cur;
      if (!s) return;
      if (s.webSearch) {
        s.webSearch = false;
        persist(true);
        renderToolbar();
        toast('已关闭联网搜索');
        return;
      }
      if (!searchReady()) {
        toast('搜索引擎还没配好 Key，先去设置里填一下（或换成免 Key 引擎）');
        openSettings();
        return;
      }
      s.webSearch = true;
      persist(true);
      renderToolbar();
      toast('已开启联网搜索');
    });

    var input = $('#input');
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', function (e) {
      // 手机键盘的回车一律换行；需要快捷发送用 Ctrl/Cmd + Enter
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send();
      }
    });

    $('#attach-row').addEventListener('click', function (e) {
      var btn = e.target.closest('.rm');
      if (!btn) return;
      state.images.splice(Number(btn.dataset.idx), 1);
      renderAttachments();
    });

    $('#session-list').addEventListener('click', function (e) {
      var more = e.target.closest('[data-more]');
      var item = e.target.closest('.s-item');
      if (!item) return;
      if (more) { openSessionMenu(item.dataset.id); return; }
      openSession(item.dataset.id);
    });

    $('#btn-export-all').addEventListener('click', exportAll);
    $('#btn-import').addEventListener('click', function () { Native.importFile(); });

    function settingsActHandler(e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.dataset.act;

      if (act === 'preset') { openProviderForm(null, btn.dataset.k); return; }
      if (act === 'add') { openProviderForm(null, 'custom'); return; }
      if (act === 'edit') { openProviderForm(provider(btn.dataset.pid), null); return; }
      if (act === 'models') { toast('正在拉取模型…'); Native.fetchModels(btn.dataset.pid); return; }
      if (act === 'del') {
        var p = provider(btn.dataset.pid);
        if (!p) return;
        openSheet('<div class="section-title" style="margin-top:0">删除服务商</div>' +
          '<div class="hint">将删除「' + esc(p.name) + '」及其已保存的 Key，会话内容不受影响。</div>' +
          '<div class="row" style="gap:8px;margin-top:16px">' +
          '<button class="btn" style="flex:1" id="del-cancel">取消</button>' +
          '<button class="btn danger" style="flex:1" id="del-ok">删除</button></div>');
        $('#del-cancel').addEventListener('click', closeSheet);
        $('#del-ok').addEventListener('click', function () {
          state.providers = state.providers.filter(function (x) { return x.id !== p.id; });
          if (state.activeProviderId === p.id) state.activeProviderId = state.providers.length ? state.providers[0].id : '';
          Native.saveProviders(JSON.stringify(state.providers));
          Native.setActiveProvider(state.activeProviderId);
          if (state.cur && state.cur.providerId === p.id) {
            state.cur.providerId = state.activeProviderId;
            state.cur.model = '';
            renderHeader();
          }
          closeSheet();
          renderSettings();
          toast('已删除');
        });
        return;
      }
      if (act === 'exportAll') { exportAll(); return; }
      if (act === 'importAll') { Native.importFile(); return; }
      if (act === 'avatar') {
        Native.pickSmallImage(192, 'avatar:' + btn.dataset.role);
        return;
      }
      if (act === 'avatar-reset') {
        state.meta.avatars[btn.dataset.role] = '';
        saveMeta();
        refreshSection();
        renderMessages();
        return;
      }
      if (act === 'engine') {
        state.meta.search.engine = btn.dataset.engine;
        saveMeta();
        renderSettings();
        return;
      }
      if (act === 'bubble') {
        var role = btn.dataset.role;
        state.meta.bubble = state.meta.bubble || { user: 'classic', assistant: 'cream' };
        state.meta.bubble[role] = btn.dataset.style;
        saveMeta();
        applyBubbles();
        refreshSection();
        renderMessages();
        return;
      }      if (act === 'sticker-manage') { closeSettings(); openStickerSheet(); return; }
      if (act === 'sticker-import') { Native.importStickers(); return; }
      if (act === 'tts-settings') { Native.openTtsSettings(); return; }
      if (act === 'bg-preset') {
        state.meta.chatBackground.preset = btn.dataset.key;
        state.meta.chatBackground.image = '';
        saveMeta();
        applyBackground();
        refreshSection();
        return;
      }
      if (act === 'bg-image') { Native.pickBackground(); return; }
      if (act === 'reset-appearance') {
        openSheet(
          '<div style="text-align:center;padding:6px 0 2px">' +
          '<img src="face-cry.webp" alt="" style="width:78px;height:108px;object-fit:contain;filter:drop-shadow(0 6px 14px rgba(0,0,0,.45))">' +
          '<div class="section-title" style="margin:10px 0 6px;justify-content:center">真的要重置吗？</div>' +
          '<div class="muted" style="line-height:1.6">头像、气泡样式、气泡透明度、背景、特效密度<br>都会恢复成默认值，聊天记录不受影响。</div>' +
          '</div>' +
          '<div class="row" style="gap:8px;margin-top:16px">' +
          '<button class="btn" style="flex:1" id="rst-cancel">再想想</button>' +
          '<button class="btn danger" style="flex:1" id="rst-ok">重置</button></div>');
        $('#rst-cancel').addEventListener('click', closeSheet);
        $('#rst-ok').addEventListener('click', function () {
          state.meta.avatars = { user: '', assistant: '' };
          state.meta.bubble = { user: 'classic', assistant: 'cream' };
          state.meta.bubbleAlpha = 1;
          state.meta.chatBackground = { preset: 'none', image: '', dim: 0.45 };
          state.meta.particleDensity = 0.6;
          saveMeta();
          applyBubbles();
          applyBackground();
          closeSheet();
          refreshSection();
          renderMessages();
          renderHeader();
          toast('外观已恢复默认');
        });
        return;
      }
      if (act === 'fetch-balance') {
        toast('正在查询余额…');
        Native.fetchBalance((state.cur && state.cur.providerId) || '');
        return;
      }
      if (act === 'copy-diag') {
        Native.copy(DEBUG.join('\n') || '（还没有记录）');
        toast('已复制日志');
        return;
      }
      if (act === 'bg-clear') {
        state.meta.chatBackground.image = '';
        state.meta.chatBackground.preset = 'none';
        saveMeta();
        applyBackground();
        refreshSection();
        return;
      }      if (act === 'save-search') {
        var sk = $('#sk-key').value.trim();
        if (!sk) { toast('请输入搜索 API Key'); return; }
        Native.saveSearchKey(sk);
        state.hasSearchKey = true;
        toast('已保存搜索 Key');
        renderSettings();
        return;
      }
    }

    $('#settings-body').addEventListener('click', settingsActHandler);
    // 分区面板里的按钮也走同一套逻辑（节点被搬进 sheet 后，事件不再冒泡到 settings-body）
    $('#sheet-body').addEventListener('click', function (e) {
      if (!state.sheetSection) return;
      settingsActHandler(e);
    });

    $('#messages').addEventListener('click', function (e) {
      var copyBtn = e.target.closest('.copy-code');
      if (copyBtn) {
        try { Native.copy(decodeURIComponent(copyBtn.dataset.code)); } catch (err) { }
        return;
      }
      var act = e.target.closest('.mini-btn');
      if (!act) return;
      var node = e.target.closest('.msg');
      if (!node) return;
      var id = node.dataset.id;
      if (act.dataset.act === 'copy') {
        var m = findMessage(id);
        if (m) Native.copy(m.content || '');
      } else if (act.dataset.act === 'retry') {
        regenerate(id);
      } else if (act.dataset.act === 'speak') {
        var sm = findMessage(id);
        if (sm) toggleSpeak(sm);
      } else if (act.dataset.act === 'forceSearch') {
        var target = findMessage(id);
        var q = queryBefore(id);
        if (!target || !q) { toast('找不到可搜索的问题'); return; }
        if (!runSearchStep(target, q, '')) toast('这一轮已经搜过了');
      }
    });

    window.addEventListener('resize', function () { scrollBottom(false); });
  }

  function init() {
    window.addEventListener('error', function (e) {
      try { Native.toast('脚本错误: ' + (e && e.message ? e.message : 'unknown')); } catch (err) { }
    });

    var boot = { providers: [], sessions: [], activeProviderId: '' };
    try { boot = JSON.parse(Native.boot()); } catch (e) { }

    state.providers = boot.providers || [];
    state.sessions = boot.sessions || [];
    state.activeProviderId = boot.activeProviderId || (state.providers[0] ? state.providers[0].id : '');

    try {
      var meta = JSON.parse(Native.loadMeta());
      if (meta && typeof meta === 'object') {
        if (meta.avatars && typeof meta.avatars === 'object') {
          state.meta.avatars.user = meta.avatars.user || '';
          state.meta.avatars.assistant = meta.avatars.assistant || '';
        }
        if (Object.prototype.toString.call(meta.stickerPacks) === '[object Array]') {
          state.meta.stickerPacks = meta.stickerPacks;
        }
        if (Object.prototype.toString.call(meta.stickers) === '[object Array]') {
          state.meta.stickers = meta.stickers; // 旧版本数据，ensurePacks 会迁移
        }
        if (meta.search && meta.search.engine) state.meta.search.engine = meta.search.engine;
        if (meta.chatBackground && typeof meta.chatBackground === 'object') {
          state.meta.chatBackground.preset = meta.chatBackground.preset || 'none';
          state.meta.chatBackground.image = meta.chatBackground.image || '';
          if (typeof meta.chatBackground.dim === 'number') state.meta.chatBackground.dim = meta.chatBackground.dim;
        }
        if (meta.packId) state.packId = meta.packId;
        state.hasSearchKey = !!meta.hasSearchKey;

        // 这几项以前没被读回来，导致重启后设置重置
        if (meta.bubble && typeof meta.bubble === 'object') state.meta.bubble = meta.bubble;
        if (meta.stickerProb && typeof meta.stickerProb === 'object') state.meta.stickerProb = meta.stickerProb;
        if (typeof meta.bubbleAlpha === 'number') state.meta.bubbleAlpha = meta.bubbleAlpha;
        if (typeof meta.stickerGlobal === 'number') state.meta.stickerGlobal = meta.stickerGlobal;
        if (typeof meta.particleDensity === 'number') state.meta.particleDensity = meta.particleDensity;
        if (typeof meta.showQuota === 'boolean') state.meta.showQuota = meta.showQuota;
        if (meta.petPos && typeof meta.petPos === 'object') state.meta.petPos = meta.petPos;
        if (meta.usage && typeof meta.usage === 'object') state.meta.usage = meta.usage;
        if (meta.tts && typeof meta.tts === 'object') state.meta.tts = meta.tts;
      }
    } catch (e) { }
    ensurePacks();

    var s = null;
    var last = lsGet(K_LAST);
    var tryIds = [];
    if (last) tryIds.push(last);
    state.sessions.forEach(function (m) { tryIds.push(m.id); });

    for (var i = 0; i < tryIds.length && !s; i++) {
      var raw = '';
      try { raw = Native.loadSession(tryIds[i]); } catch (e) { raw = ''; }
      if (!raw) continue;
      try {
        var parsed = JSON.parse(raw);
        parsed.messages = (parsed.messages || []).map(function (m) { m.streaming = false; return m; });
        if (parsed.temperature == null) parsed.temperature = 0.7;

        if (parsed.maxTokens == null) parsed.maxTokens = 0;

        if (parsed.topP == null) parsed.topP = -1;

        if (parsed.contextLimit == null) parsed.contextLimit = 0;

        if (parsed.stream == null) parsed.stream = true;

        if (parsed.webSearch == null) parsed.webSearch = false;
        if (parsed.stickerAuto == null) parsed.stickerAuto = false;
        s = parsed;
      } catch (e) { }
    }

    if (!s) {
      s = blankSession();
      state.sessions.unshift({ id: s.id, title: s.title, updatedAt: s.updatedAt, model: s.model, providerId: s.providerId, count: 0 });
      Native.saveSession(JSON.stringify(s));
    }

    state.cur = s;
    lsSet(K_LAST, s.id);
    resolveProvider(s);

    try {
      var ti = JSON.parse(Native.ttsStatus());
      state.tts.cloneTts = !!ti.cloneTts;
      state.tts.engines = ti.engines || [];
      state.tts.engineCount = typeof ti.engineCount === 'number' ? ti.engineCount : (ti.engines || []).length;
      if (state.meta.tts) {
        state.tts.voice = state.meta.tts.voice || '';
        state.tts.rate = state.meta.tts.rate || 1;
        state.tts.preferApi = state.meta.tts.preferApi !== false;
      }
      Native.ttsConfigure(JSON.stringify({ voice: state.tts.voice, rate: state.tts.rate, preferApi: state.tts.preferApi }));
      dbg('tts', 'cloneTts=' + state.tts.cloneTts + ' engines=' + state.tts.engines.length);
    } catch (e) { }

    try {
      var st = JSON.parse(Native.stickerInfo());
      state.stickers = { tree: !!st.tree, categories: st.categories || [] };
    } catch (e) { }

    applyBubbles();
    bind();
    renderPet();
    applyBackground();
    renderAll();

    dbg('viewport', {
      w: window.innerWidth, h: window.innerHeight,
      scrollW: document.documentElement.scrollWidth,
      dpr: window.devicePixelRatio || 1
    });

    if (!state.providers.length) openSettings();
  }

  window.addEventListener('resize', function () {
    try {
      if (state.meta && state.meta.petPos) {
        state.meta.petPos = clampPet(state.meta.petPos.x, state.meta.petPos.y);
        renderPet();
      }
    } catch (e) { }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
