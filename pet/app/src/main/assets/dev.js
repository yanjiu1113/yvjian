/* 情趣版 · 界面
 *
 * 主界面：狐狸（下）/ 总控按钮（狐狸上方）/ ⚡（右上）/ 🎮（⚡下方）
 * ⚡ → 品牌选择（DG-LAB / 役次元）→ 品牌内产品 → 设备页
 * 总控按钮 → 总控台（输出状态 + 模式 + 目标 + 急停 + 日志 + AI）
 */
(function () {
  'use strict';

  var st = {
    mode: 'easy', sched: null,
    target: 20, applied: 0, running: false,
    mTarget: 'all',   // 渐强只驱动这台：all / cy / cup / ems
    scale: 0.5, limit: 20,   // scale = 安全标准（实际强度 = 面板等级 × scale）
    fireP: 1.0,   // 触发概率：1 = 每轮都动手（不掷骰子）
    cyMax: 40, cyHoldMin: 4000, cyHoldMax: 60000,
    ycHoldMin: 4000, ycHoldMax: 60000,
    frA: 60, frB: 60, inA: 20, inB: 20, frMin: 30, frMax: 200,

    cyOn: false, cyName: '', cyAddr: '', cyBattery: -1, cyFirmware: '',
    cyA: 0, cyB: 0, cyApl: 0, cyBpl: 0, cyDevices: [],

    cupOn: false, cupAddr: '', cupName: '', cupBattery: -1,
    cupModes: { a: 0, b: 0, c: 0 }, cupSpeed: { a: 0, b: 0, c: 0 },
    cupDevices: [],

    emsOn: false, emsAddr: '', emsName: '', emsBattery: -1, emsCh: 0,
    emsServices: '', emsLastNotify: '', emsWriteOk: 0, emsWriteFail: 0,
    emsStrength: 0, emsMode: 1, emsFreq: 50, emsPulse: 50,
    emsLink: -1, emsChStrength: 0,
    emsDevices: [],

    aiCfg: { url: '', key: '', model: '' },
    tabs: [],
    slots: [],   // 已添加的设备槽位（同类型可以有多台）
    scanning: 'cup',
    linkCount: 0, linkAt: 0,
    aiCmds: []
  };

  var logs = [], rampTimer = null, listTimer = {};
  var current = 'brand';

  /* 当前正在渲染的槽位根节点：设置后 $() 只在这个槽位里查，避免重复 id 串台 */
  var CUR_ROOT = null;

  /** 在指定根节点内查元素（没写 # 时自动补上） */
  function q(root) {
    return function (sel) {
      if (!root || !sel) return null;
      var s = String(sel), c = s.charAt(0);
      return root.querySelector(c === '#' || c === '.' || c === '[' ? s : '#' + s);
    };
  }

  function withRoot(root, fn) {
    var old = CUR_ROOT;
    CUR_ROOT = root || null;
    try { return fn(); } finally { CUR_ROOT = old; }
  }

  /** 模块级取元素：在 withRoot() 内只查当前槽位（不跨槽回退），否则查整页 */
  function $(sel) {
    if (!sel) return null;
    var s = String(sel), c = s.charAt(0);
    if (CUR_ROOT) return CUR_ROOT.querySelector(c === '#' || c === '.' || c === '[' ? s : '#' + s);
    if (c === '#') return document.querySelector(s);
    return document.getElementById(s);
  }

  /* ================= 同类型多设备：槽位模型 ================= */

  var MAX_PER_KIND = 4;
  var TITLES_BASE = { cy: '郊狼', cup: '榨精杯', ems: '电击器' };

  /* 安全标准/渐强参数仍然全局共用：槽位上的这些键读写都转给 st，和 0.103 完全一致 */
  var GLOBAL_KEYS = ['limit', 'scale', 'fireP', 'cyMax', 'frMin', 'frMax',
    'cyHoldMin', 'cyHoldMax', 'ycHoldMin', 'ycHoldMax'];

  /** 一台设备自己的状态：设备字段各一份，安全设置共用全局 */
  function newDeviceState(kind) {
    var d = Object.create(st);
    d.frA = st.frA; d.frB = st.frB; d.inA = st.inA; d.inB = st.inB;
    d.cyOn = false; d.cyName = ''; d.cyAddr = ''; d.cyBattery = -1; d.cyFirmware = '';
    d.cyA = 0; d.cyB = 0; d.cyApl = 0; d.cyBpl = 0;
    d.cupOn = false; d.cupAddr = ''; d.cupName = ''; d.cupBattery = -1;
    d.cupModes = { a: 0, b: 0, c: 0 }; d.cupSpeed = { a: 0, b: 0, c: 0 };
    d.emsOn = false; d.emsAddr = ''; d.emsName = ''; d.emsBattery = -1; d.emsCh = 0;
    d.emsServices = ''; d.emsLastNotify = ''; d.emsWriteOk = 0; d.emsWriteFail = 0;
    d.emsStrength = 0; d.emsMode = 1; d.emsFreq = 50; d.emsPulse = 50;
    d.emsLink = -1; d.emsChStrength = 0;
    GLOBAL_KEYS.forEach(function (k) {
      Object.defineProperty(d, k, {
        get: function () { return st[k]; },
        set: function (v) { st[k] = v; },
        configurable: true, enumerable: true
      });
    });
    return d;
  }

  /* 原生方法名：调用时自动把 slot.index 插到参数最前面 */
  var DEV_API = ['deviceState', 'autoFind', 'scan', 'stopScan', 'connect', 'disconnect',
    'setDebug', 'setPulse', 'testFrame', 'selfCheck', 'setLimit', 'setStrength',
    'setStrengthTimed', 'stopStrenght', 'emergencyStop',
    'ycyScan', 'ycyScanAll', 'ycyStopScan', 'ycyConnect', 'ycyDisconnect', 'ycyQuery',
    'ycyDevType', 'ycyMode', 'ycySpeed', 'ycySpeedTimed', 'ycyStop',
    'ycyEmsFixed', 'ycyEmsReal', 'ycyEmsFixedTimed',
    'emsZeroB', 'emsBFollow', 'emsBurstB', 'emsChanTest', 'emsChanStop', 'emsChannel',
    'emsDual', 'emsRaw', 'emsScan', 'emsStopScan', 'emsConnect', 'emsDisconnect',
    'emsWaveUnlock', 'emsWave', 'emsStop'];

  function apiFor(slot) {
    var api = {};
    DEV_API.forEach(function (name) {
      api[name] = function () {
        var C = window.Coyote;
        if (!C || typeof C[name] !== 'function') return undefined;
        var args = [slot.index].concat([].slice.call(arguments));
        try { return C[name].apply(C, args); } catch (e) { addLog('[' + name + ' 调用失败] ' + e); }
      };
    });
    return api;
  }

  /** 只发急停帧，不动面板数值 */
  function stopHardware() {
    st.slots.forEach(function (s) {
      try { hardStop(s); } catch (e) { }
    });
  }

  /** 按类型急停一台：郊狼 / 榨精杯 / 电击器各走各的原生实例 */
  function hardStop(s) {
    if (!s) return;
    if (s.kind === 'cy') s.api.emergencyStop();
    else if (s.kind === 'cup') s.api.ycyStop();
    else s.api.emsStop();
  }

  function slotById(id) {
    for (var i = 0; i < st.slots.length; i++) if (st.slots[i].id === id) return st.slots[i];
    return null;
  }

  function slotByIndex(kind, idx) {
    if (typeof idx !== 'number' || idx < 0) return null;
    for (var i = 0; i < st.slots.length; i++) {
      var s = st.slots[i];
      if (s.kind === kind && s.index === idx) return s;
    }
    return null;
  }

  function slotsOf(kind) {
    return st.slots.filter(function (s) { return s.kind === kind; });
  }

  function slotsOn(kind) {
    return st.slots.filter(function (s) { return s.kind === kind && s.d[s.kind + 'On']; });
  }

  function anyOn(kind) { return slotsOn(kind).length > 0; }

  function tabTitle(id) {
    var s = slotById(id);
    return s ? s.title : (TITLES[id] || id);
  }

  function macKey(slot) { return slot.kind + 'Mac' + (slot.index > 0 ? '-' + slot.index : ''); }

  /** 加一台设备：同类复用最小空闲编号，标签自动编号（郊狼 1 / 郊狼 2） */
  function addSlot(kind) {
    if (!TITLES_BASE[kind]) return null;
    var idx = -1;
    for (var i = 0; i < MAX_PER_KIND; i++) { if (!slotByIndex(kind, i)) { idx = i; break; } }
    if (idx < 0) { addLog('同一类设备最多 ' + MAX_PER_KIND + ' 台'); return null; }
    var panel = $('devpanel');
    if (!panel) return null;

    var root = document.createElement('div');
    root.className = 'dev-view';
    root.id = 'view-' + kind + '-' + idx;
    root.setAttribute('data-slot', kind + '-' + idx);
    root.style.display = 'none';
    panel.appendChild(root);

    var slot = {
      id: kind + '-' + idx, kind: kind, index: idx,
      root: root, devices: [], d: newDeviceState(kind)
    };
    /* 同类只有一台时用旧名字（0.103 的「郊狼」），加了第二台才变成「郊狼 1」「郊狼 2」 */
    Object.defineProperty(slot, 'title', {
      get: function () {
        var same = st.slots.filter(function (x) { return x.kind === slot.kind; });
        return same.length > 1 ? TITLES_BASE[slot.kind] + ' ' + (slot.index + 1) : TITLES_BASE[slot.kind];
      },
      configurable: true, enumerable: true
    });
    slot.api = apiFor(slot);
    st.slots.push(slot);
    buildDeviceView(slot);
    if (st.tabs.indexOf(slot.id) < 0) st.tabs.push(slot.id);
    setPanel(true);
    show(slot.id);
    addLog('已添加「' + slot.title + '」');
    return slot;
  }

  function buildDeviceView(slot) {
    if (slot.kind === 'cy') buildCoyoteView(slot);
    else if (slot.kind === 'cup') buildCupView(slot);
    else buildEmsView(slot);
  }

  /** 关标签：断开这台设备并移除视图（原生实例留着，下次同号复用） */
  function removeSlot(slot) {
    if (!slot) return;
    try {
      if (slot.kind === 'cy') { slot.api.stopScan(); slot.api.disconnect(); }
      else if (slot.kind === 'cup') { slot.api.ycyStopScan(); slot.api.ycyDisconnect(); }
      else { slot.api.emsStopScan(); slot.api.emsDisconnect(); }
    } catch (e) { }
    var i = st.slots.indexOf(slot);
    if (i >= 0) st.slots.splice(i, 1);
    if (slot.root && slot.root.parentNode) slot.root.parentNode.removeChild(slot.root);
  }

  /** 每台设备自己的 MAC 输入框：0 号沿用旧键，多台用 cyMac-1 之类 */
  function bindMac(slot) {
    var el = q(slot.root)(slot.kind + '-mac');
    if (!el) return;
    try { var v = localStorage.getItem(macKey(slot)); if (v) el.value = v; } catch (e) { }
    var save = function () { saveMac(slot, (el.value || '').trim().toUpperCase()); };
    el.addEventListener('input', save);
    el.addEventListener('change', save);
    el.addEventListener('blur', save);
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ================= 主界面 ================= */

  function buildHome() {
    // 主界面：纯黑；顶部一条常驻标签栏（左：已打开的设备标签，右：加号）
    document.body.classList.add('bare');

    var bar = document.createElement('div');
    bar.id = 'homebar';
    bar.className = 'homebar';
    bar.innerHTML =
      '<div class="dev-tabs" id="dev-tabs"></div>' +
      '<button id="home-plus" class="home-plus">＋</button>';
    document.body.appendChild(bar);
    bar.querySelector('#home-plus').addEventListener('click', openPicker);
    bar.querySelector('#dev-tabs').addEventListener('click', onTabClick);

    var empty = document.createElement('div');
    empty.id = 'home-empty';
    empty.className = 'home-empty';
    empty.textContent = '点右上 ＋ 添加设备';
    document.body.appendChild(empty);

    var load = document.createElement('div');
    load.id = 'loading-chibi';
    load.className = 'loading-chibi';
    load.innerHTML =
      '<img src="art-chibi.webp" alt="">' +
      '<div class="load-shadow"></div>' +
      '<div class="load-text" id="load-text">扫描中…</div>';
    document.body.appendChild(load);
  }

  /* ================= 选设备弹层 ================= */

  var pickerBuilt = false, picking = false;

  function pickCard(id, name, desc, enabled) {
    return '<button class="pick-card' + (enabled === false ? ' off' : '') + '" data-p="' + id + '">' +
      '<b>' + esc(name) + '</b><i>' + esc(desc) + '</i></button>';
  }

  function buildPicker() {
    if (pickerBuilt) return;
    pickerBuilt = true;

    var mask = document.createElement('div');
    mask.id = 'pickmask';
    mask.className = 'pickmask';
    mask.addEventListener('click', closePicker);
    document.body.appendChild(mask);

    var sheet = document.createElement('div');
    sheet.id = 'picksheet';
    sheet.className = 'picksheet';
    sheet.innerHTML =
      '<div class="pick-head"><span>选择设备</span><span class="pick-x" id="pick-x">关闭</span></div>' +
      '<div class="pick-group">DG-LAB</div>' +
      pickCard('coyote', '郊狼', '电击主机 · 可加多台') +
      '<div class="pick-group">役次元</div>' +
      pickCard('cup', '榨精杯', '旋转 / 真空 / 震动 · 可加多台') +
      pickCard('ems', '电击器二代', '⚠ 有 BUG，谨慎使用 · 可加多台') +
      '<div class="pick-group">通用</div>' +
      pickCard('master', '总控台', '模式 / 急停 / 指令日志 / 语见联动') +
      '<div class="pick-group">其他</div>' +
      pickCard('game', '小游戏', '跳一跳 · 输赢有奖罚') +
      '<div class="pick-hint">同一类设备可以重复添加：每台独立扫描、独立连接、独立强度，互不影响。</div>';
    document.body.appendChild(sheet);

    $('pick-x').addEventListener('click', closePicker);
    sheet.querySelectorAll('[data-p]').forEach(function (b) {
      b.addEventListener('click', function () { pickDevice(b.dataset.p); });
    });
  }

  function openPicker() {
    buildPicker();
    var m = $('pickmask'), s = $('picksheet');
    if (m) m.classList.add('show');
    if (s) s.classList.add('show');
  }

  function closePicker() {
    var m = $('pickmask'), s = $('picksheet');
    if (m) m.classList.remove('show');
    if (s) s.classList.remove('show');
  }

  function pickDevice(id) {
    picking = true;
    closePicker();
    if (id === 'game') {
      setTimeout(function () {
        if (window.JumpGame) { try { window.JumpGame.open(); } catch (e) { addLog('[小游戏打开失败] ' + e); } }
      }, 160);
      return;
    }
    // 设备类：每点一次都新加一台（可以重复点「郊狼」加第二台，互不影响）
    var kind = { coyote: 'cy', cup: 'cup', ems: 'ems' }[id];
    setTimeout(function () {
      if (kind) addSlot(kind);
      else openPanel(id);
    }, 160);
  }

  var loadTimer = null, loadShownAt = 0, loadMinTimer = null;

  function showLoading(text) {
    var el = $('loading-chibi');
    if (!el) return;
    var t = $('load-text');
    if (t) t.textContent = text || '扫描中…';
    el.classList.add('show');
    loadShownAt = Date.now();
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(hideLoading, 20000);
  }

  function hideLoading() {
    var el = $('loading-chibi');
    if (!el) return;
    // 至少显示 1.5 秒，否则一闪而过看不见
    var held = Date.now() - loadShownAt;
    if (held < 1500 && el.classList.contains('show')) {
      if (loadMinTimer) clearTimeout(loadMinTimer);
      loadMinTimer = setTimeout(function () { el.classList.remove('show'); }, 1500 - held);
    } else {
      el.classList.remove('show');
    }
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
  }

  /* ================= 面板 ================= */

  function buildPanel() {
    var p = document.createElement('div');
    p.id = 'devpanel';
    p.className = 'devpanel';
    // 设备页（郊狼/杯/电击器）不再预建：每加一台设备动态建一个 .dev-view
    p.innerHTML =
      '<div class="dev-view" id="view-brand"></div>' +
      '<div class="dev-view" id="view-dg" style="display:none"></div>' +
      '<div class="dev-view" id="view-ycy" style="display:none"></div>' +
      '<div class="dev-view" id="view-master" style="display:none"></div>';
    document.body.appendChild(p);

    loadLimits();   // 先读回安全标准等设置，再建视图，否则滑块显示的是默认值
    buildBrandView();
    buildDgView();
    buildYcyView();
    buildMasterView();
  }

  /* ---------- 设备标签页（浏览器式） ---------- */

  var TITLES = {
    brand: '设备', dg: 'DG-LAB', ycy: '役次元',
    coyote: '郊狼', cup: '榨精杯', ems: '电击器二代', master: '总控台'
  };

  function openTab(id) {
    if (!id) return;
    if (st.tabs.indexOf(id) < 0) st.tabs.push(id);
    setPanel(true);
    show(id);
  }

  function closeTab(id) {
    var i = st.tabs.indexOf(id);
    if (i < 0) return;
    st.tabs.splice(i, 1);
    var slot = slotById(id);
    if (slot) {
      var gone = slot.title;   // 先记住名字：移除后编号会变
      removeSlot(slot);        // 先断开这台设备的 BLE，再拆掉界面
      addLog('已关闭「' + gone + '」');
    }
    if (current !== id) { renderTabs(); renderMaster(); return; }
    var next = st.tabs[i] || st.tabs[i - 1] || '';
    if (next) show(next);
    else closePanel();
  }

  function onTabClick(e) {
    var x = e.target.closest ? e.target.closest('[data-close]') : null;
    if (x) { closeTab(x.getAttribute('data-close')); return; }
    var t = e.target.closest ? e.target.closest('[data-tab]') : null;
    if (!t) return;
    var id = t.getAttribute('data-tab');
    // 点一下选中，再点一下弃选：已选中的再点 → 收起页面区，回到主界面
    if (id && id === current && isPanelOpen()) { closePanel(); return; }
    openTab(id);
  }

  function isPanelOpen() {
    var p = $('devpanel');
    return !!(p && p.classList.contains('show'));
  }

  function renderTabs() {
    var box = $('dev-tabs');
    if (!box) return;
    var out = '';
    st.tabs.forEach(function (id) {
      out += '<button class="dev-tab' + (id === current ? ' on' : '') + '" data-tab="' + id + '">' +
        '<span class="tab-name">' + esc(tabTitle(id)) + '</span>' +
        '<span class="tab-x" data-close="' + id + '">×</span></button>';
    });
    box.innerHTML = out;
    var empty = $('home-empty');
    if (empty) empty.style.display = st.tabs.length ? 'none' : '';
    var on = box.querySelector('.dev-tab.on');
    if (on && on.scrollIntoView) {
      try { on.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (err) { }
    }
  }

  function brandCard(id, name, desc, enabled) {
    return '<button class="brand-card' + (enabled ? '' : ' off') + '" data-b="' + id + '"' +
      (enabled ? '' : ' disabled') + '>' +
      '<b>' + esc(name) + '</b><i>' + esc(desc) + '</i></button>';
  }

  function buildBrandView() {
    var v = $('view-brand');
    v.innerHTML =
      '<div class="dev-hint" style="margin:2px 0 12px">选择设备品牌</div>' +
      brandCard('dg', 'DG-LAB', '郊狼电击系列', true) +
      brandCard('ycy', '役次元', '榨精杯 / 电击器', true);
    v.querySelectorAll('[data-b]').forEach(function (b) {
      b.addEventListener('click', function () { show(b.dataset.b === 'dg' ? 'dg' : 'ycy'); });
    });
  }

  function buildDgView() {
    var v = $('view-dg');
    v.innerHTML =
      '<div class="dev-hint" style="margin:2px 0 12px">DG-LAB 产品</div>' +
      brandCard('coyote', '郊狼', '主机 · 已支持', true) +
      brandCard('possum', '负鼠', '官方产品 · 暂未支持', false) +
      brandCard('civet', '灵猫', '官方产品 · 暂未支持', false);
    v.querySelectorAll('[data-b]').forEach(function (b) {
      b.addEventListener('click', function () { if (b.dataset.b === 'coyote') addSlot('cy'); });
    });
  }

  function buildYcyView() {
    var v = $('view-ycy');
    v.innerHTML =
      '<div class="dev-hint" style="margin:2px 0 12px">役次元产品</div>' +
      brandCard('cup', '榨精杯', '已支持', true) +
      brandCard('ems', '电击器二代', '⚠ 有 BUG，不建议使用', true) +
      brandCard('ems1', '电击器一代', '暂未支持', false) +
      brandCard('cleaner', '灌肠机', '暂未支持', false);
    v.querySelectorAll('[data-b]').forEach(function (b) {
      var k = b.dataset.b;
      b.addEventListener('click', function () {
        if (k === 'cup') addSlot('cup');
        else if (k === 'ems') addSlot('ems');
      });
    });
  }

  /* ---------------- 郊狼 ---------------- */

  function buildCoyoteView(slot) { var root = slot.root, $ = q(root), st = slot.d, CY = slot.api;
    root.innerHTML =
      '<div class="dev-status" id="cy-status">未连接</div>' +
      '<div class="dev-row">' +
        '<button class="dev-btn" id="cy-auto">自动识别</button>' +
        '<button class="dev-btn ghost" id="cy-scan">扫描</button>' +
        '<button class="dev-btn ghost" id="cy-disc">断开</button>' +
      '</div>' +
      '<div class="dev-list" id="cy-list"></div>' +
      '<div class="sock-row"><label>手动 MAC</label>' +
      '<input id="cy-mac" class="sock-in" placeholder="XX:XX:XX:XX:XX:XX" spellcheck="false"></div>' +
      '<div class="dev-row"><button class="dev-btn" id="cy-macgo">按 MAC 连接</button></div>' +

      '<div class="dev-sec">限位</div>' +
      '<div class="sock-row"><label>输出时长</label><div id="cy-range" style="flex:1"></div></div>' +
      '<div class="sock-row"><label>力度上限</label>' +
      '<input type="range" id="cy-cap" min="5" max="200" step="5" value="40" style="flex:1">' +
      '<span class="dbg-val" id="cy-capv">40</span></div>' +
      '<div class="sock-row"><label>频率下限</label>' +
      '<input type="range" id="cy-fmin" min="10" max="240" step="5" value="30" style="flex:1">' +
      '<span class="dbg-val" id="cy-fminv">30</span></div>' +
      '<div class="sock-row"><label>频率上限</label>' +
      '<input type="range" id="cy-fmax" min="10" max="240" step="5" value="200" style="flex:1">' +
      '<span class="dbg-val" id="cy-fmaxv">200</span></div>' +

      '<div class="dev-sec">手动通道</div>' +
      '<div class="sock-row"><label>A 等级</label>' +
      '<input type="range" id="cy-a" min="0" max="100" step="1" value="0" style="flex:1">' +
      '<span class="dbg-val" id="cy-av">0</span></div>' +
      '<div class="sock-row"><label>B 等级</label>' +
      '<input type="range" id="cy-b" min="0" max="100" step="1" value="0" style="flex:1">' +
      '<span class="dbg-val" id="cy-bv">0</span></div>' +
      '<div class="dev-sec">软上限</div>' +
      '<div class="sock-row"><label>软上限</label>' +
      '<input type="range" id="cy-limit" min="5" max="100" step="1" value="30" style="flex:1">' +
      '<span class="dbg-val" id="cy-limitv">30</span></div>' +
      '<div class="dev-hint" id="cy-limithint">写入设备（BF 指令，断电保存）。任何路径都超不过这个值，两端都会被截断。</div>' +
      '<div class="dev-sec">安全标准</div>' +
      '<div class="sock-row"><label>安全标准</label>' +
      '<input type="range" id="cy-safe" min="0.1" max="1" step="0.05" value="0.5" style="flex:1">' +
      '<span class="dbg-val" id="cy-safev">0.50</span></div>' +
      '<div class="dev-hint" id="cy-safehint">实际强度 = 面板等级 × 安全标准。默认 0.5，最大 1（等于面板值）。等级 100 × 0.5 → 设备 50，再受软上限截断。</div>' +
      '<div class="sock-row"><label>触发概率</label>' +
      '<input type="range" id="cy-firep" min="0.1" max="1" step="0.1" value="1" style="flex:1">' +
      '<span class="dbg-val" id="cy-firepv">100%</span></div>' +
      '<div class="dev-hint" id="cy-firehint">1.0 = 每轮都动手；调低就变成「这次有概率不理他」。</div>' +
      '<div class="sock-row"><label>频率 A</label>' +
      '<input type="range" id="cy-frA" min="10" max="240" step="1" value="60" style="flex:1">' +
      '<span class="dbg-val" id="cy-frAv">60</span></div>' +
      '<div class="sock-row"><label>强度 A</label>' +
      '<input type="range" id="cy-inA" min="0" max="100" step="1" value="20" style="flex:1">' +
      '<span class="dbg-val" id="cy-inAv">20</span></div>' +
      '<div class="sock-row"><label>频率 B</label>' +
      '<input type="range" id="cy-frB" min="10" max="240" step="1" value="60" style="flex:1">' +
      '<span class="dbg-val" id="cy-frBv">60</span></div>' +
      '<div class="sock-row"><label>强度 B</label>' +
      '<input type="range" id="cy-inB" min="0" max="100" step="1" value="20" style="flex:1">' +
      '<span class="dbg-val" id="cy-inBv">20</span></div>' +
      '<button class="dev-btn" id="cy-test" style="margin-top:8px">自检（会把参数和回执打进日志）</button>' +
      '<button class="dev-btn" id="cy-ramp" style="margin-top:8px">跟随核对（逐级升强度，只看设备回报，不用贴身）</button>' +
      '<button class="dev-emergency sm" id="cy-stopall">停 止 输 出</button>' +
      '<button class="dev-reset" id="cy-reset">重 置 郊 狼</button>';

    $('cy-auto').addEventListener('click', function () {
      if (!window.Coyote) return;
      slot.devices = []; renderList(slot);
      showLoading('识别中…');
      CY.autoFind(); addLog('郊狼自动识别…');
    });
    $('cy-scan').addEventListener('click', function () {
      if (!window.Coyote) return;
      slot.devices = []; renderList(slot);
      showLoading('扫描中…');
      CY.scan(); addLog('扫描郊狼…');
    });
    $('cy-disc').addEventListener('click', function () {
      if (window.Coyote) { CY.stopScan(); CY.disconnect(); }
    });
    $('cy-macgo').addEventListener('click', function () {
      var mac = ($('cy-mac').value || '').trim().toUpperCase();
      if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac)) { addLog('MAC 格式不对'); return; }
      saveMac(slot, mac);
      if (window.Coyote) CY.connect(mac);
    });
    // 手动 A/B 各自独立：原来两个滑块共用一个监听且都读 cy-a，B 滑块等于没用
    function cyApplyStrength() {
      if (!window.Coyote) return;
      CY.setStrength(cyStrength(st.cyA), cyStrength(st.cyB));
      addLog('手动强度 → A 等级 ' + st.cyA + '（设备 ' + cyStrength(st.cyA) + '）  B 等级 ' + st.cyB + '（设备 ' + cyStrength(st.cyB) + '）');
    }
    ['cy-a', 'cy-b'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        st.cyA = Number($('cy-a').value);
        st.cyB = Number($('cy-b').value);
        $('cy-av').textContent = st.cyA;
        $('cy-bv').textContent = st.cyB;
        cyApplyStrength();
      });

    });
    // 安全标准：实际强度 = 面板等级 × 安全标准（默认 0.5，最大 1）
    function updateSafeHint() {
      var el = $('cy-safehint');
      if (!el) return;
      el.textContent = '实际强度 = 面板等级 × ' + st.scale.toFixed(2)
        + '。等级 100 → 设备 ' + Math.round(100 * st.scale)
        + '（软上限 ' + st.limit + ' 封顶）；当前 A 等级 ' + st.cyA + ' → 设备 ' + cyStrength(st.cyA)
        + '，B 等级 ' + st.cyB + ' → 设备 ' + cyStrength(st.cyB) + '。';
    }
    if ($('cy-limit')) {
      $('cy-limit').value = st.limit;
      $('cy-limitv').textContent = st.limit;
      $('cy-limit').addEventListener('input', function () {
        st.limit = Math.round(Number(this.value));
        $('cy-limitv').textContent = st.limit;
        saveLimits();
        if (window.Coyote) CY.setLimit(st.limit, st.limit);
        updateSafeHint();
        addLog('软上限 → ' + st.limit + '（已写 BF，设备断电保存）');
      });
    }
    if ($('cy-safe')) {
      $('cy-safe').value = st.scale;
      $('cy-safev').textContent = st.scale.toFixed(2);
      $('cy-safe').addEventListener('input', function () {
        st.scale = Number(this.value);
        $('cy-safev').textContent = st.scale.toFixed(2);
        saveLimits();
        updateSafeHint();
        if (window.Coyote) CY.setStrength(cyStrength(st.cyA), cyStrength(st.cyB));
      });
      updateSafeHint();
    }
    if ($('cy-firep')) {
      $('cy-firep').value = st.fireP;
      $('cy-firepv').textContent = Math.round(st.fireP * 100) + '%';
      $('cy-firep').addEventListener('input', function () {
        st.fireP = Number(this.value);
        $('cy-firepv').textContent = Math.round(st.fireP * 100) + '%';
        saveLimits();
        addLog('触发概率 → ' + Math.round(st.fireP * 100) + '%');
      });
    }
    ['cy-frA', 'cy-inA', 'cy-frB', 'cy-inB'].forEach(function (id) {
      $(id).addEventListener('input', function (e) {
        var k = e.target.id, v = Number(e.target.value);
        if (k === 'cy-frA') { st.frA = v; $('cy-frAv').textContent = v; }
        else if (k === 'cy-inA') { st.inA = v; $('cy-inAv').textContent = v; }
        else if (k === 'cy-frB') { st.frB = v; $('cy-frBv').textContent = v; }
        else { st.inB = v; $('cy-inBv').textContent = v; }
        if (window.Coyote) CY.setPulse(cyFreq(st.frA), st.inA, cyFreq(st.frB), st.inB);
      });
    });
    ['cy-cap', 'cy-fmin', 'cy-fmax'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        st.cyMax = Number($('cy-cap').value);
        st.frMin = Number($('cy-fmin').value);
        st.frMax = Number($('cy-fmax').value);
        if (st.frMin > st.frMax) { st.frMin = st.frMax; $('cy-fmin').value = st.frMin; }
        $('cy-capv').textContent = st.cyMax;
        $('cy-fminv').textContent = st.frMin;
        $('cy-fmaxv').textContent = st.frMax;
        saveLimits();
      });
    });
    buildDualRange($('cy-range'), 4, 60, st.cyHoldMin / 1000, st.cyHoldMax / 1000, function (lo, hi) {
      st.cyHoldMin = lo * 1000; st.cyHoldMax = hi * 1000; saveLimits();
    });
    $('cy-test').addEventListener('click', function () {
    $('cy-ramp').addEventListener('click', rampCheck);
      if (!window.Coyote || !CY.selfCheck) { addLog('原生没这个方法，装的还是旧包'); return; }
      CY.selfCheck();
    });
    $('cy-stopall').addEventListener('click', function () {
      st.cyA = st.cyB = 0; st.cyApl = st.cyBpl = 0;
      $('cy-a').value = 0; $('cy-b').value = 0;
      $('cy-av').textContent = '0'; $('cy-bv').textContent = '0';
      if (window.Coyote) CY.emergencyStop();
      addLog('郊狼已停止输出');
      render();
    });

    $('cy-reset').addEventListener('click', function () {
      st.cyA = st.cyB = 0; st.cyApl = st.cyBpl = 0;
      st.frA = 60; st.inA = 20; st.cyMax = 40; st.frMin = 30; st.frMax = 200;
      st.cyHoldMin = 4000; st.cyHoldMax = 60000;
      $('cy-a').value = 0; $('cy-b').value = 0;
      $('cy-av').textContent = '0'; $('cy-bv').textContent = '0';
      $('cy-frA').value = 60; $('cy-inA').value = 20;
      $('cy-frAv').textContent = '60'; $('cy-inAv').textContent = '20';
      if (window.Coyote) { CY.emergencyStop(); CY.setPulse(60, 20, 60, 20); }
      saveLimits(); addLog('郊狼已重置'); render();
    });
    bindMac(slot);
  }

  /* ---------------- 榨精杯 ---------------- */

  function buildCupView(slot) { var root = slot.root, $ = q(root), st = slot.d, CY = slot.api;
    root.innerHTML =
      '<div class="dev-status" id="cup-status">未连接</div>' +
      '<div class="dev-row">' +
        '<button class="dev-btn" id="cup-scan">扫描</button>' +
        '<button class="dev-btn ghost" id="cup-scanall">扫描全部</button>' +
        '<button class="dev-btn ghost" id="cup-disc">断开</button>' +
      '</div>' +
      '<div class="dev-list" id="cup-list"></div>' +
      '<div class="sock-row"><label>手动 MAC</label>' +
      '<input id="cup-mac" class="sock-in" placeholder="XX:XX:XX:XX:XX:XX" spellcheck="false"></div>' +
      '<div class="dev-row"><button class="dev-btn" id="cup-macgo">按 MAC 连接</button></div>' +
      '<div id="cup-motors"></div>' +
      '<div class="dev-sec">三路力度</div>' +
      '<div class="sock-row"><label>A 旋转</label>' +
      '<input type="range" id="cup-a" min="0" max="20" step="1" value="0" style="flex:1">' +
      '<span class="dbg-val" id="cup-av">0</span></div>' +
      '<div class="sock-row"><label>B 真空</label>' +
      '<input type="range" id="cup-b" min="0" max="20" step="1" value="0" style="flex:1">' +
      '<span class="dbg-val" id="cup-bv">0</span></div>' +
      '<div class="sock-row"><label>C 杯身振动</label>' +
      '<input type="range" id="cup-c" min="0" max="20" step="1" value="0" style="flex:1">' +
      '<span class="dbg-val" id="cup-cv">0</span></div>' +
      '<div class="dev-hint">C 这一位驱动的是杯身振动 D。内胆振动（原 C）线圈已损坏，任何值都不会响应，别拿它当反馈依据。</div>' +
      '<div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:10px">' +
      '<button class="dev-btn small" id="cup-only-a">只 A=20</button>' +
      '<button class="dev-btn small" id="cup-only-b">只 B=20</button>' +
      '<button class="dev-btn small" id="cup-only-c">只 C=20</button>' +
      '<button class="dev-btn small ghost" id="cup-zero">全停</button>' +
      '</div>' +
      '<div class="dev-sec">限位</div>' +
      '<div class="sock-row"><label>输出时长</label><div id="cup-range" style="flex:1"></div></div>' +
      '<button class="dev-emergency sm" id="cup-stopall">停 止 输 出</button>' +
      '<button class="dev-reset" id="cup-reset">重 置 榨 精 杯</button>';

    $('cup-scan').addEventListener('click', function () {
      if (!window.Coyote) return;
      slot.devices = []; renderList(slot);
      st.scanning = 'cup';
      showLoading('扫描中…');
      CY.ycyScan(); addLog('扫描役次元…');
    });
    $('cup-scanall').addEventListener('click', function () {
      if (!window.Coyote) return;
      slot.devices = []; renderList(slot);
      st.scanning = 'cup';
      showLoading('扫描中…');
      CY.ycyScanAll(); addLog('扫描全部…');
    });
    $('cup-disc').addEventListener('click', function () {
      if (window.Coyote) { CY.ycyStopScan(); CY.ycyDisconnect(); }
    });
    $('cup-macgo').addEventListener('click', function () {
      var mac = ($('cup-mac').value || '').trim().toUpperCase();
      if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac)) { addLog('MAC 格式不对'); return; }
      saveMac(slot, mac);
      if (window.Coyote) { CY.ycyDevType(0); CY.ycyConnect(mac); }
    });
    function pushCup() {
      if (window.Coyote) CY.ycySpeed(st.cupSpeed.a, st.cupSpeed.b, st.cupSpeed.c);
    }
    ['a', 'b', 'c'].forEach(function (k) {
      var sl = $('cup-' + k), out = $('cup-' + k + 'v');
      if (!sl) return;
      sl.addEventListener('input', function () {
        var v = Number(this.value);
        st.cupSpeed[k] = v;
        if (out) out.textContent = v;
        pushCup();
      });
    });
    function cupPreset(a, b, c) {
      st.cupSpeed = { a: a, b: b, c: c };
      syncCupSliders(slot);
      pushCup();
      addLog('榨精杯：A' + a + ' B' + b + ' C' + c);
    }
    if ($('cup-only-a')) $('cup-only-a').addEventListener('click', function () { cupPreset(20, 0, 0); });
    if ($('cup-only-b')) $('cup-only-b').addEventListener('click', function () { cupPreset(0, 20, 0); });
    if ($('cup-only-c')) $('cup-only-c').addEventListener('click', function () { cupPreset(0, 0, 20); });
    if ($('cup-zero')) $('cup-zero').addEventListener('click', function () { cupPreset(0, 0, 0); });
    buildDualRange($('cup-range'), 4, 60, st.ycHoldMin / 1000, st.ycHoldMax / 1000, function (lo, hi) {
      st.ycHoldMin = lo * 1000; st.ycHoldMax = hi * 1000; saveLimits();
    });
    $('cup-stopall').addEventListener('click', function () {
      st.cupSpeed = { a: 0, b: 0, c: 0 };
      syncCupSliders(slot);
      if (window.Coyote) CY.ycyStop();
      addLog('榨精杯已停止输出');
      render();
    });

    $('cup-reset').addEventListener('click', function () {
      st.cupSpeed = { a: 0, b: 0, c: 0 };
      syncCupSliders(slot);
      if (window.Coyote) { CY.ycyStop(); CY.ycySpeed(0, 0, 0); }
      addLog('榨精杯已重置'); renderCupMotors(slot); render();
    });
    bindMac(slot);
  }

  /* ---------------- 电击器 ---------------- */

  function buildEmsView(slot) { var root = slot.root, $ = q(root), st = slot.d, CY = slot.api;
    root.innerHTML =
      '<div class="dev-status" id="ems-status">未连接</div>' +
      '<div class="dev-danger">' +
        '<span class="dt">⚠ 这台机器有 BUG，不建议使用</span>' +
        '役次元电击器二代（荆棘 2.0）目前只保证 <b>A 口</b>。已知问题：' +
        '<ul>' +
          '<li>B 口与机身电极无法独立驱动，点了没反应</li>' +
          '<li><b>点「停止输出」后 B 口可能还有一下放电</b>，强度不受控</li>' +
          '<li>强度是两字节大端，上限被硬夹在 20</li>' +
        '</ul>' +
        '别贴在身上用。协议没补全之前，只建议拿它做连接测试。' +
      '</div>' +
      '<div class="dev-row">' +
        '<button class="dev-btn" id="ems-scan">扫描</button>' +
        '<button class="dev-btn ghost" id="ems-scanall">扫描全部</button>' +
        '<button class="dev-btn ghost" id="ems-disc">断开</button>' +
      '</div>' +
      '<div class="dev-list" id="ems-list"></div>' +
      '<div class="sock-row"><label>手动 MAC</label>' +
      '<input id="ems-mac" class="sock-in" placeholder="XX:XX:XX:XX:XX:XX" spellcheck="false"></div>' +
      '<div class="dev-row"><button class="dev-btn" id="ems-macgo">按 MAC 连接</button></div>' +

      '<div class="dev-sec">电极口</div>' +
      '<div class="row" style="gap:6px;margin-bottom:6px" id="ems-chs">' +
        '<button class="dev-btn small" data-port="0">A 口</button>' +
        '<button class="dev-btn small" data-port="1">B 口</button>' +
      '</div>' +
      '<label class="dev-row" style="gap:8px;align-items:center">' +
        '<input type="checkbox" id="ems-dual"> A/B 同时发</label>' +
      '<div class="dev-hint" style="margin:0 0 10px" id="ems-hint2">0.81 起实时帧按官方格式同时带 A/B 两段：选 A 就只填 A 段、选 B 就只填 B 段。0.80 及以前只发 A 段，所以 B 口一直没反应。</div>' + +

      '<div class="dev-sec">输出（硬上限 20）</div>' +
      '<div class="dev-warn">强度被原生层夹死在 <b>20</b>，滑到顶也只发 20。之前填 3 却像满功率，是因为帧格式被固件当成两字节强度解析，那个入口已经删除。</div>' +
      '<div class="sock-row"><label>强度</label>' +
      '<input type="range" id="ems-str" min="0" max="20" step="1" value="0" style="flex:1">' +
      '<span class="dbg-val" id="ems-strv">0</span></div>' +
      '<div class="sock-row"><label>模式</label>' +
      '<input type="range" id="ems-mode" min="1" max="16" step="1" value="1" style="flex:1">' +
      '<span class="dbg-val" id="ems-modev">1</span></div>' +
      '<div class="sock-row"><label>频率</label>' +
      '<input type="range" id="ems-freq" min="1" max="100" step="1" value="50" style="flex:1">' +
      '<span class="dbg-val" id="ems-freqv">50</span></div>' +
      '<div class="sock-row"><label>脉冲</label>' +
      '<input type="range" id="ems-pulse" min="0" max="100" step="1" value="50" style="flex:1">' +
      '<span class="dbg-val" id="ems-pulsev">50</span></div>' +
      '<div class="row" style="gap:8px;margin-top:8px">' +
        '<button class="dev-btn" id="ems-send">发固定模式</button>' +
        '<button class="dev-btn ghost" id="ems-sendreal">发实时模式</button>' +
      '</div>' +
      '<div class="row" style="gap:8px;margin-top:8px">' +
        '<button class="dev-btn ghost" id="ems-burstb">B 口连发 3 秒</button>' +
      '</div>' +
      '<div class="row" style="gap:8px;margin-top:8px">' +
        '<button class="dev-btn" id="ems-atest">A 口 5 级</button>' +
        '<button class="dev-btn" id="ems-btest">B 口 5 级</button>' +
      '</div>' +
      '<div class="dev-hint" style="margin:0 0 8px">这两个按钮用完整实时帧（A/B 两段同帧）单发一次，用来验证哪一路真的出电。</div>' +
      '<label class="dev-row" style="gap:8px;align-items:center">' +
        '<input type="checkbox" id="ems-bfollow"> B 跟随 A（A 出力时每 700ms 补发一帧到 B）</label>' +
      '<div class="dev-hint" style="margin:0 0 8px">实测：先让 A 放电再点停止，B 会闪一下。说明 B 可能只是同一个输出级切过去，需要连续帧维持。</div>' +
      '<label class="dev-row" style="gap:8px;align-items:center">' +
        '<input type="checkbox" id="ems-zerob"> 停止时也写 B 通道（默认关：关掉后停止不会再电到 B）</label>' +
      '<div class="dev-hint" id="ems-hint">强度从 1 开始试，每次只改一个参数。</div>' +
      '<div class="dev-hint" id="ems-diag" style="font-family:monospace">诊断：等待数据</div>' +

      '<div class="dev-sec">分通道协议（官方 35 11 03）</div>' +
      '<div class="dev-hint" style="margin:0 0 8px">官方 App 用 <code>35 11 03 [口] [强度2字节] [波形]</code> 分别驱动 A/B 口，和我们之前用的 <code>35 11 02</code> 是两条命令。强度在这里再夹一次，最高 5，4 秒自动停。会先发 35 13 01 开会话，再发 35 11 03 波形帧。</div>' +
      '<div class="row" style="gap:8px">' +
        '<button class="dev-btn ghost" id="ems-chan-a">只给 A（5级）</button>' +
        '<button class="dev-btn ghost" id="ems-chan-b">只给 B（5级）</button>' +
        '<button class="dev-btn small" id="ems-chan-stop">停</button>' +
      '</div>' +
      '<div class="dev-hint" id="ems-chan-hint">先点「只给 A」确认 0x03 这条命令能被接受，再试 B。</div>' +

      '<div class="dev-sec">调试</div>' +
      '<div class="sock-row"><label>HEX</label>' +
      '<input id="ems-hex" class="sock-in" placeholder="35 11 01 00 28 01" spellcheck="false">' +
      '<button class="dev-btn small" id="ems-raw">发</button></div>' +
      '<div class="row" style="gap:6px;flex-wrap:wrap">' +
        '<button class="dev-btn small" data-hex="35 11 01 00 01 01">强度1 m1</button>' +
        '<button class="dev-btn small" data-hex="35 11 01 00 05 01">强度5 m1</button>' +
        '<button class="dev-btn small" data-hex="35 11 01 00 0A 01">强度10 m1</button>' +
        '<button class="dev-btn small" data-hex="35 11 02 00 05 32 32">实时5</button>' +
      '</div>' +
      '<button class="dev-emergency sm" id="ems-stopall">停 止 输 出</button>' +
      '<button class="dev-reset" id="ems-reset">重 置 电 击 器</button>';

    $('ems-scan').addEventListener('click', function () {
      if (!window.Coyote) return;
      slot.devices = []; renderList(slot);
      st.scanning = 'ems';
      showLoading('扫描中…');
      CY.emsScan(false); addLog('扫描电击器…');
    });
    $('ems-scanall').addEventListener('click', function () {
      if (!window.Coyote) return;
      slot.devices = []; renderList(slot);
      st.scanning = 'ems';
      showLoading('扫描中…');
      CY.emsScan(true); addLog('扫描全部…');
    });
    $('ems-disc').addEventListener('click', function () {
      if (window.Coyote) { CY.emsStopScan(); CY.emsDisconnect(); }
    });
    $('ems-macgo').addEventListener('click', function () {
      var mac = ($('ems-mac').value || '').trim().toUpperCase();
      if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac)) { addLog('MAC 格式不对'); return; }
      saveMac(slot, mac);
      if (window.Coyote) CY.emsConnect(mac);
    });
    ['ems-str', 'ems-mode', 'ems-freq', 'ems-pulse'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        var v = $(id + 'v');
        if (v) v.textContent = this.value;
      });
    });
    $('ems-send').addEventListener('click', function () {
      var s = Number($('ems-str').value), m = Number($('ems-mode').value);
      if (window.Coyote) CY.ycyEmsFixed(s, m);
      $('ems-hint').textContent = '已发固定：强度 ' + s + ' 模式 ' + m;
      addLog('EMS 固定 ' + s + '/' + m);
    });
    $('ems-zerob').addEventListener('change', function () {
      if (window.Coyote) CY.emsZeroB(this.checked);
      try { localStorage.setItem('emsZeroB', this.checked ? '1' : '0'); } catch (e) { }
      addLog(this.checked ? '停止时也写 B：开' : '停止时也写 B：关（更安全）');
    });

    $('ems-bfollow').addEventListener('change', function () {
      if (window.Coyote) CY.emsBFollow(this.checked);
      try { localStorage.setItem('emsBFollow', this.checked ? '1' : '0'); } catch (e) { }
      addLog(this.checked ? 'B 跟随 A：开' : 'B 跟随 A：关');
    });

    $('ems-burstb').addEventListener('click', function () {
      var s = Number($('ems-str').value), m = Number($('ems-mode').value);
      if (window.Coyote) CY.emsBurstB(s, m, 3000);
      addLog('B 口连发：强度 ' + s + ' 模式 ' + m + '（3 秒自动停）');
    });
    // 0.81：用完整实时帧分别打 A/B 段，验证哪一路真的出电
    function emsOneShot(port) {
      var f = Number($('ems-freq').value) || 50;
      var p = Number($('ems-pulse').value) || 50;
      st.emsCh = port;
      try { localStorage.setItem('emsCh', String(port)); } catch (e) { }
      if (window.Coyote) CY.emsChannel(port);
      paintChannels();
      if (window.Coyote) CY.ycyEmsReal(5, f, p);
      var t = port === 0 ? 'A' : 'B';
      $('ems-hint').textContent = '已发：只给 ' + t + ' 口 5 级（完整帧）';
      addLog('完整帧 ' + t + ' 口 强度 5（口选择已切到 ' + t + '）');
    }
    $('ems-atest').addEventListener('click', function () { emsOneShot(0); });
    $('ems-btest').addEventListener('click', function () { emsOneShot(1); });
    $('ems-sendreal').addEventListener('click', function () {
      var s = Number($('ems-str').value);
      var f = Number($('ems-freq').value);
      var p = Number($('ems-pulse').value);
      if (window.Coyote) CY.ycyEmsReal(s, f, p);
      $('ems-hint').textContent = '已发实时：' + s + ' / ' + f + 'Hz / 脉冲 ' + p;
      addLog('EMS 实时 ' + s + '/' + f + '/' + p);
    });
    root.querySelectorAll('[data-port]').forEach(function (b) {
      b.addEventListener('click', function () {
        var idx = Number(b.dataset.port);
        st.emsCh = idx;
        try { localStorage.setItem('emsCh', String(idx)); } catch (e) { }
        if (window.Coyote) CY.emsChannel(idx);
        paintChannels();
        addLog('切换电极口 → ' + b.textContent);
        var h = $('ems-hint');
        if (h) h.textContent = '当前发到 ' + b.textContent;
      });
    });

    function paintChannels() {
      var box = $('ems-chs');
      if (!box) return;
      box.querySelectorAll('[data-port]').forEach(function (x) {
        x.classList.toggle('on', Number(x.dataset.port) === st.emsCh);
      });
    }
    paintChannels();

    $('ems-dual').addEventListener('change', function () {
      if (window.Coyote) CY.emsDual(this.checked);
      try { localStorage.setItem('emsDual', this.checked ? '1' : '0'); } catch (e) { }
      addLog(this.checked ? '双通道：开' : '双通道：关');
    });

    root.querySelectorAll('[data-hex]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.dataset.hex;
        $('ems-hex').value = v;
        if (window.Coyote) CY.emsRaw(v);
        addLog('预置发送 ' + v);
      });
    });

    $('ems-raw').addEventListener('click', function () {
      var v = ($('ems-hex').value || '').trim();
      if (!v) return;
      if (window.Coyote) CY.emsRaw(v);
      addLog('原始：' + v);
    });

    $('ems-chan-a').addEventListener('click', function () {
      if (window.Coyote) CY.emsChanTest(1, 5);
      $('ems-chan-hint').textContent = '已发：A 口 强度 5（4 秒自动停）';
      addLog('通道协议 A 口 强度1');
    });
    $('ems-chan-b').addEventListener('click', function () {
      if (window.Coyote) CY.emsChanTest(2, 5);
      $('ems-chan-hint').textContent = '已发：B 口 强度 5（4 秒自动停）';
      addLog('通道协议 B 口 强度1');
    });
    $('ems-chan-stop').addEventListener('click', function () {
      if (window.Coyote) CY.emsChanStop();
      $('ems-chan-hint').textContent = '已发停止帧';
      addLog('通道协议停止');
    });

    $('ems-stopall').addEventListener('click', function () {
      st.emsStrength = 0;
      $('ems-str').value = 0; $('ems-strv').textContent = '0';
      if (window.Coyote) CY.emsStop();
      addLog('电击器已停止输出');
      render();
    });

    $('ems-reset').addEventListener('click', function () {
      st.emsStrength = 0;
      $('ems-str').value = 0; $('ems-strv').textContent = '0';
      if (window.Coyote) CY.ycyEmsFixed(0, Number($('ems-mode').value));
      addLog('电击器已重置'); render();
    });
    slot.paintChannels = paintChannels;   // 让外部回调也能刷新电极口高亮
    bindMac(slot);
  }

  /* ---------------- 总控台 ---------------- */

  function buildMasterView() {
   try {
    $('view-master').innerHTML =
      '<div class="dev-sec">输出状态</div>' +
      '<div class="dev-status" id="m-cy">郊狼：未连接</div>' +
      '<div class="dev-status" id="m-cup" style="margin-top:6px">榨精杯：未连接</div>' +
      '<div class="dev-status" id="m-ems" style="margin-top:6px">电击器：未连接</div>' +

      '<div class="dev-sec">安全模式</div>' +
      '<div class="row" style="gap:8px;margin-bottom:8px" id="m-modes">' +
        '<button class="dev-btn small" data-m="easy">简单</button>' +
        '<button class="dev-btn small" data-m="normal">普通</button>' +
        '<button class="dev-btn small" data-m="hell">炼狱</button>' +
      '</div>' +
      '<div class="dev-hint" id="m-modehint"></div>' +

      '<div class="dev-sec">渐强目标</div>' +
      '<div class="dev-hint" style="margin:0 0 8px">先选设备，再从 0 逐级升到这个等级。急停会把所有设备立刻归零。</div>' +
      '<button class="dev-pick" id="m-pick">' +
        '<span id="m-pick-label">目标：全部设备</span><i>▾</i>' +
      '</button>' +
      '<div class="pick-list" id="m-picklist">' +
        '<button data-t="all">全部设备</button>' +
        '<button data-t="cy">郊狼</button>' +
        '<button data-t="cup">榨精杯</button>' +
        '<button data-t="ems">电击器</button>' +
      '</div>' +
      '<div class="dev-strength">' +
        '<button class="dev-round" data-t="-2">−</button>' +
        '<div class="dev-val"><b id="m-target">20</b><span>目标等级</span><i id="m-applied">实际 0</i></div>' +
        '<button class="dev-round" data-t="2">+</button>' +
      '</div>' +
      '<div class="row" style="gap:10px;margin-top:10px">' +
        '<button class="dev-start" id="m-start">开始渐强</button>' +
        '<button class="dev-stop2" id="m-stop">停止渐强</button>' +
      '</div>' +
      '<button class="dev-emergency" id="m-emergency">急 停（全部归零）</button>' +
      '<button class="dev-test" id="m-test">测试联动（模拟一次情绪指令）</button>' +

      '<div class="dev-sec">语见联动</div>' +
      '<div class="dev-status" id="m-link">还没收到消息</div>' +

      '<div class="dev-sec">AI 单独测试（可选）</div>' +
      '<details class="dev-fold"><summary>展开配置</summary>' +
        '<div class="sock-row"><label>地址</label>' +
        '<input id="ai-url" class="sock-in" placeholder="https://api.deepseek.com/v1" spellcheck="false"></div>' +
        '<div class="sock-row"><label>Key</label>' +
        '<input id="ai-key" class="sock-in" type="password" placeholder="sk-..." spellcheck="false"></div>' +
        '<div class="sock-row"><label>模型</label>' +
        '<input id="ai-model" class="sock-in" placeholder="deepseek-v4-pro" spellcheck="false"></div>' +
        '<div class="row" style="gap:8px"><button class="dev-btn" id="ai-save">保存</button></div>' +
      '</details>' +

      '<div class="dev-sec">指令日志</div>' +
      '<div class="ai-cmd" id="m-cmds"></div>' +
      '<div class="sock-row" style="gap:8px"><button class="dev-btn" id="dev-copylog" style="flex:1">复制日志</button></div>' +
      '<div class="dev-log" id="dev-log" style="max-height:44vh"></div>';

    if ($('dev-copylog')) $('dev-copylog').addEventListener('click', copyLog);
    $('m-modes').querySelectorAll('[data-m]').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.dataset.m); });
    });
    $('view-master').querySelectorAll('.dev-round[data-t]').forEach(function (b) {
      b.addEventListener('click', function () {
        st.target = clamp(st.target + Number(b.dataset.t), 1, 100);
        render();
      });
    });
    $('m-start').addEventListener('click', startAll);
    $('m-stop').addEventListener('click', function () { stopAll(true); });

    /* 渐强目标下拉 */
    var pickBtn = $('m-pick'), pickList = $('m-picklist');
    if (pickBtn && pickList) {
      pickBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        pickList.classList.toggle('show');
      });
      pickList.querySelectorAll('[data-t]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (b.disabled) return;
          st.mTarget = b.dataset.t;
          try { localStorage.setItem('petMTarget', st.mTarget); } catch (e) { }
          pickList.classList.remove('show');
          addLog('渐强目标 → ' + mTargetName());
          render();
        });
      });
      document.addEventListener('click', function (e) {
        if (!pickList.contains(e.target) && e.target !== pickBtn) pickList.classList.remove('show');
      });
      try {
        var savedT = localStorage.getItem('petMTarget');
        if (savedT) st.mTarget = savedT;
      } catch (e) { }
    }

    $('m-test').addEventListener('click', function () {
    addLog('测试：模拟 mood n=6 ch=ab')
    window.PetDevice.onReply('（测试）<<mood n=6 e=测试 ch=ab hold=4000>>');
    });

    $('m-emergency').addEventListener('click', function () {
      stopAll(true);
      stopHardware();
      addLog('急停：全部归零');
    });
    $('ai-save').addEventListener('click', function () {
      st.aiCfg.url = ($('ai-url').value || '').trim();
      st.aiCfg.key = ($('ai-key').value || '').trim();
      st.aiCfg.model = ($('ai-model').value || '').trim();
      try { localStorage.setItem('aiCfg', JSON.stringify(st.aiCfg)); } catch (e) { }
      addLog('AI 配置已保存');
    });
   } catch (e) { try { addLog('[master 绑定失败] ' + e); } catch (x) { } }
  }

  /* ================= 视图切换 ================= */

  function show(id) {
    current = id;
    ['brand', 'dg', 'ycy', 'master'].forEach(function (k) {
      var el = $('view-' + k);
      if (el) el.style.display = (k === id) ? '' : 'none';
    });
    st.slots.forEach(function (s) {
      if (s.root) s.root.style.display = (s.id === id) ? '' : 'none';
    });
    renderTabs();
    render();
  }

  function back() {
    closePanel();
  }

  function openPanel(view) {
    if (view && st.tabs.indexOf(view) < 0) st.tabs.push(view);
    setPanel(true);
    show(view || st.tabs[st.tabs.length - 1] || 'brand');
  }

  // 标签栏常驻主界面；面板只是面板下方的“页面区”，开关它不动标签栏
  function setPanel(on) {
    var p = $('devpanel');
    if (!p) return;
    if (on) p.classList.add('show');
    else p.classList.remove('show');
  }

  function closePanel() {
    hideLoading();
    picking = false;
    setPanel(false);
    current = '';
    renderTabs();
  }

  /* ================= 双滑块 ================= */

  function buildDualRange(box, minS, maxS, lo, hi, onChange) {
    if (!box) return;
    box.innerHTML =
      '<div class="dual">' +
        '<div class="dual-track"><div class="dual-fill"></div></div>' +
        '<input type="range" class="dual-in" data-k="lo" min="' + minS + '" max="' + maxS + '" step="1" value="' + lo + '">' +
        '<input type="range" class="dual-in" data-k="hi" min="' + minS + '" max="' + maxS + '" step="1" value="' + hi + '">' +
        '<div class="dual-val"><span class="lo">' + lo + 's</span><span class="hi">' + hi + 's</span></div>' +
      '</div>';
    var iLo = box.querySelector('[data-k="lo"]');
    var iHi = box.querySelector('[data-k="hi"]');
    var fill = box.querySelector('.dual-fill');
    var sLo = box.querySelector('.dual-val .lo');
    var sHi = box.querySelector('.dual-val .hi');

    function paint() {
      var a = Number(iLo.value), b = Number(iHi.value);
      var span = maxS - minS || 1;
      var pa = (a - minS) / span * 100;
      var pb = (b - minS) / span * 100;
      fill.style.left = pa + '%';
      fill.style.width = (pb - pa) + '%';
      sLo.textContent = a + 's';
      sHi.textContent = b + 's';
      onChange(a, b);
    }
    iLo.addEventListener('input', function () {
      if (Number(iLo.value) > Number(iHi.value)) iLo.value = iHi.value;
      paint();
    });
    iHi.addEventListener('input', function () {
      if (Number(iHi.value) < Number(iLo.value)) iHi.value = iLo.value;
      paint();
    });
    paint();
  }

  /* ================= 调度 ================= */

  function setMode(m) {
    st.mode = m;
    try { localStorage.setItem('petMode', m); } catch (e) { }
    if (window.Scheduler) st.sched = window.Scheduler.create(m);
    var row = $('m-modes');
    if (row) row.querySelectorAll('[data-m]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.m === m);
    });
    var hint = $('m-modehint');
    if (hint) {
      hint.textContent = {
        easy: '简单：1-20，触发快',
        normal: '普通：1-50，开场 60 秒内 ≤20',
        hell: '炼狱：1-100，>50 持续不超过 60 秒'
      }[m] || '';
    }
    addLog('模式：' + ({ easy: '简单', normal: '普通', hell: '炼狱' }[m] || m));
  }

  function askSched(level) {
    if (!st.sched) return level;
    var r = st.sched.request(level, { now: Date.now() });
    if (r.reasons && r.reasons.length) addLog('调度：' + r.reasons.join(' / '));
    return r.blocked ? 0 : r.applied;
  }

  function cyStrength(level) {
    if (level <= 0) return 0;
    return clamp(Math.round(level * st.scale), 1, st.limit);
  }
  function cyFreq(f) { return clamp(Math.round(f), st.frMin, st.frMax); }
  function cyClampSpeed(v) { return clamp(Math.round(v), 0, st.cyMax); }
  function emsOf(level) { return clamp(Math.round(level / 100 * 20), 0, 20); }

  var MT_NAMES = { all: '全部设备', cy: '郊狼', cup: '榨精杯', ems: '电击器' };
  function mTargetName() { return MT_NAMES[st.mTarget] || '全部设备'; }
  function mTargets() {
    var t = st.mTarget || 'all';
    if (t === 'all') return ['cy', 'cup', 'ems'].filter(anyOn);
    return anyOn(t) ? [t] : [];
  }

  function startAll() {
    if (rampTimer) { clearInterval(rampTimer); rampTimer = null; }
    if (!st.sched && window.Scheduler) st.sched = window.Scheduler.create(st.mode);
    var kinds = mTargets();
    if (!kinds.length) {
      addLog(st.mTarget === 'all' ? '没有已连接的设备' : ('「' + mTargetName() + '」还没连上'));
      return;
    }
    /* 郊狼：先把波形频率/强度推下去，否则 B0 帧波形强度为 0 → 设备不出电流（每台各推自己的） */
    if (kinds.indexOf('cy') >= 0) {
      slotsOn('cy').forEach(function (s) {
        try {
          s.api.setPulse(cyFreq(s.d.frA), Math.max(1, s.d.inA), cyFreq(s.d.frB), Math.max(1, s.d.inB));
        } catch (e) { }
      });
    }
    st.running = true;
    var target = clamp(st.target, 1, 100), cur = 0;
    addLog('开始 → ' + mTargetName() + ' 目标 ' + target);

    rampTimer = setInterval(function () {
      if (!st.running) return;
      cur += 2;
      if (cur > target) cur = target;
      var lv = askSched(cur);
      st.applied = lv;

      if (kinds.indexOf('cy') >= 0) {
        var sv = cyClampSpeed(cyStrength(lv));
        slotsOn('cy').forEach(function (s) {
          s.d.cyApl = s.d.cyBpl = sv;
          s.api.setStrength(sv, sv);
        });
      }
      if (kinds.indexOf('cup') >= 0) {
        var sp = clamp(Math.round(lv / 100 * 20), 0, 20);
        slotsOn('cup').forEach(function (s) {
          s.d.cupSpeed = { a: sp, b: sp, c: sp };
          s.api.ycySpeed(sp, sp, sp);
        });
      }
      if (kinds.indexOf('ems') >= 0) {
        slotsOn('ems').forEach(function (s) {
          s.d.emsStrength = emsOf(lv);
          s.api.ycyEmsFixed(s.d.emsStrength, s.d.emsMode);
        });
      }
      render();
      if (cur >= target) {
        clearInterval(rampTimer); rampTimer = null;
        addLog('已到达 ' + target + ' 级');
      }
    }, 400);
  }

  function stopAll(reason) {
    if (rampTimer) { clearInterval(rampTimer); rampTimer = null; }
    st.running = false; st.applied = 0;
    st.slots.forEach(function (s) {
      var d = s.d;
      d.cyApl = d.cyBpl = 0;
      d.cupSpeed = { a: 0, b: 0, c: 0 };
      d.emsStrength = 0;
      try { hardStop(s); } catch (e) { }
    });
    if (reason) addLog('停止：全部归零');
    render();
  }

  /* ================= 语见联动 ================= */

  var TRIGGER_P = { easy: 0.7, normal: 0.5, hell: 0.35 };
  var lastFireAt = 0;

  window.PetDevice = {
    onReply: function (text) {
      if (!text) return;
      var any = false, emo = '';
      var mm = /<<\s*mood\s+([^>]+)>>/i.exec(text);
      if (mm) {
        var kv = {};
        mm[1].trim().split(/\s+/).forEach(function (pair) {
          var p = pair.split('=');
          if (p.length === 2) kv[p[0].toLowerCase()] = p[1];
        });
        var score = clamp(Number(kv.n) || 0, 0, 10);
        emo = kv.e || '';
        any = fireByMood(score, emo, (kv.ch || 'ab').toLowerCase(), Number(kv.hold) || 0);
      addLog('收到 mood n=' + score + ' ch=' + (kv.ch || 'ab') + (any ? ' → 已下发' : ' → 未触发'));
      }
      st.linkCount++;
      st.linkAt = Date.now();
      renderLink();
      if (window.PetEmotion && emo) { try { window.PetEmotion(emo); } catch (e) { } }
      addLog(any ? '语见：已触发' : '语见：未触发');
    }
  };

  /** 通道选择：a=郊狼A / b=郊狼B / ab=两个通道 / yc=杯子 / all=全上（兼容旧 cy / cup / both）。 */
  function parseCh(raw) {
    var s = String(raw || '').toLowerCase().trim();
    if (s === 'a' || s === 'cya') return { a: true, b: false, cup: false };
    if (s === 'b' || s === 'cyb') return { a: false, b: true, cup: false };
    if (s === 'yc' || s === 'cup') return { a: false, b: false, cup: true };
    if (s === 'ab' || s === 'cy' || s === 'ba') return { a: true, b: true, cup: false };
    return { a: true, b: true, cup: true };
  }

  function fireByMood(score, emo, ch, kvHold) {
    if (score <= 0) { report(0, 0, 'mood0', 0); return false; }
    var now = Date.now();
    if (now - lastFireAt < 12000) { addLog('冷却中'); report(0, 0, 'cooldown', 0); return false; }

    var p = st.fireP >= 0.999 ? 1 : st.fireP * (0.55 + score / 10 * 0.45);
    if (Math.random() > p) {
      addLog('概率未中（' + Math.round(p * 100) + '%）');
      report(0, 0, 'roll', 0);
      return false;
    }

    var level = clamp(score * 10, 5, 100);
    var allowed = askSched(level);
    var raw = kvHold > 0 ? kvHold : (1500 + score * 400);
    var holdCy = clamp(raw, st.cyHoldMin, st.cyHoldMax);
    var holdYc = clamp(raw, st.ycHoldMin, st.ycHoldMax);

    var pick = parseCh(ch);
    var cyLv = cyClampSpeed(cyStrength(allowed));
    var cyA = pick.a ? cyLv : 0;
    var cyB = pick.b ? cyLv : 0;
    var cup = pick.cup ? clamp(Math.round(allowed / 100 * 20), 0, 20) : 0;
    var ems = (pick.a || pick.b) ? emsOf(allowed) : 0;

    if (cyA > 0 || cyB > 0) {
      slotsOn('cy').forEach(function (s) {
        s.d.cyApl = cyA; s.d.cyBpl = cyB;
        s.api.setStrengthTimed(cyA, cyB, holdCy);
      });
    }
    if (cup > 0) {
      slotsOn('cup').forEach(function (s) {
        s.d.cupSpeed = { a: cup, b: cup, c: cup };
        s.api.ycySpeedTimed(cup, cup, cup, holdYc);
      });
    }
    if (ems > 0) {
      slotsOn('ems').forEach(function (s) {
        s.d.emsStrength = ems;
        s.api.ycyEmsFixedTimed(ems, s.d.emsMode, holdCy);
      });
    }

    /* 设备失败检测：模型点名要的设备，如果一台都没连上，就记下来回报给语见 */
    var fail = [];
    if ((pick.a || pick.b) && !anyOn('cy')) fail.push('cy');
    if (pick.cup && !anyOn('cup')) fail.push('yc');
    if (fail.length) addLog('设备失败：' + fail.join(',') + '（未连接）');

    st.applied = allowed;
    lastFireAt = now;
    st.aiCmds.unshift(emo + ' ' + score + '/10 · ' + ch + ' → A ' + cyA + ' · B ' + cyB + ' · 杯 ' + cup + ' · 电 ' + ems + (fail.length ? ' ⚠' + fail.join(',') : ''));
    if (st.aiCmds.length > 8) st.aiCmds.pop();
    renderCmds(); render();
    report(Math.max(cyA, cyB), cup, emo + score + '|' + ch + (fail.length ? '|fail:' + fail.join(',') : ''), ems);
    return true;
  }

  /** 小游戏奖惩入口：kind = punish / reward，level 0-276，ms 毫秒 */
  window.PetGameAction = function (kind, level, ms, mask) {
    if (!level || level <= 0) return;
    var pct = clamp(level / 276, 0, 1);
    var level100 = Math.round(pct * 100);
    var allowed = askSched(level100);
    var hold = clamp(ms || 3000, 500, 60000);

    if (typeof mask !== 'number') mask = 7;
    var cy = (mask & 1) ? clamp(Math.round(cyStrength(allowed)), 0, st.cyMax) : 0;
    var cup = (mask & 2) ? clamp(Math.round(allowed / 100 * 20), 0, 20) : 0;
    var ems = (mask & 4) ? clamp(Math.round(allowed / 100 * 276), 0, 276) : 0;

    if (cy > 0) {
      slotsOn('cy').forEach(function (s) {
        s.d.cyApl = s.d.cyBpl = cy;
        s.api.setStrengthTimed(cy, cy, hold);
      });
    }
    if (cup > 0) {
      slotsOn('cup').forEach(function (s) {
        s.d.cupSpeed = { a: cup, b: cup, c: cup };
        s.api.ycySpeedTimed(cup, cup, cup, hold);
      });
    }
    if (ems > 0) {
      slotsOn('ems').forEach(function (s) {
        s.d.emsStrength = ems;
        s.api.ycyEmsFixed(ems, s.d.emsMode);
        setTimeout(function () {
          s.api.ycyEmsFixed(0, s.d.emsMode);
          s.d.emsStrength = 0;
          render();
        }, hold);
      });
    }

    var used = [];
    if (cy > 0 && anyOn('cy')) used.push('郊狼');
    if (cup > 0 && anyOn('cup')) used.push('杯');
    if (ems > 0 && anyOn('ems')) used.push('电');
    addLog((kind === 'punish' ? '惩罚' : '奖励') + ' ' + allowed + ' 级 · ' +
      Math.round(hold / 1000) + 's' + (used.length ? ' · ' + used.join('+') : ' · 无设备'));
    render();
  };

  /** 小游戏顶栏的名字：同类只有一台时用旧名字（和 0.103 一样），多台才带编号 */
  function devName(kind, slot) { return slot.title; }

  /** 供小游戏等界面查询「当前已连接设备 + 实时数值」，未连接的不返回 */
  window.PetDevStatus = function () {
    var out = [];
    slotsOn('cy').forEach(function (s) {
      out.push({
        k: 'cy', name: devName('cy', s), a: s.d.cyApl || 0, b: s.d.cyBpl || 0,
        v: 'A' + (s.d.cyApl || 0) + ' B' + (s.d.cyBpl || 0)
      });
    });
    slotsOn('cup').forEach(function (s) {
      var c = s.d.cupSpeed || { a: 0, b: 0, c: 0 };
      out.push({
        k: 'cup', name: devName('cup', s), a: c.a || 0, b: c.b || 0,
        v: (c.a || 0) + '/' + (c.b || 0) + '/' + (c.c || 0)
      });
    });
    slotsOn('ems').forEach(function (s) {
      out.push({ k: 'ems', name: devName('ems', s), a: s.d.emsStrength || 0, b: 0, v: String(s.d.emsStrength || 0) });
    });
    return out;
  };

  function report(cy, cup, note, ems) {
    try {
      if (window.Coyote && window.Coyote.petReport) {
        window.Coyote.petReport(JSON.stringify({ cy: cy, yc: cup, note: note || '', ems: ems || 0 }));
      }
    } catch (e) { }
  }

  /* ================= 渲染 ================= */

  /** 跟随核对：逐级设定强度，看设备 B1 回报是否跟着变——不接触身体也能证明固件真的收下了 */
  function rampCheck() {
    if (!window.Coyote) { addLog('跟随核对：原生接口不可用'); return; }
    var cs = slotsOn('cy');
    if (!cs.length) { addLog('跟随核对：还没有郊狼标签'); return; }
    var steps = [5, 10, 20, 30];
    var i = 0;
    addLog('===== 跟随核对：A 从 5 逐级升到 30（每级 1.5 秒）=====');
    addLog('看下面 "通知 ← B1 .." 行的第 3 个字节，应该跟着 05 → 0A → 14 → 1E 变化');
    (function next() {
      if (i >= steps.length) { addLog('===== 跟随核对结束 ====='); return; }
      var v = steps[i++];
      cs.forEach(function (s) {
        s.d.cyA = v;
        s.d.cyApl = v;
        s.api.setStrength(v, s.d.cyB || 0);
      });
      addLog('设定 A=' + v + '（设备等级）');
      setTimeout(next, 1500);
    })();
  }

  /* 任何 JS 异常都写进指令日志，方便在手机上定位 */
  window.onerror = function (msg, src, line) {
    try { addLog('[JS 错误] ' + msg + ' @' + line); } catch (e) { }
  };
  window.addEventListener('unhandledrejection', function (e) {
    try { addLog('[JS 异常] ' + (e && e.reason ? e.reason : e)); } catch (err) { }
  });

  function addLog(s) {
    if (/扫描结束|停止扫描|扫描完成/.test(s)) hideLoading();
    logs.push(s);
    if (logs.length > 300) logs.shift();
    var el = $('dev-log');
    if (!el) return;
    // 只有原本就在底部时才自动跟随；用户往上翻就不要再把他拽下来
    var atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 16;
    var d = document.createElement('div');
    d.textContent = s;
    el.appendChild(d);
    while (el.children.length > 200) el.removeChild(el.firstChild);
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  /** 把日志整段复制到剪贴板，方便贴给我看（截图截不全十几行） */
  function copyLog() {
    var text = logs.join('\n');
    if (!text) { addLog('还没有日志'); return; }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      addLog('日志已复制（' + logs.length + ' 行），粘贴出来即可');
    } catch (e) {
      addLog('复制失败：' + e.message);
    }
  }

  function renderCmds() {
    var el = $('m-cmds');
    if (!el) return;
    el.innerHTML = st.aiCmds.length
      ? st.aiCmds.map(function (x) { return '<div>' + esc(x) + '</div>'; }).join('')
      : '<div class="dev-empty">还没有指令</div>';
  }

  function renderLink() {
    var el = $('m-link');
    if (!el) return;
    if (!st.linkAt) {
      el.textContent = '还没收到消息（语见顶栏点「联动」）';
      el.className = 'dev-status';
      return;
    }
    var sec = Math.round((Date.now() - st.linkAt) / 1000);
    el.textContent = '正常 · 最近 ' + (sec < 60 ? sec + ' 秒前' : Math.round(sec / 60) + ' 分钟前') +
      ' · 累计 ' + st.linkCount + ' 轮';
    el.className = 'dev-status on';
  }

  /** 总控台一行文字：一台时保持 0.103 的措辞，多台时带编号 */
  function lineOf(kind, one, many) {
    var list = slotsOn(kind);
    if (!list.length) return '未连接';
    if (list.length === 1) return one(list[0].d);
    return list.map(many).join(' ｜ ');
  }

  function renderMaster() {
    var t = $('m-target'); if (t) t.textContent = st.target;
    var a = $('m-applied'); if (a) a.textContent = '实际 ' + st.applied;

    var lb = $('m-pick-label');
    if (lb) lb.textContent = '目标：' + mTargetName();
    var pl = $('m-picklist');
    if (pl) {
      var av = {
        all: true,
        cy: anyOn('cy'), cup: anyOn('cup'), ems: anyOn('ems')
      };
      pl.querySelectorAll('[data-t]').forEach(function (b) {
        var k = b.dataset.t;
        b.disabled = !av[k];
        b.classList.toggle('on', k === st.mTarget);
      });
    }

    var mcy = $('m-cy');
    if (mcy) {
      mcy.textContent = '郊狼：' + lineOf('cy', function (d) {
        return '已连接' + (d.cyBattery >= 0 ? ' · ' + d.cyBattery + '%' : '') +
          (d.cyFirmware ? ' · ' + d.cyFirmware : '');
      }, function (s) {
        return s.title + ' ' + (s.d.cyBattery >= 0 ? s.d.cyBattery + '%' : '已连接');
      });
      mcy.className = 'dev-status' + (anyOn('cy') ? ' on' : '');
    }
    var mcup = $('m-cup');
    if (mcup) {
      mcup.textContent = '榨精杯：' + lineOf('cup', function (d) {
        var cs = d.cupSpeed, live = cs.a || cs.b || cs.c;
        return '已连接' + (live ? ' · A' + cs.a + ' B' + cs.b + ' C' + cs.c : ' · 待机');
      }, function (s) {
        var cs = s.d.cupSpeed, live = cs.a || cs.b || cs.c;
        return s.title + (live ? ' A' + cs.a + ' B' + cs.b + ' C' + cs.c : ' 待机');
      });
      mcup.className = 'dev-status' + (anyOn('cup') ? ' on' : '');
    }
    var mems = $('m-ems');
    if (mems) {
      mems.textContent = '电击器：' + lineOf('ems', function (d) {
        return '已连接' + (d.emsBattery >= 0 ? ' · ' + d.emsBattery + '%' : '') +
          (d.emsStrength ? ' · 强度 ' + d.emsStrength : ' · 待机');
      }, function (s) {
        return s.title + (s.d.emsStrength ? ' 强度 ' + s.d.emsStrength : ' 待机');
      });
      mems.className = 'dev-status' + (anyOn('ems') ? ' on' : '');
    }
  }

  /** 单台设备页：状态行 + 杯滑条 + 模式信息（只查这个槽位自己的 DOM） */
  function renderSlot(slot) {
    if (!slot || !slot.root) return;
    withRoot(slot.root, function () {
      var d = slot.d;
      var cs = $('cy-status');
      if (cs) {
        cs.textContent = d.cyOn
          ? ('已连接 ' + (d.cyName || '') + (d.cyBattery >= 0 ? ' · ' + d.cyBattery + '%' : '') +
             (d.cyFirmware ? ' · ' + d.cyFirmware : ''))
          : '未连接';
        cs.className = 'dev-status' + (d.cyOn ? ' on' : '');
      }
      var cus = $('cup-status');
      if (cus) {
        cus.textContent = d.cupOn ? ('已连接' + (d.cupBattery >= 0 ? ' · 电量 ' + d.cupBattery + '%' : '')) : '未连接';
        cus.className = 'dev-status' + (d.cupOn ? ' on' : '');
      }
      var es = $('ems-status');
      if (es) {
        es.textContent = d.emsOn
          ? ('已连接 ' + (d.emsName || '') +
             (d.emsBattery >= 0 ? ' · 电量 ' + d.emsBattery + '%' : '') +
             (d.emsLink >= 0 ? ' · 通道 ' + d.emsLink : '') +
             (d.emsChStrength ? ' · 回传 ' + d.emsChStrength : ''))
          : '未连接';
        es.className = 'dev-status' + (d.emsOn ? ' on' : '');
      }
      var dg = $('ems-diag');
      if (dg) {
        dg.innerHTML =
          '写入 ' + (d.emsWriteOk || 0) + ' / 拒 ' + (d.emsWriteFail || 0) +
          (d.emsLastNotify ? '<br>收到 ' + esc(d.emsLastNotify) : '') +
          (d.emsServices ? '<br>服务 ' + esc(d.emsServices) : '');
      }
    });
    syncCupSliders(slot);
    renderCupMotors(slot);
  }

  function render() {
    renderMaster();
    st.slots.forEach(renderSlot);
  }

  function renderList(slot) {
    if (!slot || !slot.root) return;
    var el = q(slot.root)(slot.kind + '-list');
    if (!el) return;
    var arr = slot.devices || [];
    if (!arr.length) { el.innerHTML = '<div class="dev-empty">还没有设备</div>'; return; }
    el.innerHTML = arr.map(function (d, i) {
      return '<button class="dev-item" data-i="' + i + '">' + esc(d.name || '(未命名)') +
        '<i>' + esc(d.address) + (typeof d.rssi === 'number' ? '  ' + d.rssi + 'dBm' : '') + '</i></button>';
    }).join('');
    el.querySelectorAll('[data-i]').forEach(function (b) {
      b.addEventListener('click', function () {
        var d = arr[Number(b.dataset.i)];
        if (!d) return;
        if (slot.kind === 'cy') slot.api.connect(d.address);
        else if (slot.kind === 'cup') slot.api.ycyConnect(d.address);
        else slot.api.emsConnect(d.address);
      });
    });
  }

  function syncCupSliders(slot) {
    if (!slot) return;
    var d = slot.d, $r = q(slot.root);
    ['a', 'b', 'c'].forEach(function (k) {
      var sl = $r('cup-' + k), out = $r('cup-' + k + 'v');
      var v = (d.cupSpeed && d.cupSpeed[k]) || 0;
      if (sl && Number(sl.value) !== v) sl.value = v;
      if (out) out.textContent = v;
    });
  }

  function renderCupMotors(slot) {
    if (!slot) return;
    var el = q(slot.root)('cup-motors');
    if (!el) return;
    var m = slot.d.cupModes || { a: 0, b: 0, c: 0 };
    if (!m.a && !m.b && !m.c) {
      el.innerHTML = '<div class="dev-hint">连接后自动读取设备信息（型号 / 三路模式数 / 电量）。</div>';
      return;
    }
    el.innerHTML = '<div class="dev-info">A 旋转 ' + m.a + ' 模式 · B 真空 ' + m.b + ' 模式 · C 内胆振动 ' + m.c
      + ' 模式（硬件坏，本机不响应）</div>';
  }

  /* ================= 持久化 ================= */

  function saveLimits() {
    try {
      localStorage.setItem('petLimits', JSON.stringify({
        cyHoldMin: st.cyHoldMin, cyHoldMax: st.cyHoldMax,
        ycHoldMin: st.ycHoldMin, ycHoldMax: st.ycHoldMax,
        cyMax: st.cyMax, frMin: st.frMin, frMax: st.frMax,
        scale: st.scale, fireP: st.fireP, limit: st.limit
      }));
    } catch (e) { }
  }

  function loadLimits() {
    try {
      var o = JSON.parse(localStorage.getItem('petLimits') || '{}');
      if (o.cyHoldMin) st.cyHoldMin = o.cyHoldMin;
      if (o.cyHoldMax) st.cyHoldMax = o.cyHoldMax;
      if (o.ycHoldMin) st.ycHoldMin = o.ycHoldMin;
      if (o.ycHoldMax) st.ycHoldMax = o.ycHoldMax;
      if (o.cyMax) st.cyMax = o.cyMax;
      if (o.frMin) st.frMin = o.frMin;
      if (typeof o.scale === 'number' && o.scale >= 0.1 && o.scale <= 1) st.scale = o.scale;
      if (typeof o.fireP === 'number' && o.fireP >= 0.1 && o.fireP <= 1) st.fireP = o.fireP;
      if (typeof o.limit === 'number' && o.limit >= 5 && o.limit <= 100) st.limit = o.limit;
      if (o.frMax) st.frMax = o.frMax;
    } catch (e) { }
  }

  function saveMac(slot, mac) {
    try { localStorage.setItem(macKey(slot), mac || ''); } catch (e) { }
  }

  /* ================= 原生回调 ================= */

  window.CoyoteDev = {
    onDevices: function (x) {
      // 新原生：{slot, pool, devices}；旧原生兼容：直接就是数组
      if (Array.isArray(x)) { var s0 = slotsOf('cy')[0]; if (s0) mergeDevices(s0, x); return; }
      var slot = slotByIndex('cy', x && x.slot);
      if (slot) mergeDevices(slot, x.devices || []);
    },
    onState: function (s) {
      var slot = slotByIndex('cy', s && s.slot);
      if (!slot) return;                       // 对应标签已关掉，丢掉这条回报
      var d = slot.d, was = d.cyOn;
      if (typeof s.connected === 'boolean') d.cyOn = s.connected;
      if (typeof s.name === 'string') d.cyName = s.name;
      if (typeof s.address === 'string') d.cyAddr = s.address;
      if (typeof s.battery === 'number') d.cyBattery = s.battery;
      if (typeof s.limitA === 'number') st.limit = s.limitA;   // 安全上限仍共用
      if (typeof s.firmware === 'string' && s.firmware) d.cyFirmware = s.firmware;
      if (!was && d.cyOn) {
        saveMac(slot, d.cyAddr);
        addLog(slot.index === 0 ? '郊狼已连接' : slot.title + ' 已连接');
      }
      if (was && !d.cyOn) addLog(slot.index === 0 ? '郊狼断开' : slot.title + ' 断开');
      renderSlot(slot); renderMaster();
    },
    onLog: function (line) { addLog(line); }
  };

  window.YcyDev = {
    onDevices: function (x) {
      var arr = Array.isArray(x) ? x : ((x && x.devices) || []);
      var idx = (x && typeof x.slot === 'number') ? x.slot : 0;
      (arr || []).forEach(function (d) {
        var kind;
        if (x && (x.pool === 'cup' || x.pool === 'ems')) kind = x.pool;
        else if (typeof d.dev === 'number') kind = d.dev === 1 ? 'ems' : 'cup';
        else kind = st.scanning === 'ems' ? 'ems' : 'cup';
        var slot = slotByIndex(kind, idx);
        if (slot) mergeDevices(slot, [d]);
      });
    },
    onState: function (s) {
      if (!s) return;
      var kind = (s.pool === 'cup' || s.pool === 'ems') ? s.pool : (s.dev === 1 ? 'ems' : 'cup');
      var slot = slotByIndex(kind, s.slot);
      if (!slot) return;
      var d = slot.d, isEms = kind === 'ems';
      var was = isEms ? d.emsOn : d.cupOn;
      var on = !!s.connected;
      if (isEms) d.emsOn = on; else d.cupOn = on;
      if (isEms) {
        if (typeof s.name === 'string') d.emsName = s.name;
        if (typeof s.address === 'string') d.emsAddr = s.address;
        if (typeof s.battery === 'number' && s.battery >= 0) d.emsBattery = s.battery;
      } else {
        if (typeof s.name === 'string') d.cupName = s.name;
        if (typeof s.address === 'string') d.cupAddr = s.address;
        if (typeof s.battery === 'number') d.cupBattery = s.battery;
        if (typeof s.modesA === 'number') d.cupModes.a = s.modesA;
        if (typeof s.modesB === 'number') d.cupModes.b = s.modesB;
        if (typeof s.modesC === 'number') d.cupModes.c = s.modesC;
        if (typeof s.a === 'number') d.cupSpeed.a = s.a;
        if (typeof s.b === 'number') d.cupSpeed.b = s.b;
        if (typeof s.c === 'number') d.cupSpeed.c = s.c;
      }
      if (typeof s.emsStrength === 'number') d.emsStrength = s.emsStrength;
      if (typeof s.chLink === 'number') d.emsLink = s.chLink;
      if (typeof s.chStrength === 'number') d.emsChStrength = s.chStrength;
      if (typeof s.services === 'string' && s.services) d.emsServices = s.services;
      if (typeof s.channel === 'number') { d.emsCh = s.channel; if (slot.paintChannels) slot.paintChannels(); }
      if (typeof s.lastNotify === 'string' && s.lastNotify) d.emsLastNotify = s.lastNotify;
      if (typeof s.writeOk === 'number') d.emsWriteOk = s.writeOk;
      if (typeof s.writeFail === 'number') d.emsWriteFail = s.writeFail;
      if (!was && on) {
        var a = (d.emsAddr || d.cupAddr || '').toUpperCase();
        if (a) saveMac(slot, a);
        addLog(slot.index === 0 ? (isEms ? '电击器已连接' : '榨精杯已连接') : slot.title + ' 已连接');
      }
      if (was && !on) addLog(slot.index === 0 ? '役次元断开' : slot.title + ' 断开');
      renderSlot(slot); renderMaster();
    },
    onLog: function (line) { addLog(line); }
  };

  function mergeDevices(slot, arr) {
    if (!slot) return;
    var target = slot.devices, added = false;
    (arr || []).forEach(function (d) {
      var idx = -1;
      for (var i = 0; i < target.length; i++) if (target[i].address === d.address) { idx = i; break; }
      if (idx < 0) { target.push(d); added = true; }
      else if (typeof d.rssi === 'number') target[idx].rssi = d.rssi;
    });
    if (!added) return;
    target.sort(function (p, q) { return (q.rssi || -999) - (p.rssi || -999); });
    if (listTimer[slot.id]) return;
    listTimer[slot.id] = setTimeout(function () { listTimer[slot.id] = null; renderList(slot); }, 250);
  }

  /* ================= 启动 ================= */

  /* 0.104：MAC 输入框改成每台设备各自绑定（bindMac），见各设备视图构建函数 */

  function boot() {
    buildHome();
    buildPanel();

    try {
      var pm = localStorage.getItem('petMode');
      setMode(pm && ['easy', 'normal', 'hell'].indexOf(pm) >= 0 ? pm : 'easy');
      var ac = localStorage.getItem('aiCfg');
      if (ac) {
        st.aiCfg = JSON.parse(ac);
        if ($('ai-url')) $('ai-url').value = st.aiCfg.url || '';
        if ($('ai-key')) $('ai-key').value = st.aiCfg.key || '';
        if ($('ai-model')) $('ai-model').value = st.aiCfg.model || '';
      }
    } catch (e) { setMode('easy'); }

    show('brand');
    renderCmds();
    renderLink();
    setInterval(renderLink, 3000);
    render();
    addLog('就绪：点右上 ＋ 选设备（同类可以加多台）');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
