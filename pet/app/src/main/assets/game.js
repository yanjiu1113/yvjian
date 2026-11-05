/* 跳一跳 —— 长按蓄力，松开起跳 */
(function () {
  'use strict';

  var overlay, canvas, ctx, foxImg;
  var W = 0, H = 0, dpr = 1;
  var running = false, raf = 0;

  var G = {
    x: 0,              // 狐狸所在平台索引
    score: 0,
    best: 0,
    camX: 0,
    platforms: [],
    fox: { x: 0, y: 0, vy: 0, jumping: false, rot: 0 },
    chargeStart: 0,
    charging: false,
    power: 0,
    jumping: false,
    jumpFrom: 0,
    jumpTo: 0,
    jumpT: 0,
    jumpDur: 0,
    jumpArc: 0,
    dead: false,
    falling: false, fallVy: 0, fallRot: 0
  };

  var GROUND_Y = 0;      // 平台顶面 y
  var PLAT_H = 26;

  function $(id) { return document.getElementById(id); }

  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

  var DEFAULT_LOSE = [
    '噗——杂鱼就是杂鱼呢～',
    '就这？我还以为你能行',
    '诶～又摔了？好笨哦',
    '这么简单都做不到，杂鱼～',
    '掉下去的样子真可爱呢，再来一次给我看',
    '果然是杂鱼，连这都跳不过去'
  ];

  var DEFAULT_WIN = [
    '诶～居然跳过去了？运气好吧',
    '哼，勉强算你及格',
    '杂鱼偶尔也会走运呢～',
    '这点程度，不是理所当然的吗？',
    '哇哦，居然没掉下去，好意外',
    '别得意，下一跳就要摔了哦'
  ];

  var CFG = {
    pStr: 30, pDur: 5, rStr: 20, rDur: 3, sfx: true,
    pDev: { cy: true, cup: true, ems: true },
    rDev: { cy: true, cup: true, ems: true },
    winLines: DEFAULT_WIN.slice(),
    loseLines: DEFAULT_LOSE.slice()
  };

  function maskOf(o) {
    return (o.cy ? 1 : 0) | (o.cup ? 2 : 0) | (o.ems ? 4 : 0);
  }

  /* ---------- 合成音效 ---------- */
  var AC = null;

  function audio() {
    if (!CFG.sfx) return null;
    try {
      if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
      if (AC.state === 'suspended') AC.resume();
      return AC;
    } catch (e) { return null; }
  }

  function tone(f0, f1, dur, type, vol) {
    var ac = audio();
    if (!ac) return;
    var o = ac.createOscillator();
    var g = ac.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, ac.currentTime);
    if (f1 && f1 !== f0) {
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), ac.currentTime + dur);
    }
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(vol || 0.12, ac.currentTime + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + dur + 0.02);
  }

  function sfxJump() { tone(300, 760, 0.13, 'triangle', 0.09); }
  function sfxLand() { tone(120, 70, 0.08, 'sine', 0.10); }
  function sfxFail() {
    tone(420, 80, 0.55, 'sawtooth', 0.08);
    setTimeout(function () { tone(180, 60, 0.35, 'triangle', 0.07); }, 120);
  }
  function sfxWin() { tone(660, 990, 0.16, 'sine', 0.07); }

  function loadCfg() {
    try {
      var o = JSON.parse(localStorage.getItem('jumpCfg') || '{}');
      if (o.pStr != null) CFG.pStr = o.pStr;
      if (o.pDur != null) CFG.pDur = o.pDur;
      if (o.rStr != null) CFG.rStr = o.rStr;
      if (o.rDur != null) CFG.rDur = o.rDur;
      if (typeof o.sfx === 'boolean') CFG.sfx = o.sfx;
      if (o.pDev) CFG.pDev = { cy: !!o.pDev.cy, cup: !!o.pDev.cup, ems: !!o.pDev.ems };
      if (o.rDev) CFG.rDev = { cy: !!o.rDev.cy, cup: !!o.rDev.cup, ems: !!o.rDev.ems };
      if (Array.isArray(o.winLines) && o.winLines.length) CFG.winLines = o.winLines;
      if (Array.isArray(o.loseLines) && o.loseLines.length) CFG.loseLines = o.loseLines;
    } catch (e) { }
  }

  function saveCfg() {
    try { localStorage.setItem('jumpCfg', JSON.stringify(CFG)); } catch (e) { }
  }

  var LINES = {
    start: ['开始了，别掉下去哦', '准备好，我先跳', '看好了'],
    good: ['嗯，不错', '这一跳漂亮', '稳', '有点意思', '再来', '就这样'],
    great: ['哇，好厉害', '连着来！', '你手很稳嘛', '停不下来了'],
    fail: ['啊…掉下去了', '疼不疼', '差一点', '再来一次嘛', '我不笑你']
  };

  /** 让狐狸说一句（外部也可以调用） */
  function say(text, ms) {
    if (!text) return;
    if (window.PetSay) window.PetSay(text, ms || 2200);
  }

  function rightmostEdge() {
    var max = -1e9;
    for (var i = 0; i < G.platforms.length; i++) {
      var r = G.platforms[i].x + G.platforms[i].w;
      if (r > max) max = r;
    }
    return max;
  }

  function randPlatform(prevRight) {
    var w = 58 + Math.random() * 42;        // 58-100
    var gap = 56 + Math.random() * 74;      // 56-130，保证看得见缝隙
    return { x: prevRight + gap, w: w, h: PLAT_H };
  }

  function reset() {
    if (happyEl) happyEl.classList.remove('show');
    if (deathEl) deathEl.classList.remove('show');
    G.platforms = [];
    var first = { x: -20, w: 110, h: PLAT_H };
    G.platforms.push(first);
    G.platforms.push(randPlatform(rightmostEdge()));
    G.platforms.push(randPlatform(rightmostEdge()));
    G.x = 0;
    G.score = 0;
    G.camX = 0;
    G.dead = false;
    G.charging = false;
    G.power = 0;
    G.jumping = false;
    G.falling = false;
    G.fallVy = 0;
    placeFoxOn(G.x);
    say(pick(LINES.start), 2400);
  }

  function placeFoxOn(i) {
    var p = G.platforms[i];
    G.fox.x = p.x + p.w / 2;
    G.fox.y = GROUND_Y;
    G.fox.rot = 0;
  }

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    GROUND_Y = Math.round(H * 0.58);
  }

  function targetCam() {
    var want = G.fox.x - W * 0.32;
    return Math.max(0, want);
  }

  function drawRoundRect(x, y, w, h, r) {
    ctx.beginPath();
    var rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // 背景渐变
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(20,24,34,0.0)');
    g.addColorStop(1, 'rgba(10,12,18,0.35)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    var cam = G.camX;

    // 平台
    for (var i = 0; i < G.platforms.length; i++) {
      var p = G.platforms[i];
      var sx = p.x - cam;
      if (sx > W + 80 || sx + p.w < -80) continue;
      ctx.fillStyle = i === G.x ? 'rgba(255,209,102,0.92)' : 'rgba(210,86,78,0.75)';
      drawRoundRect(sx, GROUND_Y, p.w, p.h, 8);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      drawRoundRect(sx, GROUND_Y, p.w, 6, 6);
      ctx.fill();
    }

    // 蓄力条
    if (G.charging) {
      var pw = Math.min(1, G.power / 1200);
      var bx = 24, by = H - 92, bw = W - 48;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      drawRoundRect(bx, by, bw, 10, 5);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,160,120,0.95)';
      drawRoundRect(bx, by, bw * pw, 10, 5);
      ctx.fill();
    }

    // 狐狸
    var fx = G.fox.x - cam;
    var fy = G.fox.y;
    ctx.save();
    ctx.translate(fx, fy);
    ctx.rotate(G.fox.rot);
    if (foxImg && foxImg.complete) {
      var size = 54;
      ctx.drawImage(foxImg, -size / 2, -size, size, size * 1.05);
    } else {
      ctx.fillStyle = '#ff8a80';
      ctx.beginPath();
      ctx.arc(0, -26, 22, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 分数
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '600 34px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(G.score), W / 2, 92);
    ctx.font = '400 12px -apple-system, "PingFang SC", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText('最高 ' + G.best, W / 2, 114);
  }

  function tick(ts) {
    if (!running) return;

    // 相机平滑跟随
    G.camX += (targetCam() - G.camX) * 0.12;

    if (G.falling) {
      G.fallVy += 1.9;
      G.fox.y += G.fallVy;
      G.fox.rot += 0.14;
      if (G.fox.y > H + 160) G.falling = false;
      draw();
      raf = requestAnimationFrame(tick);
      return;
    }

    if (G.jumping) {
      G.jumpT += 16 / G.jumpDur;
      var t = Math.min(1, G.jumpT);
      var fromP = G.platforms[G.x];
      var toP = G.platforms[G.x + 1];
      if (!toP) toP = fromP;
      var x0 = fromP.x + fromP.w / 2;
      var x1 = G.jumpTo;
      G.fox.x = x0 + (x1 - x0) * t;
      G.fox.y = GROUND_Y - Math.sin(t * Math.PI) * G.jumpArc;
      G.fox.rot = t * Math.PI * 2;

      if (t >= 1) {
        land();
      }
    } else if (!G.dead) {
      placeFoxOn(G.x);
    }

    draw();
    raf = requestAnimationFrame(tick);
  }

  function land() {
    G.jumping = false;
    G.fox.rot = 0;
    sfxLand();
    var next = G.platforms[G.x + 1];
    var cx = G.fox.x;

    if (next && cx >= next.x - 6 && cx <= next.x + next.w + 6) {
      G.x++;
      G.score++;
      if (G.score > G.best) {
        G.best = G.score;
        try { localStorage.setItem('jumpBest', String(G.best)); } catch (e) { }
      }
      G.platforms.push(randPlatform(rightmostEdge()));
      if (G.platforms.length > 8) {
        G.platforms.shift();
        G.x--;
      }
      placeFoxOn(G.x);
      showHappy();
      showHappy(pickLine('win'));
      if (G.score % 5 === 0) {
        sfxWin();
        if (window.PetEmotion) window.PetEmotion('excited');
        if (window.PetGameAction) {
          window.PetGameAction('reward', CFG.rStr, CFG.rDur * 1000, maskOf(CFG.rDev));
        }
      }
      if (window.PetGameEvent) window.PetGameEvent('score', G.score);
    } else {
      G.dead = true;
      sfxFail();
      G.falling = true;
      G.fallVy = 2.4;
      setTimeout(function () {
        if (!running) return;
        showDeath(pickLine('lose'));
      }, 420);
      if (window.PetGameEvent) window.PetGameEvent('fail', G.score);
      if (window.PetGameAction) {
        window.PetGameAction('punish', CFG.pStr, CFG.pDur * 1000, maskOf(CFG.pDev));
      }
      setTimeout(function () {
        if (!running) return;
        reset();
      }, 1700);
    }
  }

  var deathEl = null, deathTimer = null;
  var happyEl = null, happyTimer = null;

  function pickLine(kind) {
    var arr = kind === 'win' ? CFG.winLines : CFG.loseLines;
    if (!arr || !arr.length) return '';
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function showHappy(text) {
    if (!happyEl) return;
    var tx = happyEl.querySelector('.happy-text');
    if (tx) {
      tx.textContent = text || '';
      tx.style.display = text ? '' : 'none';
    }
    happyEl.classList.remove('show');
    void happyEl.offsetWidth;
    happyEl.classList.add('show');
    if (happyTimer) clearTimeout(happyTimer);
    happyTimer = setTimeout(function () { happyEl.classList.remove('show'); }, 900);
  }

  function showDeath(text) {
    if (!deathEl) return;
    deathEl.innerHTML =
      '<img class="death-chibi" src="art-death.webp" alt="">' +
      '<div class="death-text">' + text + '</div>';
    deathEl.classList.add('show');
    if (window.PetEmotion) { try { window.PetEmotion('angry'); } catch (e) { } }
    if (window.PetSay) { try { window.PetSay(text, 2600); } catch (e) { } }
    if (deathTimer) clearTimeout(deathTimer);
    deathTimer = setTimeout(function () {
      deathEl.classList.remove('show');
    }, 1800);
  }

  function press() {
    if (!running || G.dead || G.jumping) return;
    G.charging = true;
    G.chargeStart = Date.now();
    G.power = 0;
    var t = setInterval(function () {
      if (!G.charging) { clearInterval(t); return; }
      G.power = Math.min(1200, Date.now() - G.chargeStart);
    }, 30);
    G.chargeTimer = t;
  }

  function release() {
    if (!running || !G.charging) return;
    G.charging = false;
    if (G.chargeTimer) { clearInterval(G.chargeTimer); G.chargeTimer = null; }

    var next = G.platforms[G.x + 1];
    if (!next) return;

    var dist = 70 + (G.power / 1200) * 190;     // 70 - 260
    G.jumpFrom = G.fox.x;
    G.jumpTo = G.fox.x + dist;
    G.jumpT = 0;
    G.jumpDur = 480;
    G.jumpArc = 62 + (G.power / 1200) * 46;
    G.jumping = true;
    sfxJump();
  }

  function bindCfg() {
    loadCfg();
    var box = overlay.querySelector('#game-cfg');
    var gear = overlay.querySelector('#game-gear');

    function sync() {
      overlay.querySelector('#cfg-pstr').value = CFG.pStr;
      overlay.querySelector('#cfg-pstrv').textContent = CFG.pStr;
      overlay.querySelector('#cfg-pdur').value = CFG.pDur;
      overlay.querySelector('#cfg-pdurv').textContent = CFG.pDur + 's';
      overlay.querySelector('#cfg-rstr').value = CFG.rStr;
      overlay.querySelector('#cfg-rstrv').textContent = CFG.rStr;
      overlay.querySelector('#cfg-rdur').value = CFG.rDur;
      overlay.querySelector('#cfg-rdurv').textContent = CFG.rDur + 's';
      overlay.querySelector('#cfg-sfx').checked = !!CFG.sfx;
    }

    gear.addEventListener('click', function () { box.classList.toggle('show'); });

    var map = [
      ['cfg-pstr', 'pStr', function (v) { return v; }, function (v) { return v; }],
      ['cfg-pdur', 'pDur', function (v) { return v; }, function (v) { return v + 's'; }],
      ['cfg-rstr', 'rStr', function (v) { return v; }, function (v) { return v; }],
      ['cfg-rdur', 'rDur', function (v) { return v; }, function (v) { return v + 's'; }]
    ];
    map.forEach(function (m) {
      var el = overlay.querySelector('#' + m[0]);
      var out = overlay.querySelector('#' + m[0] + 'v');
      el.addEventListener('input', function () {
        CFG[m[1]] = Number(el.value);
        out.textContent = m[3](Number(el.value));
        saveCfg();
      });
    });

    function renderLines() {
      ['win', 'lose'].forEach(function (kind) {
        var box = overlay.querySelector('#lines-' + kind);
        if (!box) return;
        var arr = kind === 'win' ? CFG.winLines : CFG.loseLines;
        box.innerHTML = arr.map(function (t, i) {
          return '<div class="line-row"><span>' + t + '</span>' +
            '<button class="del" data-k="' + kind + '" data-i="' + i + '">×</button></div>';
        }).join('') || '<div class="line-empty">（空，失败时不出台词）</div>';
        box.querySelectorAll('.del').forEach(function (b) {
          b.addEventListener('click', function () {
            var a = b.dataset.k === 'win' ? CFG.winLines : CFG.loseLines;
            a.splice(Number(b.dataset.i), 1);
            saveCfg(); renderLines();
          });
        });
      });
    }

    function syncPick() {
      overlay.querySelectorAll('.pick').forEach(function (b) {
        var grp = b.dataset.g === 'r' ? CFG.rDev : CFG.pDev;
        b.classList.toggle('on', !!grp[b.dataset.k]);
      });
    }

    overlay.querySelectorAll('.pick').forEach(function (b) {
      b.addEventListener('click', function () {
        var grp = b.dataset.g === 'r' ? CFG.rDev : CFG.pDev;
        grp[b.dataset.k] = !grp[b.dataset.k];
        b.classList.toggle('on', grp[b.dataset.k]);
        saveCfg();
      });
    });

    var cb = overlay.querySelector('#cfg-sfx');
    cb.addEventListener('change', function () {
      CFG.sfx = cb.checked;
      saveCfg();
      if (CFG.sfx) sfxLand();
    });

    overlay.querySelectorAll('[data-add]').forEach(function (b) {
      b.addEventListener('click', function () {
        var kind = b.dataset.add;
        var t = prompt(kind === 'win' ? '新的成功台词' : '新的失败台词');
        if (!t) return;
        (kind === 'win' ? CFG.winLines : CFG.loseLines).push(t.trim());
        saveCfg();
        renderLines();
      });
    });

    var rb = overlay.querySelector('#lines-reset');
    if (rb) rb.addEventListener('click', function () {
      CFG.winLines = DEFAULT_WIN.slice();
      CFG.loseLines = DEFAULT_LOSE.slice();
      saveCfg();
      renderLines();
    });

    renderLines();
    sync();
    syncPick();
  }

  function bindInput() {
    canvas.addEventListener('touchstart', function (e) { e.preventDefault(); press(); }, { passive: false });
    canvas.addEventListener('touchend', function (e) { e.preventDefault(); release(); }, { passive: false });
    canvas.addEventListener('touchcancel', function () { release(); });
    canvas.addEventListener('mousedown', function (e) { e.preventDefault(); press(); });
    canvas.addEventListener('mouseup', function () { release(); });
    window.addEventListener('resize', function () { if (running) resize(); });
  }

  function open() {
    if (!overlay) return;
    overlay.classList.add('show');
    running = true;
    resize();
    G.best = Number(localStorage.getItem('jumpBest') || 0);
    reset();
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function close() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (overlay) overlay.classList.remove('show');
  }

  function init() {
    overlay = document.createElement('div');
    overlay.id = 'game-overlay';
    overlay.className = 'game-overlay';
    overlay.innerHTML =
      '<div class="game-bg" id="game-bg"></div>' +
      '<div class="game-clouds"></div>' +
      '<div class="game-shade"></div>' +
      '<canvas id="game-canvas"></canvas>' +
      '<div class="game-top">' +
        '<button id="game-close" class="game-btn">退出</button>' +
      '</div>' +
      '<div class="game-tip">按住屏幕蓄力，松开起跳</div>' +
      '<button id="game-gear" class="game-gear">⚙</button>' +
      '<div id="death-layer" class="death-layer"></div>' +
      '<div id="happy-layer" class="happy-layer"><img src="art-happy.webp" alt="">' +
        '<div class="happy-text"></div></div>' +
      '<div id="game-cfg" class="game-cfg">' +
        '<h4>小游戏设置</h4>' +
        '<div class="cfg-row"><label>惩罚力度</label>' +
        '<input type="range" id="cfg-pstr" min="0" max="276" step="1"><span class="v" id="cfg-pstrv"></span></div>' +
        '<div class="cfg-row"><label>惩罚持续</label>' +
        '<input type="range" id="cfg-pdur" min="1" max="60" step="1"><span class="v" id="cfg-pdurv"></span></div>' +
        '<div class="cfg-row"><label>奖励力度</label>' +
        '<input type="range" id="cfg-rstr" min="0" max="276" step="1"><span class="v" id="cfg-rstrv"></span></div>' +
        '<div class="cfg-row"><label>奖励持续</label>' +
        '<input type="range" id="cfg-rdur" min="1" max="60" step="1"><span class="v" id="cfg-rdurv"></span></div>' +
        '<div class="cfg-row"><label>音效</label>' +
        '<input type="checkbox" id="cfg-sfx" style="flex:1"><span class="v"></span></div>' +
        '<div class="cfg-pick"><span class="pick-label">奖励设备</span>' +
          '<button class="pick" data-g="r" data-k="cy">郊狼</button>' +
          '<button class="pick" data-g="r" data-k="cup">榨精杯</button>' +
          '<button class="pick" data-g="r" data-k="ems">电击器</button>' +
        '</div>' +
        '<div class="cfg-lines">' +
          '<div class="lines-head"><b>成功台词</b>' +
          '<button class="mini" data-add="win">+ 添加</button></div>' +
          '<div id="lines-win" class="lines-list"></div>' +
          '<div class="lines-head" style="margin-top:10px"><b>失败台词</b>' +
          '<button class="mini" data-add="lose">+ 添加</button></div>' +
          '<div id="lines-lose" class="lines-list"></div>' +
          '<button class="mini wide" id="lines-reset" style="margin-top:8px">恢复默认台词</button>' +
        '</div>' +
        '<div class="cfg-pick"><span class="pick-label">惩罚设备</span>' +
          '<button class="pick" data-g="p" data-k="cy">郊狼</button>' +
          '<button class="pick" data-g="p" data-k="cup">榨精杯</button>' +
          '<button class="pick" data-g="p" data-k="ems">电击器</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    canvas = overlay.querySelector('#game-canvas');
    ctx = canvas.getContext('2d');

    foxImg = new Image();
    foxImg.src = 'art-mascot.webp';

    overlay.querySelector('#game-close').addEventListener('click', close);
    deathEl = overlay.querySelector('#death-layer');
    happyEl = overlay.querySelector('#happy-layer');

    // 背景：有专用图就用，没有就用主背景模糊
    var bgEl = overlay.querySelector('#game-bg');
    (function () {
      var probe = new Image();
      probe.onload = function () { bgEl.style.backgroundImage = 'url("game-bg.webp")'; };
      probe.onerror = function () { bgEl.style.backgroundImage = 'url("art-bg-pink.webp")'; };
      probe.src = 'game-bg.webp';
    })();
    bindCfg();
    bindInput();

    // 主页的入口按钮
    var btn = document.createElement('button');
    btn.id = 'game-open';
    btn.className = 'home-fab';
    btn.style.top = 'calc(66px + env(safe-area-inset-top))';
    btn.textContent = '🎮';
    btn.addEventListener('click', open);
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.JumpGame = { open: open, close: close };
})();
