import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHED = require(path.join(HERE, "..", "app/src/main/assets/sched.js"));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; }
  else { fail++; console.log("FAIL " + name + (detail !== undefined ? "  -> " + detail : "")); }
}

const { MODES, create } = SCHED;

/* ---------- 配置表 ---------- */
check("三种模式都存在", !!MODES.easy && !!MODES.normal && !!MODES.hell);
check("简单区间 1-20", MODES.easy.min === 1 && MODES.easy.max === 20);
check("普通上限 50", MODES.normal.max === 50);
check("炼狱上限 100", MODES.hell.max === 100);
check("炼狱高强度阈值 51", MODES.hell.high.threshold === 51);
check("炼狱高强度最长 60 秒", MODES.hell.high.maxContinuousMs === 60000);

/* ---------- 区间夹取 ---------- */
{
  const s = create("easy", { now: 0 });
  const r = s.request(999, { now: 30000 });
  check("超上限被夹到 20", r.applied <= 20, r.applied);
  const r2 = s.request(0, { now: 40000 });
  check("低于下限不会变 0", r2.applied >= 0, r2.applied);
}

/* ---------- 开场保护 ---------- */
{
  const s = create("normal", { now: 0 });
  const r = s.request(50, { now: 1000 });
  check("普通模式前 60 秒不超过 20", r.applied <= 20, r.applied);
  check("开场保护记录原因", r.reasons.join().indexOf("开场") >= 0, r.reasons);
}

/* ---------- 上升斜率（简单模式，间隔 8 秒 / 2 级每秒） ---------- */
{
  const s = create("easy", { now: 0 });
  s.request(20, { now: 30000 });
  s.forceStop(31000);
  const r = s.request(20, { now: 39000 });   // 8 秒后从 0 直接要 20
  check("上升斜率限制生效", r.applied <= 16.5, r.applied);
  check("斜率限速记录原因", r.reasons.join().indexOf("限速") >= 0, r.reasons);
}

/* ---------- 触发间隔 ---------- */
{
  const s = create("easy", { now: 0 });
  s.request(15, { now: 30000 });
  const r = s.request(20, { now: 31000 });   // 1 秒后又触发
  check("间隔不足时降级", r.applied <= 15, r.applied);
  check("降级原因记录", r.reasons.join().indexOf("过频") >= 0, r.reasons);
}

/* ---------- 单次时长 ---------- */
{
  const s = create("easy", { now: 0 });
  const r = s.request(10, { now: 30000, holdMs: 999999 });
  check("单次时长截断到 10 秒", r.holdMs === 10000, r.holdMs);
}

/* ---------- 炼狱：高强度累计 60 秒后强制回落 ---------- */
{
  const s = create("hell", { now: 0 });
  let last = null, dropped = null, dropAt = 0;
  for (let i = 0; i < 8; i++) {
    const t = 61000 + i * 20000;
    last = s.request(80, { now: t, holdMs: 15000 });
    if (!dropped && last.reasons.join().indexOf("超时") >= 0) { dropped = last; dropAt = t; break; }
  }
  check("高强度累计后触发强制回落", !!dropped, "没有触发");
  if (dropped) {
    check("强制回落降到 20 以下", dropped.applied <= 20, dropped.applied);
    const blocked = s.request(60, { now: dropAt + 1000 });
    check("回落进入休息期", blocked.blocked === true, JSON.stringify(blocked));
    const after = s.request(30, { now: dropAt + 31000 });
    check("休息结束后恢复可用", after.blocked === false, JSON.stringify(after));
  }
}

/* ---------- 急停 ---------- */
{
  const s = create("normal", { now: 0 });
  s.request(30, { now: 62000, holdMs: 5000 });
  const r = s.forceStop(63000);
  check("急停归零", r.applied === 0 && s.snapshot().current === 0, s.snapshot().current);
}

/* ---------- 自然衰减 ---------- */
{
  const s = create("easy", { now: 0 });
  s.request(20, { now: 30000, holdMs: 1000 });
  s.tick(31000);
  const after = s.tick(32000);
  check("保持时间过后开始衰减", after < 20, after);
}

/* ---------- 通道 ---------- */
{
  const s = create("easy", { now: 0 });
  const r = s.request(5, { now: 30000, channel: "a" });
  check("通道 a 被接受", r.channel === "a", r.channel);
  const r2 = s.request(5, { now: 40000, channel: "乱写" });
  check("非法通道回落到 both", r2.channel === "both", r2.channel);
}

/* ---------- 切换模式 ---------- */
{
  const s = create("hell", { now: 0 });
  s.request(20, { now: 61000 });
  s.setMode("easy");
  check("切到简单后当前值不超过 20", s.snapshot().current <= 20, s.snapshot().current);
  check("未知模式不生效", s.setMode("nightmare") === false);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
