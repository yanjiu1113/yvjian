/* 语见小狐 —— 桌宠页面逻辑
 *
 * 动画资源约定（assets/anims/<name>/000.webp, 001.webp ...）：
 *   ANIMS[name] = { frames, fps, loop }
 * 用 ComfyUI 出图后，把帧序列放进对应目录即可，代码不用改。
 */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };

  var bubble = $('#bubble');
  var bubbleText = $('#bubble-text');
  var face = $('#face');
  var foxWrap = $('#fox-wrap');
  var canvas = $('#fox');
  var fx = $('#fx');
  var ctx = canvas.getContext('2d');

  var ANIMS = {
    none: null,
    idle: { frames: 24, fps: 12, loop: true },
    sway: { frames: 33, fps: 24, loop: true },
    blink:    { frames: 33, fps: 16, loop: false, back: 'sway' },
    stare:    { frames: 33, fps: 16, loop: false, back: 'sway' },
    hop:      { frames: 33, fps: 16, loop: false, back: 'sway' },
    talk:     { frames: 33, fps: 16, loop: false, back: 'sway' },
    smug:     { frames: 33, fps: 16, loop: false, back: 'sway' },
    angry:    { frames: 33, fps: 16, loop: false, back: 'sway' }
  };

  // 有人物插画（带背景）的动画：用圆角面板呈现，不做抠图
  var PORTRAIT_ANIMS = { sway: true, blink: true, stare: true, hop: true, talk: true, smug: true, angry: true };

  var FACES = {
    happy: 'art-face-happy.webp',
    normal: 'art-face-normal.webp',
    angry: 'art-face-angry.webp',
    sad: 'art-face-cry.webp',
    shy: 'art-face-normal.webp',
    think: 'art-face-normal.webp'
  };

  // 小情绪：动画名 + 台词 + 粒子
  var EMOTIONS = {
    happy:    { anim: 'bounce',  fx: '💗', lines: ['嘿嘿，被发现了', '今天心情很好呢', '要抱一下吗', '嗯！就喜欢你这样'] },
    shy:      { anim: 'tilt',    fx: '💧', lines: ['别、别看我', '脸有点烫…', '说这种话会让人很在意的', '唔…不许笑'] },
    angry:    { anim: 'shake',   fx: '💢', lines: ['哼！才不理你', '生气了，真的', '你再说一遍试试', '不理你了…骗你的'] },
    tsundere: { anim: 'turn',    fx: '✨', lines: ['才、才不是为了你', '哼，随便啦', '我可不是因为想见你', '笨蛋…别误会'] },
    sad:      { anim: 'droop',   fx: '💧', lines: ['…原来是这样', '有点难过', '让我安静一下下', '你还会回来的吧'] },
    surprised:{ anim: 'pop',     fx: '❓', lines: ['诶？！', '你说什么', '等等，让我反应一下', '真、真的吗'] },
    sleepy:   { anim: 'slow',    fx: '💤', lines: ['哈…好困', '再撑一会…', '眼皮好重', '就眯一下下'] },
    excited:  { anim: 'fast',    fx: '✨', lines: ['真的吗真的吗！', '我等好久了', '快点快点', '呜哇——'] }
  };

  /** 把任意情绪词映射到内置动画 */
  function moodKey(word) {
    var s = String(word || '');
    if (/害羞|羞|脸红/.test(s)) return 'shy';
    if (/傲娇|才不|哼/.test(s)) return 'tsundere';
    if (/生气|愤怒|不满|火/.test(s)) return 'angry';
    if (/开心|高兴|愉快|喜欢|爱|兴奋/.test(s)) return 'happy';
    if (/难过|悲伤|伤心|委屈|哭/.test(s)) return 'sad';
    if (/惊讶|震惊|诶|意外/.test(s)) return 'surprised';
    if (/困|睡|疲/.test(s)) return 'sleepy';
    if (/心动|激动|期待/.test(s)) return 'excited';
    return 'happy';
  }

  // 情绪 -> 已有帧动画（没有的留空，回退到程序化动画）
  var FRAME_EMOTION = {
    happy: 'hop',
    excited: 'hop',
    tsundere: 'smug',
    surprised: 'stare',
    shy: 'blink',      // 暂时用眨眼代替，等有脸红视频再换
    angry: 'angry',
    sad: '',
    sleepy: ''
  };

  var animTimer = null;
  function playEmotion(word) {
    var key = moodKey(word);
    var cfg = EMOTIONS[key] || EMOTIONS.happy;
    if (!foxWrap) return;

    var frameAnim = FRAME_EMOTION[key];
    if (frameAnim && ANIMS[frameAnim]) {
      play(frameAnim, true);
      setFace(key === 'angry' ? 'angry' : (key === 'sad' ? 'sad' : 'happy'));
      say(pick(cfg.lines), 3600, key === 'angry' ? 'angry' : 'happy');
      burst(cfg.fx, 3);
      return;
    }

    foxWrap.classList.remove('bounce','tilt','shake','turn','droop','pop','slow','fast');
    void foxWrap.offsetWidth;
    foxWrap.classList.add(cfg.anim);

    if (animTimer) clearTimeout(animTimer);
    animTimer = setTimeout(function () {
      foxWrap.classList.remove(cfg.anim);
    }, 2200);

    setFace(key === 'angry' ? 'angry' : (key === 'sad' ? 'sad' : (key === 'shy' ? 'shy' : 'happy')));
    say(pick(cfg.lines), 3600, key === 'angry' ? 'angry' : (key === 'sad' ? 'sad' : 'happy'));
    burst(cfg.fx, 3);
  }

  window.PetEmotion = playEmotion;

  /** 外部（游戏/语见）让狐狸说一句短话 */
  window.PetSay = function (text, ms) {
    if (!text) return;
    say(String(text).slice(0, 40), ms || 2400, 'happy');
  };

  var LINES = {
    greet: ['你来啦，我等好久了', '今天的风很舒服呢', '要一起说说话吗'],
    tap: ['唔…戳我干嘛呀', '别闹，会被看到的', '痒…那里不行', '你是不是又想逗我', '再戳就要生气了哦'],
    tap_angry: ['说了别戳了！', '哼，不理你了', '你再这样我真生气了'],
    idle: ['今天的晚霞很好看，要一起看吗', '你刚才那句话，我想了很久', '有点困了…不过还想陪你一会', '窗外好像要下雨了'],
    happy: ['嗯！我也是这么想的', '嘿嘿，被你发现了', '好开心呀'],
    sad: ['原来是这样…', '我有点难过', '抱一下可以吗'],
    think: ['让我想想…', '嗯…这个问题不简单', '唔，好像有点道理'],
    sleepy: ['哈…好困', '再撑一会，陪你']
  };

  var state = {
    mood: 'normal',
    tapCount: 0,
    bubbleTimer: null,
    idleTimer: null,
    frames: {},
    current: '',
    raf: 0,
    dpr: 1,
    drawn: null
  };

  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

  function setFace(kind) {
    var src = FACES[kind] || FACES.normal;
    if (face.getAttribute('src') !== src) face.setAttribute('src', src);
  }

  function say(text, ms, kind) {
    if (!text) return;
    bubbleText.textContent = text;
    setFace(kind || state.mood);
    bubble.classList.add('show');
    if (state.bubbleTimer) clearTimeout(state.bubbleTimer);
    state.bubbleTimer = setTimeout(function () {
      bubble.classList.remove('show');
      state.bubbleTimer = null;
    }, ms || 4200);
  }

  function burst(symbol, count) {
    for (var i = 0; i < count; i++) {
      (function (i) {
        setTimeout(function () {
          var el = document.createElement('div');
          el.className = 'heart';
          el.textContent = symbol;
          el.style.left = (32 + Math.random() * 36) + '%';
          el.style.bottom = (26 + Math.random() * 16) + '%';
          fx.appendChild(el);
          setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1600);
        }, i * 90);
      })(i);
    }
  }

  /* ---------------- 帧动画 ---------------- */
  function loadAnim(name) {
    if (state.frames[name]) return Promise.resolve(state.frames[name]);
    var cfg = ANIMS[name];
    if (!cfg) return Promise.reject(new Error('no anim ' + name));
    var list = [];
    for (var i = 0; i < cfg.frames; i++) {
      list.push((function (n) {
        return new Promise(function (resolve) {
          var im = new Image();
          im.onload = function () { resolve(im); };
          im.onerror = function () { resolve(null); };
          im.src = 'anim-' + name + '-' + String(n).padStart(3, '0') + '.webp';
        });
      })(i));
    }
    return Promise.all(list).then(function (imgs) {
      var ok = imgs.filter(Boolean);
      if (!ok.length) throw new Error('no frames for ' + name);
      state.frames[name] = ok;
      return ok;
    });
  }

  function resizeCanvas(img) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    var maxH = window.innerHeight * 0.62;
    var maxW = window.innerWidth * 0.92;
    var ratio = img.width / img.height;
    var h = maxH;
    var w = h * ratio;
    if (w > maxW) { w = maxW; h = w / ratio; }
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    state.dpr = dpr;
    state.drawn = { w: w, h: h };
  }

  function drawFrame(img) {
    if (!img) return;
    if (!state.drawn) resizeCanvas(img);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }

  function play(name, force) {
    if (state.current === name) {
      if (!force) return;
      state.current = '';
      cancelAnimationFrame(state.raf);
    }
    foxWrap.classList.toggle('portrait', !!PORTRAIT_ANIMS[name]);
    state.current = name;
    loadAnim(name).then(function (imgs) {
      var cfg = ANIMS[name];
      var i = 0;
      cancelAnimationFrame(state.raf);
      state.drawn = null;
      resizeCanvas(imgs[0]);
      var last = 0;
      var step = 1000 / (cfg.fps || 12);
      function tick(ts) {
        if (state.current !== name) return;
        if (!last || ts - last >= step) {
          drawFrame(imgs[i]);
          i++;
          last = ts;
          if (i >= imgs.length) {
            if (cfg.loop) { i = 0; }
            else {
              if (cfg.back) {
                var back = cfg.back;
                setTimeout(function () { play(back); }, 900);
              }
              return;
            }
          }
        }
        state.raf = requestAnimationFrame(tick);
      }
      state.raf = requestAnimationFrame(tick);
    }).catch(function () {
      var im = new Image();
      im.onload = function () { state.drawn = null; resizeCanvas(im); drawFrame(im); };
      im.src = 'art-mascot.webp';
    });
  }

  /* ---------------- 交互 ---------------- */
  foxWrap.addEventListener('click', function () {
    state.tapCount++;
    var cycle = ['happy', 'tsundere', 'shy', 'surprised', 'excited', 'angry'];
    playEmotion(cycle[(state.tapCount - 1) % cycle.length]);
    foxWrap.classList.remove('jump');
    void foxWrap.offsetWidth;
    foxWrap.classList.add('jump');
    setTimeout(function () { foxWrap.classList.remove('jump'); }, 640);

    var angry = state.tapCount % 5 === 0;
    state.mood = angry ? 'angry' : 'happy';
    if (angry) {
      burst('💢', 3);
      say(pick(LINES.tap_angry), 3800, 'angry');
    } else {
      burst('💗', 3);
      say(pick(LINES.tap), 3800, 'happy');
    }
    scheduleIdle();
  });

  function scheduleIdle() {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(function () {
      if (!bubble.classList.contains('show')) {
        state.mood = 'normal';
        say(pick(LINES.idle), 4600, 'normal');
      }
      scheduleIdle();
    }, 22000 + Math.random() * 18000);
  }

  /* ---------------- 聊天端事件 ---------------- */
  window.PetEvent = function (type, value, text) {
    if (!type) return;
    switch (type) {
      case 'turn.start':
        state.mood = 'normal';
        setFace('normal');
        break;
      case 'turn.thinking':
        state.mood = 'think';
        say(pick(LINES.think), 3000, 'think');
        break;
      case 'turn.chunk':
        break;
      case 'turn.done':
        state.mood = mapMood(value);
        setFace(state.mood);
        blurt(state.mood, text);
        break;
      case 'turn.error':
        state.mood = 'sad';
        say('唔…好像出错了', 4200, 'sad');
        break;
      case 'reply':
        if (window.PetDevice) window.PetDevice.onReply(text || value || '');
        break;

      case 'sticker':
        state.mood = mapMood(value);
        setFace(state.mood);
        burst(state.mood === 'angry' ? '💢' : '✨', 2);
        break;
      default:
        break;
    }
  };

  function mapMood(v) {
    var s = String(v || '');
    if (!s) return 'normal';
    if (/开心|高兴|愉快|喜欢|爱|摸鱼/.test(s)) return 'happy';
    if (/生气|愤怒|不满|傲娇/.test(s)) return 'angry';
    if (/难过|悲伤|伤心|哭/.test(s)) return 'sad';
    if (/害羞|羞|脸红/.test(s)) return 'shy';
    if (/困|睡|疲/.test(s)) return 'sleepy';
    return 'normal';
  }

  function blurt(mood, text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length > 26) t = t.slice(0, 26) + '…';
    if (t) { say(t, 5000, mood === 'normal' ? 'happy' : mood); return; }
    var pool = LINES[mood] || LINES.happy;
    say(pick(pool), 4600, mood);
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    play('sway');
    scheduleIdle();
    setTimeout(function () { say(pick(LINES.greet), 4200, 'happy'); }, 500);
  }

  window.addEventListener('resize', function () {
    var imgs = state.frames[state.current];
    if (imgs && imgs.length) {
      state.drawn = null;
      resizeCanvas(imgs[0]);
      drawFrame(imgs[0]);
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
