// Runs the real app.js (unmodified except for a test hook) in Node with a minimal DOM stub,
// then asserts on markdown rendering, request construction and provider resolution.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appJsPath = path.join(here, "..", "app", "src", "main", "assets", "app.js");
const src = fs.readFileSync(appJsPath, "utf8");

// expose internals for testing
const marker = "})();";
const cut = src.lastIndexOf(marker);
const patched = src.slice(0, cut) +
  "window.__t = { md: md, state: state, sendCore: sendCore, buildHistory: buildHistory, " +
  "blankSession: blankSession, resolveProvider: resolveProvider, persist: persist, " +
  "stripEmo: stripEmo, extractEmoCats: extractEmoCats, maybeSendSticker: maybeSendSticker, " +
  "ensurePacks: ensurePacks, buildStickerInstruction: buildStickerInstruction, doSend: doSend, " +
  "searchReady: searchReady, engineNeedsKey: engineNeedsKey, browserSearchUrl: browserSearchUrl, " +
  "applyBackground: applyBackground, BG_PRESETS: BG_PRESETS, " +
  "stripSearchDisplay: stripSearchDisplay, takeSearchQuery: takeSearchQuery, " +
  "buildSearchToolPrompt: buildSearchToolPrompt, MAX_SEARCH_PER_TURN: MAX_SEARCH_PER_TURN, " +
  "isNewsQuery: isNewsQuery, " +
  "currentEngine: currentEngine };\n" +
  src.slice(cut);

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra ? "\n     " + extra : "")); }
}

// ---------------------------------------------------------------- DOM stub

function fakeEl(tag) {
  return {
    tagName: (tag || "div").toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    value: "",
    hidden: false,
    open: false,
    scrollHeight: 100,
    scrollTop: 0,
    clientHeight: 100,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { const v = on === undefined ? !this._s.has(c) : !!on; if (v) this._s.add(c); else this._s.delete(c); return v; },
      contains(c) { return this._s.has(c); }
    },
    _text: "",
    _html: "",
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c) { this.children.push(c); return c; },
    removeChild() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return fakeEl("div"); },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
    setAttribute() {},
    getAttribute() { return null; },
    dispatchEvent() { return true; }
  };
}

const documentStubCache = new Map();

function createDoc() {
  return {
    readyState: "complete",
    querySelector(sel) {
      if (!documentStubCache.has(sel)) documentStubCache.set(sel, fakeEl(sel));
      return documentStubCache.get(sel);
    },
    querySelectorAll() { return []; },
    createElement(tag) { return fakeEl(tag); },
    addEventListener() {},
    body: fakeEl("body"),
    documentElement: fakeEl("html")
  };
}

// ---------------------------------------------------------------- app factory

function createApp(boot, metaOverride) {
  const calls = { chat: [], saved: [], providers: [], toasts: [], copied: [], search: [], searchNews: [], searchKeys: [], meta: [], plan: [], stickers: [], speech: [] };

  const native = {
    boot() { return JSON.stringify(boot); },
    loadSession() { return ""; },
    saveSession(json) { calls.saved.push(JSON.parse(json)); },
    listSessions() { return "[]"; },
    saveProviders(json) { calls.providers.push(JSON.parse(json)); },
    setActiveProvider() {},
    setOverlay() {},
    fetchModels() {},
    chat(payload) { calls.chat.push(JSON.parse(payload)); },
    stop() {},
    pickImage() {},
    exportFile() {},
    importFile() {},
    copy(t) { calls.copied.push(t); },
    toast(t) { calls.toasts.push(t); },
    loadMeta() {
      return JSON.stringify(metaOverride || {
        avatars: { user: "", assistant: "" },
        stickers: ["data:image/jpeg;base64,LEGACY"],
        search: { engine: "tavily" },
        hasSearchKey: true
      });
    },
    saveMeta(json) { calls.meta.push(JSON.parse(json)); },
    saveSearchKey(k) { calls.searchKeys.push(k); },
    pickSmallImage() {},
    webSearch(q) { calls.search.push(q); },
    webSearchNews(q) { calls.searchNews.push(q); },
    pickSticker(cat) { calls.stickers.push(cat); },
    importStickers() {},
    deleteSticker() {},
    deleteStickerCategory() {},
    listStickerFiles() { return "[]"; },
    stickerInfo() { return JSON.stringify({ ok: true, tree: false, categories: [] }); },
    ttsStatus() { return JSON.stringify({ cloneTts: false, engines: [], voice: "", rate: 1, preferApi: true }); },
    ttsConfigure() {},
    ttsSpeak(t) { calls.speech.push(t); },
    ttsStop() {},
    openTtsSettings() {},
    planSearch(payload) { calls.plan.push(JSON.parse(payload)); }
  };

  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const doc = createDoc();
  sandbox.document = doc;
  sandbox.localStorage = {
    _s: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem(k, v) { this._s[k] = String(v); }
  };
  sandbox.Native = native;
  sandbox.console = console;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.requestAnimationFrame = (cb) => { setTimeout(() => cb(16), 0); return 1; };
  sandbox.cancelAnimationFrame = () => {};

  vm.createContext(sandbox);
  vm.runInContext(patched, sandbox, { filename: "app.js" });
  return { sandbox, t: sandbox.__t, calls, doc };
}

const PROVIDER = {
  id: "p1", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1",
  defaultModel: "vendor/model-a", models: [{ id: "vendor/model-a", name: "A" }], hasKey: true
};

// ================================================================ scenario 1: configured
const A = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
const t = A.t;

check("app.js boots without throwing", !!t && !!t.state.cur, "state.cur missing");
check("providers parsed from Native.boot", t.state.providers.length === 1 && t.state.providers[0].name === "OpenRouter");
check("default model picked", t.state.cur.model === "vendor/model-a", "got " + t.state.cur.model);
check("empty system prompt by default", t.state.cur.system === "", "system=" + JSON.stringify(t.state.cur.system));
check("no client-side filter hooks", !/censored|moderat|safety|guardrail/i.test(src));

// ---------------------------------------------------------------- markdown

const md = t.md;
check("bold", md("这是**加粗**文字").includes("<strong>加粗</strong>"));
check("inline code", md("用 `npm i` 安装").includes("<code>npm i</code>"));
check("fenced code block", md("```js\nconst a = 1;\n```").includes('<div class="code">'));
check("fenced code keeps content", md("```js\nconst a = 1;\n```").includes("const a = 1;"));
check("fenced code lang label", md("```python\nx=1\n```").includes(">python<"));
check("unordered list", md("- 一\n- 二").includes("<ul><li>一</li><li>二</li></ul>"));
check("ordered list", md("1. 一\n2. 二").includes("<ol><li>一</li><li>二</li></ol>"));
check("heading", md("## 标题").includes("<h3>标题</h3>"));
check("blockquote", md("> 引用").includes("<blockquote>引用</blockquote>"));
check("table", md("| a | b |\n|---|---|\n| 1 | 2 |").includes("<table>"));
check("link", md("[官网](https://example.com)").includes('<a href="https://example.com"'));
check("autolink", md("见 https://example.com/x 说明").includes('<a href="https://example.com/x"'));
check("html is escaped", md("<script>alert(1)</script>").includes("&lt;script&gt;"));
check("html in code block escaped", md("```\n<b>x</b>\n```").includes("&lt;b&gt;"));
check("code block not wrapped in <p>", !md("```js\nx\n```").startsWith("<p>"));

// ---------------------------------------------------------------- request payload

t.state.cur.messages = [];
t.sendCore("帮我写个快排", []);

check("chat invoked", A.calls.chat.length === 1, "calls=" + A.calls.chat.length);
const payload = A.calls.chat[0];
check("payload carries model", payload.model === "vendor/model-a");
check("payload has no system when empty", !("system" in payload) || payload.system === "");
check("first message is the user turn", payload.messages[0].role === "user" && payload.messages[0].content === "帮我写个快排");
check("temperature forwarded", payload.temperature === 0.7, "got " + payload.temperature);
check("assistant placeholder is not sent", payload.messages.every((m) => m.role !== "assistant"));
check("session message added", t.state.cur.messages.length === 2 && t.state.cur.messages[0].role === "user");
check("auto title from first message", t.state.cur.title === "帮我写个快排", "title=" + t.state.cur.title);

// ---------------------------------------------------------------- streaming callbacks

const msgId = payload.msgId;
A.sandbox.__bridge.onChunk(JSON.stringify({ id: msgId, c: "你好", r: "" }));
A.sandbox.__bridge.onChunk(JSON.stringify({ id: msgId, c: "，世界", r: "" }));
A.sandbox.__bridge.onChunk(JSON.stringify({ id: msgId, c: "", r: "先想一下" }));

const am = t.state.cur.messages.find((m) => m.id === msgId);
check("chunks accumulate", am && am.content === "你好，世界", "content=" + (am && am.content));
check("reasoning accumulated", am && am.reasoning === "先想一下", "reasoning=" + (am && am.reasoning));

A.sandbox.__bridge.onDone(JSON.stringify({ id: msgId }));
check("stream cleared on done", t.state.cur.messages.find((m) => m.id === msgId).streaming === false);
check("no error recorded on success", !t.state.cur.messages.find((m) => m.id === msgId).error);
check("session persisted after done", A.calls.saved.length >= 1);
check("persisted json has no streaming flag", !("streaming" in A.calls.saved[A.calls.saved.length - 1].messages.find((m) => m.id === msgId)));

// error path
t.state.cur.messages = [];
t.sendCore("测试报错", []);
const p2 = A.calls.chat[1];
A.sandbox.__bridge.onError(JSON.stringify({ id: p2.msgId, msg: "HTTP 401: invalid api key" }));
const em = t.state.cur.messages.find((m) => m.id === p2.msgId);
check("error surfaced on message", em.error === "HTTP 401: invalid api key");
check("error clears streaming", em.streaming === false);
check("failed turn excluded from history", t.buildHistory(t.state.cur, null).every((m) => !(m.role === "assistant" && m.content === "")));

// image turn becomes content parts
t.state.cur.messages = [];
t.sendCore("看这张图", ["data:image/jpeg;base64,AAAA"]);
const p3 = A.calls.chat[2];
check("image turn uses content parts", Array.isArray(p3.messages[0].content) && p3.messages[0].content[0].type === "text");
check("image url embedded", p3.messages[0].content[1].image_url.url.startsWith("data:image/jpeg;base64,"));

// ================================================================ scenario 2: provider added later
// Regression: first run has no provider, the session keeps providerId '', adding a provider
// afterwards must still let the user send messages.
const B = createApp({ providers: [], sessions: [], activeProviderId: "", version: "1.0" });
const tb = B.t;
check("empty install: session has no provider", tb.state.cur.providerId === "");

tb.sendCore("还没配置的时候发一条", []);
check("empty install: send is blocked", B.calls.chat.length === 0, "chat calls=" + B.calls.chat.length);
check("empty install: user is told to configure", B.doc.querySelector("#toast").textContent.indexOf("服务商") >= 0, "toast=" + B.doc.querySelector("#toast").textContent);

// user finishes the provider form -> providers array gets the new entry
tb.state.providers.push({
  id: "p9", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1",
  defaultModel: "deepseek-chat", models: [], hasKey: true
});

tb.sendCore("配置好之后再发一条", []);
check("after adding provider: chat is sent", B.calls.chat.length === 1, "chat calls=" + B.calls.chat.length);
check("after adding provider: providerId resolved", B.calls.chat[0].providerId === "p9", "got " + (B.calls.chat[0] || {}).providerId);
check("after adding provider: model auto-filled", B.calls.chat[0].model === "deepseek-chat", "got " + (B.calls.chat[0] || {}).model);
check("after adding provider: session healed", tb.state.cur.providerId === "p9");

// a session pointing at a removed provider falls back to the active one
tb.state.providers = [{ ...PROVIDER }];
tb.state.cur.providerId = "gone";
tb.state.cur.model = "";
const healed = tb.resolveProvider(tb.state.cur);
check("stale provider id falls back", healed && healed.id === "p1" && tb.state.cur.providerId === "p1");
check("stale provider id refills model", tb.state.cur.model === "vendor/model-a", "model=" + tb.state.cur.model);

// ================================================================ new composer features
A.t.state.streamingId = null;
A.t.state.cur.messages = [];
A.t.state.cur.stream = false;
A.t.sendCore("关闭流式试试", []);
const lastChat = A.calls.chat[A.calls.chat.length - 1];
check("stream=false forwarded to native", lastChat.stream === false);
A.t.state.cur.stream = true;
A.t.state.streamingId = null;
A.t.state.cur.messages = [];
A.t.sendCore("恢复流式", []);
check("stream=true forwarded", A.calls.chat[A.calls.chat.length - 1].stream === true);

// context length trimming
const ctxSession = A.t.blankSession();
ctxSession.messages = [
  { id: "m1", role: "user", content: "一" },
  { id: "m2", role: "assistant", content: "二" },
  { id: "m3", role: "user", content: "三" },
  { id: "m4", role: "assistant", content: "四" }
];
check("contextLimit 0 keeps everything", A.t.buildHistory(ctxSession, null).length === 4);
ctxSession.contextLimit = 2;
const trimmed = A.t.buildHistory(ctxSession, null);
check("contextLimit trims history", trimmed.length === 2, "len=" + trimmed.length);
check("contextLimit keeps newest turns", trimmed[1].content === "四");

ctxSession.contextLimit = 3;
const threeTurn = A.t.buildHistory(ctxSession, null);
check("trimmed history drops a leading assistant turn",
  threeTurn.length === 2 && threeTurn[0].role === "user" && threeTurn[1].role === "assistant", JSON.stringify(threeTurn));
ctxSession.contextLimit = 1;
const onlyAssistant = A.t.buildHistory(ctxSession, null);
check("trim that leaves only an assistant turn yields empty history", onlyAssistant.length === 0, JSON.stringify(onlyAssistant));

// web search: the model calls the tool itself
const D = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
D.t.state.cur.webSearch = true;
D.t.state.cur.messages = [];
D.t.sendCore("驻京观是什么", []);

check("no search before the model replies", D.calls.search.length === 0);
check("first chat call happens immediately", D.calls.chat.length === 1);
check("tool prompt injected into system", D.calls.chat[0].system.indexOf("<<search:") >= 0);
check("system carries the current time", D.calls.chat[0].system.indexOf("当前时间") >= 0);

const m1 = D.calls.chat[0].msgId;
D.sandbox.__bridge.onChunk(JSON.stringify({ id: m1, c: "我查一下。\n<<search:驻京观>>\n", r: "" }));
D.sandbox.__bridge.onDone(JSON.stringify({ id: m1 }));

check("marker triggers a search", D.calls.search.length === 1 && D.calls.search[0] === "驻京观", JSON.stringify(D.calls.search));
const m1msg = D.t.state.cur.messages.filter((m) => m.id === m1)[0];
check("marker removed from the reply", m1msg.content.indexOf("<<search") < 0, m1msg.content);
check("tool message created", D.t.state.cur.messages.some((m) => m.role === "tool"));
check("tool message is pending until results arrive",
  D.t.state.cur.messages.filter((m) => m.role === "tool")[0].pending === true);

D.sandbox.__bridge.onSearch(JSON.stringify({ ok: true, text: "1. 驻京观\n   https://a.example", engine: "bing" }));
check("continuation model call issued", D.calls.chat.length === 2);
const cont = D.calls.chat[1];
check("continuation history contains the results",
  JSON.stringify(cont.messages).indexOf("搜索结果") >= 0 && JSON.stringify(cont.messages).indexOf("a.example") >= 0);
check("continuation keeps the tool prompt", cont.system.indexOf("<<search:") >= 0);
check("continuation uses a fresh message id", cont.msgId !== m1);

// max two searches per user turn
D.sandbox.__bridge.onChunk(JSON.stringify({ id: cont.msgId, c: "再查一次\n<<search:驻京观 位置>>", r: "" }));
D.sandbox.__bridge.onDone(JSON.stringify({ id: cont.msgId }));
check("second search allowed", D.calls.search.length === 2);
D.sandbox.__bridge.onSearch(JSON.stringify({ ok: true, text: "2. 位置\n   https://b.example", engine: "bing" }));
const cont2 = D.calls.chat[2];
check("third model call issued", D.calls.chat.length === 3);
check("tool prompt dropped after the limit", cont2.system.indexOf("<<search:") < 0);

D.sandbox.__bridge.onChunk(JSON.stringify({ id: cont2.msgId, c: "还想搜\n<<search:再来一次>>", r: "" }));
D.sandbox.__bridge.onDone(JSON.stringify({ id: cont2.msgId }));
check("third search is blocked", D.calls.search.length === 2);

// search failure still continues the conversation
D.t.state.streamingId = null;
D.t.state.cur.messages = [];
D.t.sendCore("帮我查个不存在的", []);
const m2 = D.calls.chat[3].msgId;
D.sandbox.__bridge.onChunk(JSON.stringify({ id: m2, c: "<<search:不存在的东西>>", r: "" }));
D.sandbox.__bridge.onDone(JSON.stringify({ id: m2 }));
D.sandbox.__bridge.onSearch(JSON.stringify({ ok: false, error: "boom" }));
check("failed search still continues", D.calls.chat.length === 5);
check("failed search is recorded on the tool card",
  D.t.state.cur.messages.some((m) => m.role === "tool" && m.error === "boom"));

// no keyword guessing: even an explicit "search X" goes to the model first
const G = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
G.t.state.cur.webSearch = true;
G.t.state.cur.messages = [];
G.t.sendCore("帮我搜一下北京新闻", []);
check("no client-side keyword extraction", G.calls.search.length === 0 && G.calls.searchNews.length === 0);
check("the request still reaches the model", G.calls.chat.length === 1);
check("model keeps the tool", Array.isArray(G.calls.chat[0].tools));
check("message text is not rewritten", G.calls.chat[0].messages[0].content === "帮我搜一下北京新闻");

// helper units
check("stripSearchDisplay removes a marker", D.t.stripSearchDisplay("答案\n<<search:xx>>") === "答案");
check("stripSearchDisplay removes a partial marker", D.t.stripSearchDisplay("答案 <<search:北") === "答案");

// avatars + sticker packs
D.sandbox.__bridge.onSmallImage(JSON.stringify({ tag: "avatar:user", dataUrl: "data:image/jpeg;base64,AAA" }));
check("user avatar stored", D.t.state.meta.avatars.user === "data:image/jpeg;base64,AAA");
const dPackId = D.t.state.meta.stickerPacks[0].id;
D.sandbox.__bridge.onSmallImage(JSON.stringify({ tag: "sticker:" + dPackId, dataUrl: "data:image/jpeg;base64,BBB" }));
check("sticker appended to its pack",
  D.t.state.meta.stickerPacks[0].stickers.indexOf("data:image/jpeg;base64,BBB") >= 0);
check("meta persisted through native", D.calls.meta.some((m) => m.avatars && m.avatars.user === "data:image/jpeg;base64,AAA"));
check("search key loaded from native meta", D.t.state.hasSearchKey === true);

// ================================================================ sticker packs + auto send
const E = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
check("legacy stickers migrate into a default pack",
  E.t.state.meta.stickerPacks.length === 1 &&
  E.t.state.meta.stickerPacks[0].name === "默认" &&
  E.t.state.meta.stickerPacks[0].stickers[0] === "data:image/jpeg;base64,LEGACY");

// marker helpers
check("stripEmo removes a complete marker", E.t.stripEmo("别难过，我在。\n[[emo:悲伤]]") === "别难过，我在。");
check("stripEmo removes a half-streamed marker", E.t.stripEmo("别难过 [[emo:悲") === "别难过");
check("extractEmoCats reads the category", JSON.stringify(E.t.extractEmoCats("a\n[[emo:悲伤]]")) === '["悲伤"]');
check("extractEmoCats on clean text", E.t.extractEmoCats("普通回复").length === 0);

// instruction only lists packs that actually have images
const instr = E.t.buildStickerInstruction();
check("sticker instruction mentions pack name", instr.indexOf("默认") >= 0 && instr.indexOf("[[emo:") >= 0);

// probability 100 -> sticker is sent
const ePacks = E.t.state.meta.stickerPacks;
ePacks[0].name = "悲伤";
ePacks[0].prob = 100;
E.t.state.cur.stickerAuto = true;
vm.runInContext("Math.random = function () { return 0.1; }", E.sandbox);
E.t.state.cur.messages = [];
E.t.state.streamingId = null;
E.t.sendCore("今天好难过", []);
const eMsgId = E.calls.chat[0].msgId;
check("sticker rule injected into system when enabled", E.calls.chat[0].system.indexOf("[[emo:") >= 0);
E.sandbox.__bridge.onChunk(JSON.stringify({ id: eMsgId, c: "抱抱你。\n[[emo:悲伤]]", r: "" }));
E.sandbox.__bridge.onDone(JSON.stringify({ id: eMsgId }));
const eMsgs = E.t.state.cur.messages;
check("sticker message appended on hit", eMsgs.some((m) => m.kind === "sticker"), JSON.stringify(eMsgs.map((m) => m.kind || m.role)));
const eReply = eMsgs.filter((m) => m.id === eMsgId)[0];
check("marker stripped from the reply", eReply.content.indexOf("[[emo") < 0, eReply.content);
check("reply keeps the visible text", eReply.content.indexOf("抱抱你") >= 0, eReply.content);

// probability 0 -> no sticker
ePacks[0].prob = 0;
E.t.state.streamingId = null;
E.t.state.cur.messages = [];
E.t.sendCore("再难过一次", []);
const e2 = E.calls.chat[1].msgId;
E.sandbox.__bridge.onChunk(JSON.stringify({ id: e2, c: "嗯。\n[[emo:悲伤]]", r: "" }));
E.sandbox.__bridge.onDone(JSON.stringify({ id: e2 }));
check("prob 0 never sends a sticker", !E.t.state.cur.messages.some((m) => m.kind === "sticker"));

// unknown category -> marker stripped, nothing sent
ePacks[0].prob = 100;
E.t.state.streamingId = null;
E.t.state.cur.messages = [];
E.t.sendCore("未知分类", []);
const e3 = E.calls.chat[2].msgId;
E.sandbox.__bridge.onChunk(JSON.stringify({ id: e3, c: "好的。\n[[emo:不存在]]", r: "" }));
E.sandbox.__bridge.onDone(JSON.stringify({ id: e3 }));
check("unknown category sends nothing", !E.t.state.cur.messages.some((m) => m.kind === "sticker"));
check("unknown marker still stripped", E.t.state.cur.messages.filter((m) => m.id === e3)[0].content.indexOf("[[emo") < 0);

// auto sticker stays off by default
check("sticker auto off by default", createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1" }).t.state.cur.stickerAuto === false);

// sticker messages never leak into the prompt history
const hist = E.t.buildHistory(E.t.state.cur, null);
check("sticker messages excluded from history", hist.every((m) => typeof m.content === "string" && m.content.length > 0));

// ================================================================ keyless search engines
const F = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" },
  { avatars: {}, stickers: [], search: { engine: "duckduckgo" }, hasSearchKey: false });

check("duckduckgo needs no key", F.t.engineNeedsKey() === false);
check("search is ready without any key", F.t.searchReady() === true);
F.t.state.meta.search.engine = "tavily";
check("tavily needs a key", F.t.engineNeedsKey() === true);
check("tavily without a key is not ready", F.t.searchReady() === false);
F.t.state.meta.search.engine = "bing";
check("bing needs no key", F.t.searchReady() === true);
check("browser url uses bing", F.t.browserSearchUrl("a b").indexOf("bing.com/search?q=a%20b") >= 0, F.t.browserSearchUrl("a b"));
F.t.state.meta.search.engine = "baidu";
check("browser url uses baidu", F.t.browserSearchUrl("tianqi").indexOf("baidu.com/s?wd=") >= 0);
F.t.state.meta.search.engine = "duckduckgo";
check("browser url uses duckduckgo", F.t.browserSearchUrl("x").indexOf("duckduckgo.com/?q=x") >= 0);

F.t.state.cur.webSearch = true;
F.t.state.cur.messages = [];
F.t.state.streamingId = null;
F.t.sendCore("查一下美元兑人民币汇率", []);
F.sandbox.__bridge.onDone(JSON.stringify({
  id: F.calls.chat[0].msgId,
  tools: [{ id: "f1", name: "web_search", args: '{"query":"美元 人民币 汇率"}' }]
}));
check("keyless engine searches without a key", F.calls.search.length === 1, "calls=" + JSON.stringify(F.calls.search));
F.sandbox.__bridge.onSearch(JSON.stringify({ ok: true, text: "1. 汇率\n   https://fx.example", engine: "bing" }));
check("keyless search result injected",
  JSON.stringify(F.calls.chat[1].messages).indexOf("fx.example") >= 0);
// ================================================================ chat background
E.t.state.meta.chatBackground = { preset: "dusk", image: "", dim: 0.5 };
E.t.applyBackground();
const bgEl = E.doc.querySelector("#messages");
check("preset background applied", bgEl.style.backgroundImage.indexOf("linear-gradient") >= 0, bgEl.style.backgroundImage);

E.t.state.meta.chatBackground = { preset: "none", image: "data:image/jpeg;base64,CCC", dim: 0.3 };
E.t.applyBackground();
check("image background applied", bgEl.style.backgroundImage.indexOf("url(") >= 0);
check("image background honours dim", bgEl.style.backgroundImage.indexOf("0.3") >= 0, bgEl.style.backgroundImage);
check("image background uses cover", bgEl.style.backgroundSize.indexOf("cover") >= 0, bgEl.style.backgroundSize);

E.t.state.meta.chatBackground = { preset: "none", image: "", dim: 0.45 };
E.t.applyBackground();
check("background cleared", bgEl.style.backgroundImage === "");

E.sandbox.__bridge.onBackground(JSON.stringify({ dataUrl: "data:image/jpeg;base64,DDD" }));
check("onBackground stores the image", E.t.state.meta.chatBackground.image === "data:image/jpeg;base64,DDD");
check("onBackground resets preset", E.t.state.meta.chatBackground.preset === "none");
check("background persisted to native",
  E.calls.meta.some((m) => m.chatBackground && m.chatBackground.image === "data:image/jpeg;base64,DDD"));
// ================================================================ native tool calls
const H = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
H.t.state.cur.webSearch = true;
H.t.state.cur.messages = [];
H.t.sendCore("驻京观是什么", []);
check("tools are attached to the request",
  Array.isArray(H.calls.chat[0].tools) && H.calls.chat[0].tools[0]["function"].name === "web_search");
check("tool schema declares query",
  JSON.stringify(H.calls.chat[0].tools[0]["function"].parameters).indexOf("query") >= 0);

const hId = H.calls.chat[0].msgId;
H.sandbox.__bridge.onDone(JSON.stringify({
  id: hId,
  tools: [{ id: "call_1", name: "web_search", args: '{"query":"驻京观 是什么"}' }]
}));
check("native tool call triggers a search", H.calls.search.length === 1 && H.calls.search[0] === "驻京观 是什么", JSON.stringify(H.calls.search));
const hTool = H.t.state.cur.messages.filter((m) => m.role === "tool")[0];
check("tool message keeps the call id", hTool.toolCallId === "call_1");

H.sandbox.__bridge.onSearch(JSON.stringify({ ok: true, text: "1. 驻京观\n   https://temple.example", engine: "bing" }));
check("continuation issued after tool result", H.calls.chat.length === 2);
const hCont = H.calls.chat[1];
const hHist = hCont.messages;
const hAsst = hHist.filter((m) => m.role === "assistant" && m.tool_calls)[0];
const hToolMsg = hHist.filter((m) => m.role === "user" && String(m.content).indexOf("搜索结果") >= 0)[0];
check("results are re-injected as a user message",
  !!hToolMsg && hToolMsg.role === "user" && hToolMsg.content.indexOf("搜索结果") >= 0);
check("tool result carries the snippets", hToolMsg.content.indexOf("temple.example") >= 0);
check("no tool_calls echoed back to the endpoint", !hAsst);
check("no role:tool messages in the payload", !hHist.some((m) => m.role === "tool"));
check("tools stay available on continuation", Array.isArray(hCont.tools));

// malformed arguments still yield a query
const H2 = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
H2.t.state.cur.webSearch = true;
H2.t.state.cur.messages = [];
H2.t.sendCore("北京新闻", []);
H2.sandbox.__bridge.onDone(JSON.stringify({
  id: H2.calls.chat[0].msgId,
  tools: [{ id: "call_2", name: "web_search", args: '{"query": "北京 今日新闻"' }]
}));
check("broken json arguments are salvaged", H2.calls.searchNews[0] === "北京 今日新闻", JSON.stringify(H2.calls.searchNews));

// tool call for an unknown function is ignored (no crash, no search)
const H3 = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
H3.t.state.cur.webSearch = true;
H3.t.state.cur.messages = [];
H3.t.sendCore("你好", []);
H3.sandbox.__bridge.onDone(JSON.stringify({ id: H3.calls.chat[0].msgId, tools: [{ id: "c3", name: "other_tool", args: "{}" }] }));
check("unknown tool is ignored", H3.calls.search.length === 0);
// enabled but the model chose not to search -> visible marker, no extra request
const I = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
I.t.state.cur.webSearch = true;
I.t.state.cur.messages = [];
I.t.sendCore("讲个笑话", []);
const iId = I.calls.chat[0].msgId;
I.sandbox.__bridge.onChunk(JSON.stringify({ id: iId, c: "从前有座山。", r: "" }));
I.sandbox.__bridge.onDone(JSON.stringify({ id: iId }));
check("no search when the model declines", I.calls.search.length === 0);
check("message flagged as not-searched", I.t.state.cur.messages.filter((m) => m.id === iId)[0].noSearch === true);
check("still only one model call", I.calls.chat.length === 1);
// OpenRouter needs require_parameters so tools are not silently dropped
const J = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
J.t.state.cur.webSearch = true;
J.t.state.cur.messages = [];
J.t.sendCore("驻京观是什么", []);
check("openrouter requests set requireParams", J.calls.chat[0].requireParams === true);

const J2 = createApp({
  providers: [{ id: "p2", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", models: [{ id: "deepseek-chat" }], hasKey: true }],
  sessions: [], activeProviderId: "p2", version: "1.0"
});
J2.t.state.cur.webSearch = true;
J2.t.state.cur.messages = [];
J2.t.sendCore("驻京观是什么", []);
check("non-openrouter requests skip requireParams", !J2.calls.chat[0].requireParams);
check("non-openrouter still gets tools", Array.isArray(J2.calls.chat[0].tools));

// search disabled -> neither tools nor requireParams
const J3 = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
J3.t.state.cur.webSearch = false;
J3.t.sendCore("你好", []);
check("tools omitted when search is off", J3.calls.chat[0].tools === undefined);
check("requireParams omitted when search is off", !J3.calls.chat[0].requireParams);
// JSON null must never leak into the transcript
const K = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
K.t.state.cur.messages = [];
K.t.sendCore("测试 null", []);
const kId = K.calls.chat[0].msgId;
K.sandbox.__bridge.onChunk(JSON.stringify({ id: kId, c: "正常", r: null }));
K.sandbox.__bridge.onChunk(JSON.stringify({ id: kId, c: null, r: "思考" }));
K.sandbox.__bridge.onChunk(JSON.stringify({ id: kId, c: "null", r: "null" }));
const kMsg = K.t.state.cur.messages.filter((m) => m.id === kId)[0];
check("literal null chunks are dropped", kMsg.content === "正常", JSON.stringify(kMsg.content));
check("literal null reasoning is dropped", kMsg.reasoning === "思考", JSON.stringify(kMsg.reasoning));
// news queries go to the news vertical instead of generic web search
check("news hint matches typical asks", D.t.isNewsQuery("北京 新闻") && D.t.isNewsQuery("今日热点"));
check("non-news query stays on web search", !D.t.isNewsQuery("快速排序算法"));

const L = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
L.t.state.cur.webSearch = true;
L.t.state.cur.messages = [];
L.t.sendCore("北京今天有什么新闻", []);
L.sandbox.__bridge.onDone(JSON.stringify({
  id: L.calls.chat[0].msgId,
  tools: [{ id: "c_news", name: "web_search", args: '{"query":"北京 新闻"}' }]
}));
check("news tool call uses the news vertical", L.calls.searchNews.length === 1 && L.calls.searchNews[0] === "北京 新闻",
  JSON.stringify(L.calls.searchNews));
check("news call does not hit generic search", L.calls.search.length === 0);

L.sandbox.__bridge.onSearch(JSON.stringify({ ok: true, text: "1. 标题（2小时前）\n   https://news.example", engine: "news" }));
check("news results are re-injected",
  JSON.stringify(L.calls.chat[1].messages).indexOf("news.example") >= 0);
// ================================================================ sticker tool
const M = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
M.t.state.cur.stickerAuto = true;
M.t.state.stickers = { tree: true, categories: [{ name: "开心", count: 3 }, { name: "傲娇", count: 1 }] };
M.t.state.cur.messages = [];
M.t.sendCore("讲个笑话", []);
const mtools = M.calls.chat[0].tools || [];
check("send_sticker tool is declared", mtools.some((x) => x["function"].name === "send_sticker"));
const stickerTool = mtools.filter((x) => x["function"].name === "send_sticker")[0];
check("sticker tool lists categories in description",
  JSON.stringify(stickerTool["function"].parameters).indexOf("傲娇") >= 0);
check("sticker tool has no enum (deepseek compat)",
  JSON.stringify(stickerTool["function"].parameters).indexOf("enum") < 0);

const mId = M.calls.chat[0].msgId;
M.sandbox.__bridge.onChunk(JSON.stringify({ id: mId, c: "哈哈哈", r: "" }));
M.sandbox.__bridge.onDone(JSON.stringify({
  id: mId,
  tools: [{ id: "c_st", name: "send_sticker", args: '{"category":"傲娇"}' }]
}));
check("sticker tool call requests a sticker", M.calls.stickers.indexOf("傲娇") >= 0, JSON.stringify(M.calls.stickers));

// unknown category is ignored
M.t.state.streamingId = null;
M.t.state.cur.messages = [];
M.t.sendCore("再来一个", []);
M.sandbox.__bridge.onDone(JSON.stringify({
  id: M.calls.chat[1].msgId,
  tools: [{ id: "c_st2", name: "send_sticker", args: '{"category":"不存在"}' }]
}));
check("unknown sticker category is ignored", M.calls.stickers.filter((c) => c === "不存在").length === 0);

// no sticker tool when the switch is off
const N = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
N.t.state.stickers = { tree: true, categories: [{ name: "开心", count: 3 }] };
N.t.state.cur.stickerAuto = false;
N.t.sendCore("你好", []);
check("sticker tool hidden when auto is off",
  !(N.calls.chat[0].tools || []).some((x) => x["function"].name === "send_sticker"));
// sticker-only reply must not leave an empty bubble with an error
const O = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
O.t.state.cur.stickerAuto = true;
O.t.state.stickers = { tree: true, categories: [{ name: "吃惊", count: 2 }] };
O.t.state.cur.messages = [];
O.t.sendCore("再来一个", []);
const oId = O.calls.chat[0].msgId;
O.sandbox.__bridge.onDone(JSON.stringify({
  id: oId,
  tools: [{ id: "c_o1", name: "send_sticker", args: '{"category":"吃惊"}' }]
}));
const oMsg = O.t.state.cur.messages.filter((m) => m.id === oId)[0];
check("sticker-only reply removes the empty bubble", !oMsg);
check("sticker request still fired", O.calls.stickers.indexOf("吃惊") >= 0);
check("no error message for tool-only replies",
  !O.t.state.cur.messages.some((m) => m.error === "模型没有返回内容"));
// ================================================================ TTS
const P = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
P.t.state.cur.messages = [];
P.t.state.cur.autoRead = false;
P.t.sendCore("你好", []);
const pId = P.calls.chat[0].msgId;
P.sandbox.__bridge.onChunk(JSON.stringify({ id: pId, c: "第一句。第二句！", r: "" }));
P.sandbox.__bridge.onDone(JSON.stringify({ id: pId, tools: [] }));
check("no speech when auto-read is off", P.calls.speech.length === 0);

const Q = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
Q.t.state.cur.messages = [];
Q.t.state.cur.autoRead = true;
Q.t.sendCore("再来", []);
const qId = Q.calls.chat[0].msgId;
Q.sandbox.__bridge.onChunk(JSON.stringify({ id: qId, c: "好的。", r: "" }));
Q.sandbox.__bridge.onDone(JSON.stringify({ id: qId, tools: [] }));
check("auto-read speaks the reply", Q.calls.speech.length === 1, JSON.stringify(Q.calls.speech));
check("speech text has no markup", Q.calls.speech[0].indexOf("**") < 0);

Q.sandbox.__bridge.onTts(JSON.stringify({ state: "done", detail: "api" }));
check("tts done clears speaking state", Q.t.state.tts.speakingId === "");
// 分类名容错：模型给了带引号/空格的分类，应匹配到真实分类
const FZ = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
FZ.t.state.cur.stickerAuto = true;
FZ.t.state.stickers = { tree: true, categories: [{ name: "悲伤", count: 2 }] };
FZ.t.state.cur.messages = [];
FZ.t.sendCore("叹口气", []);
FZ.sandbox.__bridge.onDone(JSON.stringify({
  id: FZ.calls.chat[0].msgId,
  tools: [{ id: "f1", name: "send_sticker", args: '{"category":"「悲伤」"}' }]
}));
check("fuzzy match strips quotes around category", FZ.calls.stickers.indexOf("悲伤") >= 0, JSON.stringify(FZ.calls.stickers));

// 完全不相关的分类不应乱配
const FZ2 = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
FZ2.t.state.cur.stickerAuto = true;
FZ2.t.state.stickers = { tree: true, categories: [{ name: "开心", count: 1 }] };
FZ2.t.state.cur.messages = [];
FZ2.t.sendCore("随便说说", []);
FZ2.sandbox.__bridge.onDone(JSON.stringify({
  id: FZ2.calls.chat[0].msgId,
  tools: [{ id: "g1", name: "send_sticker", args: '{"category":"愤怒"}' }]
}));
check("unrelated category is not force-matched", FZ2.calls.stickers.length === 0, JSON.stringify(FZ2.calls.stickers));
// 全局兜底：100% 时模型没发也会补「默认」分类
const GS = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
GS.t.state.cur.stickerAuto = true;
GS.t.state.meta.stickerGlobal = 100;
GS.t.state.stickers = { tree: true, categories: [{ name: "默认", count: 3 }, { name: "开心", count: 2 }] };
GS.t.state.cur.messages = [];
GS.t.sendCore("今天天气还不错吧", []);
GS.sandbox.__bridge.onChunk(JSON.stringify({ id: GS.calls.chat[0].msgId, c: "今天天气确实不错，适合出门走走。", r: "" }));
GS.sandbox.__bridge.onDone(JSON.stringify({ id: GS.calls.chat[0].msgId, tools: [] }));
check("global 100% sends default sticker when model silent", GS.calls.stickers.indexOf("默认") >= 0, JSON.stringify(GS.calls.stickers));

// 「默认」不出现在给模型的分类列表里
const names = JSON.stringify((GS.calls.chat[0].tools || []));
check("default category hidden from model tool schema", names.indexOf("默认") < 0);

// 报错轮不发
const GE = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
GE.t.state.cur.stickerAuto = true;
GE.t.state.meta.stickerGlobal = 100;
GE.t.state.stickers = { tree: true, categories: [{ name: "默认", count: 3 }] };
GE.t.state.cur.messages = [];
GE.t.sendCore("随便", []);
GE.sandbox.__bridge.onDone(JSON.stringify({ id: GE.calls.chat[0].msgId, tools: [], err: "出错了" }));
check("no sticker on error turn", GE.calls.stickers.length === 0, JSON.stringify(GE.calls.stickers));
// 降级重试前，前端应清空已收到的半截内容（避免重复显示）
const RS = createApp({ providers: [PROVIDER], sessions: [], activeProviderId: "p1", version: "1.0" });
RS.t.state.cur.messages = [];
RS.t.sendCore("讲个故事", []);
const rid = RS.calls.chat[0].msgId;
RS.sandbox.__bridge.onChunk(JSON.stringify({ id: rid, c: "从前有座山", r: "先想想要怎么开头" }));
const rmsg = RS.t.state.cur.messages.filter((x) => x.id === rid)[0];
check("chunk accumulates content", rmsg.content === "从前有座山", rmsg.content);
check("chunk accumulates reasoning", rmsg.reasoning === "先想想要怎么开头", rmsg.reasoning);
RS.sandbox.__bridge.onReset(JSON.stringify({ id: rid }));
check("reset clears content", rmsg.content === "", rmsg.content);
check("reset clears reasoning", rmsg.reasoning === "", rmsg.reasoning);
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
