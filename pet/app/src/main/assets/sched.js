/* 强度调度器 —— 三模式安全状态机
 *
 * 只做本地决策：模型给一个 1-100 的等级，这里决定「实际下发多少、持续多久」。
 * 设备原始单位（0-200）由调用方换算，模型永远接触不到。
 *
 * 约束（任何一条都不允许被模型绕过）：
 *   区间夹取 / 开场保护 / 上升斜率 / 触发间隔 / 单次时长 / 高强度连续计时
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Scheduler = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var MODES = {
    easy: {
      name: '简单',
      min: 1,
      max: 20,
      minGapMs: 8000,        // 两次触发的最短间隔
      maxHoldMs: 10000,      // 单次最长持续
      risePerSec: 2,         // 每秒最多上升多少级
      fallPerSec: 8,
      opening: { windowMs: 30000, cap: 10 },
      high: null,            // 简单模式不设高强度限制
      cooldownMs: 5000
    },
    normal: {
      name: '普通',
      min: 1,
      max: 50,
      minGapMs: 20000,
      maxHoldMs: 15000,
      risePerSec: 3,
      fallPerSec: 10,
      opening: { windowMs: 60000, cap: 20 },
      high: { threshold: 35, maxContinuousMs: 40000 },
      cooldownMs: 10000
    },
    hell: {
      name: '炼狱',
      min: 1,
      max: 100,
      minGapMs: 20000,
      maxHoldMs: 15000,
      risePerSec: 4,
      fallPerSec: 12,
      opening: { windowMs: 60000, cap: 20 },
      high: { threshold: 51, maxContinuousMs: 60000, restLevel: 20, restMs: 30000 },
      cooldownMs: 10000
    }
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function createScheduler(modeKey, opts) {
    opts = opts || {};
    var cfg = MODES[modeKey] || MODES.easy;
    var now0 = typeof opts.now === 'number' ? opts.now : 0;

    var st = {
      mode: modeKey,
      current: 0,          // 当前实际下发等级
      lastChangeAt: now0,
      lastRiseAt: now0,
      lastTriggerAt: -1e9,
      startedAt: now0,
      holdUntil: 0,
      highSince: 0,        // 开始处于高强度的时间点，0 = 不在高强度
      restUntil: 0,        // 强制休息截止
      highUsedMs: 0,       // 本轮累计高强度时长
      total: 0,            // 统计：触发次数
      lastReason: ''
    };

    function decay(now) {
      // 超过保持时间后自然回落
      if (now < st.holdUntil || st.current <= 0) return;
      var dt = (now - st.lastChangeAt) / 1000;
      var next = st.current - cfg.fallPerSec * dt;
      st.current = Math.max(0, Math.round(next * 10) / 10);
      st.lastChangeAt = now;
    }

    function tickHigh(now) {
      if (!cfg.high) return;
      var isHigh = st.current >= cfg.high.threshold;
      if (isHigh && !st.highSince) st.highSince = now;
      if (!isHigh && st.highSince) {
        // 只累计「实际保持时间内」的高强度，休息时间不计数
        var end = Math.min(now, st.holdUntil || now);
        st.highUsedMs += Math.max(0, end - st.highSince);
        st.highSince = 0;
      }
    }

    /** 模型请求一次强度；返回实际下发值与原因 */
    function request(level, options) {
      options = options || {};
      var now = typeof options.now === 'number' ? options.now : st.lastChangeAt;
      var reasons = [];

      decay(now);
      tickHigh(now);

      var want = Number(level);
      if (!isFinite(want)) want = cfg.min;

      // ① 区间夹取
      var applied = clamp(want, cfg.min, cfg.max);
      if (applied !== want) reasons.push('夹取到区间');

      // ② 强制休息期
      if (now < st.restUntil) {
        st.lastReason = '休息中';
        return { applied: 0, level: 0, holdMs: 0, reasons: ['强制休息'], blocked: true };
      }
      // 休息结束后清零高强度累计，重新开始计时
      if (st.restUntil && now >= st.restUntil) {
        st.restUntil = 0;
        st.highUsedMs = 0;
        st.highSince = 0;
      }

      // ③ 开场保护
      if (st.opening && now - st.startedAt < cfg.opening.windowMs) {
        var cap = st.opening.cap;
        if (applied > cap) { applied = cap; reasons.push('开场保护'); }
      }

      // ④ 触发间隔：太频繁就压到当前值的 60%
      var gap = now - st.lastTriggerAt;
      if (gap < cfg.minGapMs) {
        applied = Math.max(cfg.min, Math.round(st.current * 0.6));
        reasons.push('触发过频，降级');
      }

      // ⑤ 上升斜率：从「上次上升」算起，避免被衰减重置成 0
      var dtSec = Math.max(0.05, (now - st.lastRiseAt) / 1000);
      var maxRise = cfg.risePerSec * dtSec;
      if (applied > st.current + maxRise) {
        applied = st.current + maxRise;
        reasons.push('上升过快，限速');
      }

      // ⑥ 高强度连续计时
      if (cfg.high && applied >= cfg.high.threshold) {
        var used = st.highUsedMs + (st.highSince ? now - st.highSince : 0);
        if (used >= cfg.high.maxContinuousMs) {
          applied = Math.max(cfg.min, cfg.high.restLevel || Math.floor(cfg.high.threshold * 0.4));
          reasons.push('高强度超时，强制回落');
          st.restUntil = now + (cfg.high.restMs || 30000);
        }
      }

      // ⑦ 单次时长
      var holdMs = Number(options.holdMs) || 0;
      if (holdMs > cfg.maxHoldMs) { holdMs = cfg.maxHoldMs; reasons.push('单次时长截断'); }

      applied = Math.round(clamp(applied, 0, cfg.max) * 10) / 10;
      if (applied > st.current) st.lastRiseAt = now;
      st.current = applied;
      st.lastChangeAt = now;
      st.lastTriggerAt = now;
      st.holdUntil = now + (holdMs || 0);
      st.total++;
      st.lastReason = reasons.join(' / ') || '正常';
      tickHigh(now);

      return {
        applied: applied,
        level: applied,
        channel: options.channel === 'a' || options.channel === 'b' ? options.channel : 'both',
        holdMs: holdMs,
        reasons: reasons,
        blocked: false
      };
    }

    function forceStop(now) {
      now = typeof now === 'number' ? now : st.lastChangeAt;
      st.current = 0;
      st.lastChangeAt = now;
      st.lastRiseAt = now;
      st.holdUntil = 0;
      st.highSince = 0;
      st.restUntil = 0;
      st.lastReason = '急停';
      return { applied: 0, level: 0, holdMs: 0, reasons: ['急停'], blocked: true };
    }

    function tick(now) {
      decay(now);
      tickHigh(now);
      if (st.current <= 0) { st.highSince = 0; }
      return st.current;
    }

    function snapshot() {
      return {
        mode: st.mode, name: cfg.name,
        current: st.current,
        config: cfg,
        total: st.total,
        lastReason: st.lastReason,
        resting: st.restUntil > st.lastChangeAt,
        highUsedMs: st.highUsedMs + (st.highSince ? st.lastChangeAt - st.highSince : 0)
      };
    }

    function setMode(next) {
      if (!MODES[next]) return false;
      var keep = st.current;
      cfg = MODES[next];
      st.mode = next;
      st.current = Math.min(keep, cfg.max);
      st.lastChangeAt = st.lastChangeAt;
      return true;
    }

    // 允许测试注入「开场保护起点」
    if (typeof opts.openingCap === 'number') st.opening = { windowMs: cfg.opening.windowMs, cap: opts.openingCap };
    else st.opening = { windowMs: cfg.opening.windowMs, cap: cfg.opening.cap };

    return {
      mode: modeKey,
      config: cfg,
      request: request,
      tick: tick,
      forceStop: forceStop,
      snapshot: snapshot,
      setMode: setMode,
      _state: st
    };
  }

  return { MODES: MODES, create: createScheduler };
});
