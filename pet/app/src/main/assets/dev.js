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
    scale: 0.2, limit: 20,
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
    scanning: 'cup',
    linkCount: 0, linkAt: 0,
    aiCmds: []
  };

  var logs = [], rampTimer = null, listTimer = {};
  var current = 'brand';

  function $(id) { return document.getElementById(id); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ================= 主界面 ================= */

  function buildHome() {
    var master = document.createElement('button');
    master.id = 'btn-master';
    master.className = 'btn-master';
    master.textContent = '总 控';
    master.style.top = 'calc(14px + env(safe-area-inset-top))';
    master.style.bottom = 'auto';
    master.addEventListener('click', function () { openPanel('master'); });
    document.body.appendChild(master);

    var load = document.createElement('div');
    load.id = 'loading-chibi';
    load.className = 'loading-chibi';
    load.innerHTML =
      '<img src="art-chibi.webp" alt="">' +
      '<div class="load-shadow"></div>' +
      '<div class="load-text" id="load-text">扫描中…</div>';
    document.body.appendChild(load);

    var zap = document.createElement('button');
    zap.id = 'btn-zap';
    zap.className = 'home-fab';
    zap.style.top = 'calc(14px + env(safe-area-inset-top))';
    zap.textContent = '⚡';
    zap.addEventListener('click', function () { openPanel('brand'); });
    document.body.appendChild(zap);
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
    var mask = document.createElement('div');
    mask.id = 'devmask';
    mask.className = 'devmask';
    mask.addEventListener('click', closePanel);
    document.body.appendChild(mask);

    var p = document.createElement('div');
    p.id = 'devpanel';
    p.className = 'devpanel';
    p.innerHTML =
      '<div class="dev-head">' +
        '<button id="dev-back" class="dev-back">‹</button>' +
        '<span id="dev-title">设备</span>' +
        '<button id="dev-close" class="dev-x">收起</button>' +
      '</div>' +
      '<div class="dev-view" id="view-brand"></div>' +
      '<div class="dev-view" id="view-dg" style="display:none"></div>' +
      '<div class="dev-view" id="view-ycy" style="display:none"></div>' +
      '<div class="dev-view" id="view-coyote" style="display:none"></div>' +
      '<div class="dev-view" id="view-cup" style="display:none"></div>' +
      '<div class="dev-view" id="view-ems" style="display:none"></div>' +
      '<div class="dev-view" id="view-master" style="display:none"></div>';
    document.body.appendChild(p);

    $('dev-close').addEventListener('click', closePanel);
    $('dev-back').addEventListener('click', back);

    buildBrandView();
    buildDgView();
    buildYcyView();
    buildCoyoteView();
    buildCupView();
    buildEmsView();
    buildMasterView();
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
      b.addEventListener('click', function () { if (b.dataset.b === 'coyote') show('coyote'); });
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
        if (k === 'cup') show('cup');
        else if (k === 'ems') show('ems');
      });
    });
  }

  /* ---------------- 郊狼 ---------------- */

  function buildCoyoteView() {
    $('view-coyote').innerHTML =
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
      '<div class="sock-row"><label>频率 A</label>' +
      '<input type="range" id="cy-frA" min="10" max="240" step="1" value="60" style="flex:1">' +
      '<span class="dbg-val" id="cy-frAv">60</span></div>' +
      '<div class="sock-row"><label>强度 A</label>' +
      '<input type="range" id="cy-inA" min="0" max="100" step="1" value="20" style="flex:1">' +
      '<span class="dbg-val" id="cy-inAv">20</span></div>' +
      '<button class="dev-emergency sm" id="cy-stopall">停 止 输 出</button>' +
      '<button class="dev-reset" id="cy-reset">重 置 郊 狼</button>';

    $('cy-auto').addEventListener('click', function () {
      if (!window.Coyote) return;
      st.cyDevices = []; renderList('cy');
      showLoading('识别中…');
      window.Coyote.autoFind(); addLog('郊狼自动识别…');
    });
    $('cy-scan').addEventListener('click', function () {
      if (!window.Coyote) return;
      st.cyDevices = []; renderList('cy');
      showLoading('扫描中…');
      window.Coyote.scan(); addLog('扫描郊狼…');
    });
    $('cy-disc').addEventListener('click', function () {
      if (window.Coyote) { window.Coyote.stopScan(); window.Coyote.disconnect(); }
    });
    $('cy-macgo').addEventListener('click', function () {
      var mac = ($('cy-mac').value || '').trim().toUpperCase();
      if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac)) { addLog('MAC 格式不对'); return; }
      saveMac('cy', mac);
      if (window.Coyote) window.Coyote.connect(mac);
    });
    ['cy-a', 'cy-b'].forEach(function () {
      $('cy-a').addEventListener('input', function () {
        st.cyA = Number($('cy-a').value);
        st.cyB = Number($('cy-b').value);
        $('cy-av').textContent = st.cyA;
        $('cy-bv').textContent = st.cyB;
        if (window.Coyote) window.Coyote.setStrength(cyStrength(st.cyA), cyStrength(st.cyB));
      });
    });
    ['cy-frA', 'cy-inA'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        st.frA = Number($('cy-frA').value);
        st.inA = Number($('cy-inA').value);
        $('cy-frAv').textContent = st.frA;
        $('cy-inAv').textContent = st.inA;
        if (window.Coyote) window.Coyote.setPulse(cyFreq(st.frA), st.inA, cyFreq(st.frA), st.inA);
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
    buildDualRange('cy-range', 4, 60, st.cyHoldMin / 1000, st.cyHoldMax / 1000, function (lo, hi) {
      st.cyHoldMin = lo * 1000; st.cyHoldMax = hi * 1000; saveLimits();
    });
    $('cy-stopall').addEventListener('click', function () {
      st.cyA = st.cyB = 0; st.cyApl = st.cyBpl = 0;
      $('cy-a').value = 0; $('cy-b').value = 0;
      $('cy-av').textContent = '0'; $('cy-bv').textContent = '0';
      if (window.Coyote) window.Coyote.emergencyStop();
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
      if (window.Coyote) { window.Coyote.emergencyStop(); window.Coyote.setPulse(60, 20, 60, 20); }
      saveLimits(); addLog('郊狼已重置'); render();
    });
  }

  /* ---------------- 榨精杯 ---------------- */

  function buildCupView() {
    $('view-cup').innerHTML =
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
      '<div class="dev-sec">限位</div>' +
      '<div class="sock-row"><label>输出时长</label><div id="cup-range" style="flex:1"></div></div>' +
      '<div class="dev-sec">手动力度</div>' +
      '<div class="sock-row"><label>力度</label>' +
      '<input type="range" id="cup-manual" min="0" max="20" step="1" value="0" style="flex:1">' +
      '<span class="dbg-val" id="cup-manualv">0</span></div>' +
      '<button class="dev-emergency sm" id="cup-stopall">停 止 输 出</button>' +
      '<button class="dev-reset" id="cup-reset">重 置 榨 精 杯</button>';

    $('cup-scan').addEventListener('click', function () {
      if (!window.Coyote) return;
      st.cupDevices = []; renderList('cup');
      st.scanning = 'cup';
      showLoading('扫描中…');
      window.Coyote.ycyScan(); addLog('扫描役次元…');
    });
    $('cup-scanall').addEventListener('click', function () {
      if (!window.Coyote) return;
      st.cupDevices = []; renderList('cup');
      st.scanning = 'cup';
      showLoading('扫描中…');
      window.Coyote.ycyScanAll(); addLog('扫描全部…');
    });
    $('cup-disc').addEventListener('click', function () {
      if (window.Coyote) { window.Coyote.ycyStopScan(); window.Coyote.ycyDisconnect(); }
    });
    $('cup-macgo').addEventListener('click', function () {
      var mac = ($('cup-mac').value || '').trim().toUpperCase();
      if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac)) { addLog('MAC 格式不对'); return; }
      saveMac('cup', mac);
      if (window.Coyote) { window.Coyote.ycyDevType(0); window.Coyote.ycyConnect(mac); }
    });
    $('cup-manual').addEventListener('input', function () {
      var v = Number(this.value);
      $('cup-manualv').textContent = v;
      st.cupSpeed = { a: v, b: v, c: v };
      if (window.Coyote) window.Coyote.ycySpeed(v, v, v);
    });
    buildDualRange('cup-range', 4, 60, st.ycHoldMin / 1000, st.ycHoldMax / 1000, function (lo, hi) {
      st.ycHoldMin = lo * 1000; st.ycHoldMax = hi * 1000; saveLimits();
    });
    $('cup-stopall').addEventListener('click', function () {
      st.cupSpeed = { a: 0, b: 0, c: 0 };
      $('cup-manual').value = 0; $('cup-manualv').textContent = '0';
      if (window.Coyote) window.Coyote.ycyStop();
      addLog('榨精杯已停止输出');
      render();
    });

    $('cup-reset').addEventListener('click', function () {
      st.cupSpeed = { a: 0, b: 0, c: 0 };
      $('cup-manual').value = 0; $('cup-manualv').textContent = '0';
      if (window.Coyote) { window.Coyote.ycyStop(); window.Coyote.ycySpeed(0, 0, 0); }
      addLog('榨精杯已重置'); renderCupMotors(); render();
    });
  }

  /* ---------------- 电击器 ---------------- */

  function buildEmsView() {
    $('view-ems').innerHTML =
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
      '<div class="dev-hint" style="margin:0 0 10px" id="ems-hint2">A 口走主通道（FF30），B 口走备用通道（AE00）。当前只在 A 口验证到放电。</div>' +

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
      st.emsDevices = []; renderList('ems');
      st.scanning = 'ems';
      showLoading('扫描中…');
      window.Coyote.emsScan(false); addLog('扫描电击器…');
    });
    $('ems-scanall').addEventListener('click', function () {
      if (!window.Coyote) return;
      st.emsDevices = []; renderList('ems');
      st.scanning = 'ems';
      showLoading('扫描中…');
      window.Coyote.emsScan(true); addLog('扫描全部…');
    });
    $('ems-disc').addEventListener('click', function () {
      if (window.Coyote) { window.Coyote.emsStopScan(); window.Coyote.emsDisconnect(); }
    });
    $('ems-macgo').addEventListener('click', function () {
      var mac = ($('ems-mac').value || '').trim().toUpperCase();
      if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac)) { addLog('MAC 格式不对'); return; }
      saveMac('ems', mac);
      if (window.Coyote) window.Coyote.emsConnect(mac);
    });
    ['ems-str', 'ems-mode', 'ems-freq', 'ems-pulse'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        var v = $(id + 'v');
        if (v) v.textContent = this.value;
      });
    });
    $('ems-send').addEventListener('click', function () {
      var s = Number($('ems-str').value), m = Number($('ems-mode').value);
      if (window.Coyote) window.Coyote.ycyEmsFixed(s, m);
      $('ems-hint').textContent = '已发固定：强度 ' + s + ' 模式 ' + m;
      addLog('EMS 固定 ' + s + '/' + m);
    });
    $('ems-zerob').addEventListener('change', function () {
      if (window.Coyote) window.Coyote.emsZeroB(this.checked);
      try { localStorage.setItem('emsZeroB', this.checked ? '1' : '0'); } catch (e) { }
      addLog(this.checked ? '停止时也写 B：开' : '停止时也写 B：关（更安全）');
    });

    $('ems-bfollow').addEventListener('change', function () {
      if (window.Coyote) window.Coyote.emsBFollow(this.checked);
      try { localStorage.setItem('emsBFollow', this.checked ? '1' : '0'); } catch (e) { }
      addLog(this.checked ? 'B 跟随 A：开' : 'B 跟随 A：关');
    });

    $('ems-burstb').addEventListener('click', function () {
      var s = Number($('ems-str').value), m = Number($('ems-mode').value);
      if (window.Coyote) window.Coyote.emsBurstB(s, m, 3000);
      addLog('B 口连发：强度 ' + s + ' 模式 ' + m + '（3 秒自动停）');
    });
    $('ems-sendreal').addEventListener('click', function () {
      var s = Number($('ems-str').value);
      var f = Number($('ems-freq').value);
      var p = Number($('ems-pulse').value);
      if (window.Coyote) window.Coyote.ycyEmsReal(s, f, p);
      $('ems-hint').textContent = '已发实时：' + s + ' / ' + f + 'Hz / 脉冲 ' + p;
      addLog('EMS 实时 ' + s + '/' + f + '/' + p);
    });
    $('view-ems').querySelectorAll('[data-port]').forEach(function (b) {
      b.addEventListener('click', function () {
        var idx = Number(b.dataset.port);
        st.emsCh = idx;
        try { localStorage.setItem('emsCh', String(idx)); } catch (e) { }
        if (window.Coyote) window.Coyote.emsChannel(idx);
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
      if (window.Coyote) window.Coyote.emsDual(this.checked);
      try { localStorage.setItem('emsDual', this.checked ? '1' : '0'); } catch (e) { }
      addLog(this.checked ? '双通道：开' : '双通道：关');
    });

    $('view-ems').querySelectorAll('[data-hex]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.dataset.hex;
        $('ems-hex').value = v;
        if (window.Coyote) window.Coyote.emsRaw(v);
        addLog('预置发送 ' + v);
      });
    });

    $('ems-raw').addEventListener('click', function () {
      var v = ($('ems-hex').value || '').trim();
      if (!v) return;
      if (window.Coyote) window.Coyote.emsRaw(v);
      addLog('原始：' + v);
    });

    $('ems-chan-a').addEventListener('click', function () {
      if (window.Coyote) window.Coyote.emsChanTest(1, 5);
      $('ems-chan-hint').textContent = '已发：A 口 强度 5（4 秒自动停）';
      addLog('通道协议 A 口 强度1');
    });
    $('ems-chan-b').addEventListener('click', function () {
      if (window.Coyote) window.Coyote.emsChanTest(2, 5);
      $('ems-chan-hint').textContent = '已发：B 口 强度 5（4 秒自动停）';
      addLog('通道协议 B 口 强度1');
    });
    $('ems-chan-stop').addEventListener('click', function () {
      if (window.Coyote) window.Coyote.emsChanStop();
      $('ems-chan-hint').textContent = '已发停止帧';
      addLog('通道协议停止');
    });

    $('ems-stopall').addEventListener('click', function () {
      st.emsStrength = 0;
      $('ems-str').value = 0; $('ems-strv').textContent = '0';
      if (window.Coyote) window.Coyote.emsStop();
      addLog('电击器已停止输出');
      render();
    });

    $('ems-reset').addEventListener('click', function () {
      st.emsStrength = 0;
      $('ems-str').value = 0; $('ems-strv').textContent = '0';
      if (window.Coyote) window.Coyote.ycyEmsFixed(0, Number($('ems-mode').value));
      addLog('电击器已重置'); render();
    });
  }

  /* ---------------- 总控台 ---------------- */

  function buildMasterView() {
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
      '<div class="dev-hint" style="margin:0 0 8px">从 0 逐级升到这个等级，再按模式上限封顶。急停会立刻把所有设备归零。</div>' +
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
      '<div class="dev-log" id="dev-log"></div>';

    $('m-modes').querySelectorAll('[data-m]').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.dataset.m); });
    });
    $('view-master').querySelectorAll('[data-t]').forEach(function (b) {
      b.addEventListener('click', function () {
        st.target = clamp(st.target + Number(b.dataset.t), 1, 100);
        render();
      });
    });
    $('m-start').addEventListener('click', startAll);
    $('m-stop').addEventListener('click', function () { stopAll(true); });
    $('m-test').addEventListener('click', function () {
      addLog('测试：模拟 mood n=6 ch=both');
      window.PetDevice.onReply('（测试）<<mood n=6 e=测试 ch=both hold=4000>>');
    });

    $('m-emergency').addEventListener('click', function () {
      stopAll(true);
      try {
        if (window.Coyote) { window.Coyote.emergencyStop(); window.Coyote.ycyStop(); window.Coyote.emsStop(); }
      } catch (e) { }
      addLog('急停：全部归零');
    });
    $('ai-save').addEventListener('click', function () {
      st.aiCfg.url = ($('ai-url').value || '').trim();
      st.aiCfg.key = ($('ai-key').value || '').trim();
      st.aiCfg.model = ($('ai-model').value || '').trim();
      try { localStorage.setItem('aiCfg', JSON.stringify(st.aiCfg)); } catch (e) { }
      addLog('AI 配置已保存');
    });
  }

  /* ================= 视图切换 ================= */

  function show(name) {
    current = name;
    ['brand', 'dg', 'ycy', 'coyote', 'cup', 'ems', 'master'].forEach(function (k) {
      var el = $('view-' + k);
      if (el) el.style.display = (k === name) ? '' : 'none';
    });
    var title = {
      brand: '设备', dg: 'DG-LAB', ycy: '役次元',
      coyote: '郊狼', cup: '榨精杯', ems: '电击器二代', master: '总控台'
    }[name] || '设备';
    var t = $('dev-title');
    if (t) t.textContent = title;
    var back = $('dev-back');
    if (back) back.style.visibility = (name === 'brand') ? 'hidden' : 'visible';
    render();
  }

  function back() {
    if (current === 'coyote') return show('dg');
    if (current === 'cup' || current === 'ems') return show('ycy');
    if (current === 'dg' || current === 'ycy') return show('brand');
    closePanel();
  }

  function openPanel(view) {
    var p = $('devpanel'), m = $('devmask');
    if (p) p.classList.add('show');
    if (m) m.classList.add('show');
    show(view || 'brand');
  }

  function closePanel() {
    hideLoading();
    var p = $('devpanel'), m = $('devmask');
    if (p) p.classList.remove('show');
    if (m) m.classList.remove('show');
  }

  /* ================= 双滑块 ================= */

  function buildDualRange(containerId, minS, maxS, lo, hi, onChange) {
    var box = $(containerId);
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

  function startAll() {
    if (rampTimer) { clearInterval(rampTimer); rampTimer = null; }
    if (!st.cyOn && !st.cupOn && !st.emsOn) { addLog('没有已连接的设备'); return; }
    st.running = true;
    var target = clamp(st.target, 1, 100), cur = 0;
    addLog('开始 → 目标 ' + target);

    rampTimer = setInterval(function () {
      if (!st.running) return;
      cur += 2;
      if (cur > target) cur = target;
      var lv = askSched(cur);
      st.applied = lv;

      if (st.cyOn && window.Coyote) {
        var s = cyClampSpeed(cyStrength(lv));
        st.cyApl = st.cyBpl = s;
        window.Coyote.setStrength(s, s);
      }
      if (st.cupOn && window.Coyote) {
        var sp = clamp(Math.round(lv / 100 * 20), 0, 20);
        st.cupSpeed = { a: sp, b: sp, c: sp };
        window.Coyote.ycySpeed(sp, sp, sp);
      }
      if (st.emsOn && window.Coyote) {
        st.emsStrength = emsOf(lv);
        window.Coyote.ycyEmsFixed(st.emsStrength, st.emsMode);
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
    st.cyApl = st.cyBpl = 0;
    st.cupSpeed = { a: 0, b: 0, c: 0 };
    st.emsStrength = 0;
    if (window.Coyote) { window.Coyote.emergencyStop(); window.Coyote.ycyStop(); window.Coyote.emsStop(); }
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
        any = fireByMood(score, emo, (kv.ch || 'both').toLowerCase(), Number(kv.hold) || 0);
      }
      st.linkCount++;
      st.linkAt = Date.now();
      renderLink();
      if (window.PetEmotion && emo) { try { window.PetEmotion(emo); } catch (e) { } }
      addLog(any ? '语见：已触发' : '语见：未触发');
    }
  };

  function fireByMood(score, emo, ch, kvHold) {
    if (score <= 0) { report(0, 0, 'mood0', 0); return false; }
    var now = Date.now();
    if (now - lastFireAt < 12000) { addLog('冷却中'); report(0, 0, 'cooldown', 0); return false; }

    var p = (TRIGGER_P[st.mode] || 0.5) * (0.4 + score / 10 * 0.9);
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

    var cy = (ch === 'cy' || ch === 'both') ? cyClampSpeed(cyStrength(allowed)) : 0;
    var cup = (ch === 'yc' || ch === 'both') ? clamp(Math.round(allowed / 100 * 20), 0, 20) : 0;
    var ems = (ch === 'cy' || ch === 'both') ? emsOf(allowed) : 0;

    if (st.cyOn && window.Coyote && cy > 0) {
      st.cyApl = st.cyBpl = cy;
      window.Coyote.setStrengthTimed(cy, cy, holdCy);
    }
    if (st.cupOn && window.Coyote && cup > 0) {
      st.cupSpeed = { a: cup, b: cup, c: cup };
      window.Coyote.ycySpeedTimed(cup, cup, cup, holdYc);
    }
    if (st.emsOn && window.Coyote && ems > 0) {
      st.emsStrength = ems;
      window.Coyote.ycyEmsFixedTimed(ems, st.emsMode, holdCy);
    }

    st.applied = allowed;
    lastFireAt = now;
    st.aiCmds.unshift(emo + ' ' + score + '/10 → 郊狼 ' + cy + ' · 杯 ' + cup + ' · 电 ' + ems);
    if (st.aiCmds.length > 8) st.aiCmds.pop();
    renderCmds(); render();
    report(cy, cup, emo + score, ems);
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

    if (st.cyOn && window.Coyote && cy > 0) {
      st.cyApl = st.cyBpl = cy;
      window.Coyote.setStrengthTimed(cy, cy, hold);
    }
    if (st.cupOn && window.Coyote && cup > 0) {
      st.cupSpeed = { a: cup, b: cup, c: cup };
      window.Coyote.ycySpeedTimed(cup, cup, cup, hold);
    }
    if (st.emsOn && window.Coyote && ems > 0) {
      st.emsStrength = ems;
      window.Coyote.ycyEmsFixed(ems, st.emsMode);
      setTimeout(function () {
        if (st.emsOn && window.Coyote) window.Coyote.ycyEmsFixed(0, st.emsMode);
        st.emsStrength = 0; render();
      }, hold);
    }

    var used = [];
    if (cy > 0 && st.cyOn) used.push('郊狼');
    if (cup > 0 && st.cupOn) used.push('杯');
    if (ems > 0 && st.emsOn) used.push('电');
    addLog((kind === 'punish' ? '惩罚' : '奖励') + ' ' + allowed + ' 级 · ' +
      Math.round(hold / 1000) + 's' + (used.length ? ' · ' + used.join('+') : ' · 无设备'));
    render();
  };

  function report(cy, cup, note, ems) {
    try {
      if (window.Coyote && window.Coyote.petReport) {
        window.Coyote.petReport(JSON.stringify({ cy: cy, yc: cup, note: note || '', ems: ems || 0 }));
      }
    } catch (e) { }
  }

  /* ================= 渲染 ================= */

  function addLog(s) {
    if (/扫描结束|停止扫描|扫描完成/.test(s)) hideLoading();
    logs.push(s);
    if (logs.length > 80) logs.shift();
    var el = $('dev-log');
    if (el) {
      el.innerHTML = logs.slice(-8).map(function (x) { return '<div>' + esc(x) + '</div>'; }).join('');
      el.scrollTop = el.scrollHeight;
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

  function render() {
    var t = $('m-target'); if (t) t.textContent = st.target;
    var a = $('m-applied'); if (a) a.textContent = '实际 ' + st.applied;

    var mcy = $('m-cy');
    if (mcy) {
      mcy.textContent = '郊狼：' + (st.cyOn ? ('已连接' +
        (st.cyBattery >= 0 ? ' · ' + st.cyBattery + '%' : '') +
        (st.cyFirmware ? ' · ' + st.cyFirmware : '')) : '未连接');
      mcy.className = 'dev-status' + (st.cyOn ? ' on' : '');
    }
    var mcup = $('m-cup');
    if (mcup) {
      mcup.textContent = '榨精杯：' + (st.cupOn ? ('已连接' + (st.cupSpeed.a ? ' · 力度 ' + st.cupSpeed.a : ' · 待机')) : '未连接');
      mcup.className = 'dev-status' + (st.cupOn ? ' on' : '');
    }
    var mems = $('m-ems');
    if (mems) {
      mems.textContent = '电击器：' + (st.emsOn
        ? ('已连接' + (st.emsBattery >= 0 ? ' · ' + st.emsBattery + '%' : '') + (st.emsStrength ? ' · 强度 ' + st.emsStrength : ' · 待机'))
        : '未连接');
      mems.className = 'dev-status' + (st.emsOn ? ' on' : '');
    }

    var cs = $('cy-status');
    if (cs) {
      cs.textContent = st.cyOn
        ? ('已连接 ' + (st.cyName || '') + (st.cyBattery >= 0 ? ' · ' + st.cyBattery + '%' : '') +
           (st.cyFirmware ? ' · ' + st.cyFirmware : ''))
        : '未连接';
      cs.className = 'dev-status' + (st.cyOn ? ' on' : '');
    }
    var cus = $('cup-status');
    if (cus) {
      cus.textContent = st.cupOn ? ('已连接' + (st.cupBattery >= 0 ? ' · 电量 ' + st.cupBattery + '%' : '')) : '未连接';
      cus.className = 'dev-status' + (st.cupOn ? ' on' : '');
    }
    var es = $('ems-status');
    if (es) {
      es.textContent = st.emsOn
        ? ('已连接 ' + (st.emsName || '') +
           (st.emsBattery >= 0 ? ' · 电量 ' + st.emsBattery + '%' : '') +
           (st.emsLink >= 0 ? ' · 通道 ' + st.emsLink : '') +
           (st.emsChStrength ? ' · 回传 ' + st.emsChStrength : ''))
        : '未连接';
      es.className = 'dev-status' + (st.emsOn ? ' on' : '');
    }
  }

  function renderList(kind) {
    var el = $(kind + '-list');
    if (!el) return;
    var arr = kind === 'cy' ? st.cyDevices : (kind === 'cup' ? st.cupDevices : st.emsDevices);
    if (!arr.length) { el.innerHTML = '<div class="dev-empty">还没有设备</div>'; return; }
    el.innerHTML = arr.map(function (d, i) {
      return '<button class="dev-item" data-i="' + i + '">' + esc(d.name || '(未命名)') +
        '<i>' + esc(d.address) + (typeof d.rssi === 'number' ? '  ' + d.rssi + 'dBm' : '') + '</i></button>';
    }).join('');
    el.querySelectorAll('[data-i]').forEach(function (b) {
      b.addEventListener('click', function () {
        var d = arr[Number(b.dataset.i)];
        if (!d || !window.Coyote) return;
        if (kind === 'cy') window.Coyote.connect(d.address);
        else if (kind === 'cup') window.Coyote.ycyConnect(d.address);
        else window.Coyote.emsConnect(d.address);
      });
    });
  }

  function renderCupMotors() {
    var el = $('cup-motors');
    if (!el) return;
    var html = '';
    ['a', 'b', 'c'].forEach(function (k) {
      var n = st.cupModes[k];
      if (!n) return;
      html += '<div class="dev-sec">马达 ' + k.toUpperCase() + '（' + n + ' 模式）</div>' +
        '<div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:8px">' +
        '<button class="dev-btn small" data-motor="' + k + '" data-mode="0">关</button>';
      for (var m = 1; m <= n; m++) {
        html += '<button class="dev-btn small" data-motor="' + k + '" data-mode="' + m + '">' + m + '</button>';
      }
      html += '</div>';
    });
    el.innerHTML = html || '<div class="dev-hint">连接后自动读取马达信息。</div>';
    el.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        var motor = b.dataset.motor, mode = Number(b.dataset.mode);
        var mask = motor === 'a' ? 1 : (motor === 'b' ? 2 : 4);
        if (window.Coyote) window.Coyote.ycyMode(mask, mode);
        addLog('马达 ' + motor.toUpperCase() + ' 模式 ' + mode);
      });
    });
  }

  /* ================= 持久化 ================= */

  function saveLimits() {
    try {
      localStorage.setItem('petLimits', JSON.stringify({
        cyHoldMin: st.cyHoldMin, cyHoldMax: st.cyHoldMax,
        ycHoldMin: st.ycHoldMin, ycHoldMax: st.ycHoldMax,
        cyMax: st.cyMax, frMin: st.frMin, frMax: st.frMax
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
      if (o.frMax) st.frMax = o.frMax;
    } catch (e) { }
  }

  function saveMac(kind, mac) {
    try { localStorage.setItem(kind + 'Mac', mac || ''); } catch (e) { }
  }

  /* ================= 原生回调 ================= */

  window.CoyoteDev = {
    onDevices: function (arr) { mergeDevices(st.cyDevices, arr, 'cy'); },
    onState: function (s) {
      var was = st.cyOn;
      if (typeof s.connected === 'boolean') st.cyOn = s.connected;
      if (typeof s.name === 'string') st.cyName = s.name;
      if (typeof s.address === 'string') st.cyAddr = s.address;
      if (typeof s.battery === 'number') st.cyBattery = s.battery;
      if (typeof s.limitA === 'number') st.limit = s.limitA;
      if (typeof s.firmware === 'string' && s.firmware) st.cyFirmware = s.firmware;
      if (!was && st.cyOn) { saveMac('cy', st.cyAddr); addLog('郊狼已连接'); }
      if (was && !st.cyOn) addLog('郊狼断开');
      render();
    },
    onLog: function (line) { addLog(line); }
  };

  window.YcyDev = {
    onDevices: function (arr) {
      (arr || []).forEach(function (d) {
        var kind;
        if (typeof d.dev === 'number') kind = d.dev === 1 ? 'ems' : 'cup';
        else kind = st.scanning === 'ems' ? 'ems' : 'cup';
        mergeDevices(kind === 'ems' ? st.emsDevices : st.cupDevices, [d], kind);
      });
    },
    onState: function (s) {
      var isEms = s.dev === 1;
      var was = isEms ? st.emsOn : st.cupOn;
      var on = !!s.connected;
      if (isEms) st.emsOn = on; else st.cupOn = on;
      if (isEms) {
        if (typeof s.name === 'string') st.emsName = s.name;
        if (typeof s.address === 'string') st.emsAddr = s.address;
        if (typeof s.battery === 'number' && s.battery >= 0) st.emsBattery = s.battery;
      } else {
        if (typeof s.name === 'string') st.cupName = s.name;
        if (typeof s.address === 'string') st.cupAddr = s.address;
        if (typeof s.battery === 'number') st.cupBattery = s.battery;
        if (typeof s.modesA === 'number') st.cupModes.a = s.modesA;
        if (typeof s.modesB === 'number') st.cupModes.b = s.modesB;
        if (typeof s.modesC === 'number') st.cupModes.c = s.modesC;
        if (typeof s.a === 'number') st.cupSpeed.a = s.a;
        if (typeof s.b === 'number') st.cupSpeed.b = s.b;
        if (typeof s.c === 'number') st.cupSpeed.c = s.c;
      }
      if (typeof s.emsStrength === 'number') st.emsStrength = s.emsStrength;
      if (typeof s.chLink === 'number') st.emsLink = s.chLink;
      if (typeof s.chStrength === 'number') st.emsChStrength = s.chStrength;
      if (typeof s.services === 'string' && s.services) st.emsServices = s.services;
      if (typeof s.channel === 'number') { st.emsCh = s.channel; paintChannels(); }
      if (typeof s.lastNotify === 'string' && s.lastNotify) st.emsLastNotify = s.lastNotify;
      if (typeof s.writeOk === 'number') st.emsWriteOk = s.writeOk;
      if (typeof s.writeFail === 'number') st.emsWriteFail = s.writeFail;
      var dg = $('ems-diag');
      if (dg) {
        dg.innerHTML =
          '写入 ' + (st.emsWriteOk || 0) + ' / 拒 ' + (st.emsWriteFail || 0) +
          (st.emsLastNotify ? '<br>收到 ' + esc(st.emsLastNotify) : '') +
          (st.emsServices ? '<br>服务 ' + esc(st.emsServices) : '');
      }
      if (!was && on) {
        var a = (st.emsAddr || st.cupAddr || '').toUpperCase();
        if (a) saveMac(isEms ? 'ems' : 'cup', a);
        addLog(isEms ? '电击器已连接' : '榨精杯已连接');
      }
      if (was && !on) addLog('役次元断开');
      renderCupMotors();
      render();
    },
    onLog: function (line) { addLog(line); }
  };

  function mergeDevices(target, arr, kind) {
    var added = false;
    (arr || []).forEach(function (d) {
      var idx = -1;
      for (var i = 0; i < target.length; i++) if (target[i].address === d.address) { idx = i; break; }
      if (idx < 0) { target.push(d); added = true; }
      else if (typeof d.rssi === 'number') target[idx].rssi = d.rssi;
    });
    if (!added) return;
    target.sort(function (p, q) { return (q.rssi || -999) - (p.rssi || -999); });
    if (listTimer[kind]) return;
    listTimer[kind] = setTimeout(function () { listTimer[kind] = null; renderList(kind); }, 250);
  }

  /* ================= 启动 ================= */

  function bindMacPersist() {
    [['cy-mac', 'cy'], ['cup-mac', 'cup'], ['ems-mac', 'ems']].forEach(function (pair) {
      var el = $(pair[0]);
      if (!el) return;
      var save = function () { saveMac(pair[1], (el.value || '').trim().toUpperCase()); };
      el.addEventListener('input', save);
      el.addEventListener('change', save);
      el.addEventListener('blur', save);
    });
  }

  function boot() {
    buildHome();
    buildPanel();
    bindMacPersist();
    loadLimits();

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
      var cm = localStorage.getItem('cyMac');
      if (cm && $('cy-mac')) $('cy-mac').value = cm;
      var cupm = localStorage.getItem('cupMac');
      if (cupm && $('cup-mac')) $('cup-mac').value = cupm;
      var emsm = localStorage.getItem('emsMac');
      if (emsm && $('ems-mac')) $('ems-mac').value = emsm;
    } catch (e) { setMode('easy'); }

    show('brand');
    renderList('cy'); renderList('cup'); renderList('ems');
    renderCupMotors();
    renderCmds();
    renderLink();
    setInterval(renderLink, 3000);
    render();
    addLog('就绪：右上 ⚡ 选设备，总控开始输出');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
