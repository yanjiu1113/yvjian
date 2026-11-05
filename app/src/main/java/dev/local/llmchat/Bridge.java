package dev.local.llmchat;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JS <-> native bridge. All network work happens here (Java), so the WebView never
 * performs CORS-bound requests and never sees the API keys.
 */
public class Bridge {

    private static final String TAG = "LLMChat";
    private static final int RC_IMAGE = 1001;
    private static final int RC_EXPORT = 1002;
    private static final int RC_IMPORT = 1003;
    private static final int RC_SMALL = 1004;
    private static final int RC_BG = 1005;
    private static final int RC_STICKER_DIR = 1006;

    private final Activity act;
    private final WebView web;
    private final Store store;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newFixedThreadPool(3);

    private volatile Http.Job job;
    private volatile boolean streaming;

    // 本轮 token 用量（模型带 usage 时才更新）
    private volatile int turnPrompt = 0;
    private volatile int turnCompletion = 0;
    private volatile String jobMsgId = "";
    private volatile boolean overlayOpen = false;
    private final StringBuilder bufC = new StringBuilder();
    private final StringBuilder bufR = new StringBuilder();
    private volatile String pendingExport = "";
    private volatile String smallTag = "";
    private volatile int smallSize = 192;

    public Bridge(Activity a, WebView w) {
        this.act = a;
        this.web = w;
        this.store = new Store(a);
    }

    // ---------------------------------------------------------------- plumbing

    private void emit(String method, JSONObject payload) {
        final String code = "window.__bridge && window.__bridge." + method + "("
                + JSONObject.quote(payload.toString()) + ");";
        main.post(() -> {
            try {
                web.evaluateJavascript(code, null);
            } catch (Exception ignored) {
            }
        });
    }

    private void emitError(String msgId, String message) {
        JSONObject p = new JSONObject();
        try {
            p.put("id", msgId);
            p.put("msg", message == null ? "未知错误" : message);
        } catch (Exception ignored) {
        }
        emit("onError", p);
    }

    private void emitToast(String msg) {
        JSONObject p = new JSONObject();
        try {
            p.put("msg", msg);
        } catch (Exception ignored) {
        }
        emit("onToast", p);
    }

    /** Line for the in-app diagnostics panel (设置 → 诊断). */
    private void emitDebug(String tag, String msg) {
        JSONObject p = new JSONObject();
        try {
            p.put("tag", tag);
            p.put("msg", msg == null ? "" : msg);
        } catch (Exception ignored) {
        }
        emit("onDebug", p);
    }

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            flushChunk();
            if (streaming) main.postDelayed(this, 40);
        }
    };

    private void flushChunk() {
        String c;
        String r;
        synchronized (bufC) {
            c = bufC.toString();
            bufC.setLength(0);
        }
        synchronized (bufR) {
            r = bufR.toString();
            bufR.setLength(0);
        }
        if (c.isEmpty() && r.isEmpty()) return;
        JSONObject p = new JSONObject();
        try {
            p.put("id", jobMsgId);
            p.put("c", c);
            p.put("r", r);
        } catch (Exception ignored) {
        }
        emit("onChunk", p);
    }

    // ---------------------------------------------------------------- bootstrap

    @JavascriptInterface
    public String boot() {
        JSONObject o = new JSONObject();
        try {
            JSONArray provs = store.providers();
            for (int i = 0; i < provs.length(); i++) {
                JSONObject p = provs.getJSONObject(i);
                p.put("hasKey", store.hasKey(p.optString("id")));
            }
            o.put("providers", provs);
            o.put("sessions", new JSONArray(store.list()));
            o.put("activeProviderId", store.activeProvider());
            o.put("version", "1.0");
        } catch (Exception e) {
            Log.e(TAG, "boot failed", e);
        }
        return o.toString();
    }

    /** JS sends the provider list, with an optional plain "key" field for new/changed keys. */
    @JavascriptInterface
    public void saveProviders(String json) {
        try {
            JSONArray in = new JSONArray(json);
            JSONArray out = new JSONArray();
            java.util.Set<String> keep = new java.util.HashSet<>();
            for (int i = 0; i < in.length(); i++) {
                JSONObject p = in.getJSONObject(i);
                String id = p.optString("id", "");
                if (id.isEmpty()) continue;
                String key = p.optString("key", "");
                if (!key.isEmpty()) store.setKey(id, key);
                p.remove("key");
                p.put("hasKey", store.hasKey(id));
                keep.add(id);
                out.put(p);
            }
            for (String id : store.keyIds()) {
                if (!keep.contains(id)) store.removeKey(id);
            }
            store.setProviders(out);
            JSONObject ack = new JSONObject();
            ack.put("providers", out);
            emit("onProviders", ack);
        } catch (Exception e) {
            emitToast("保存服务商失败: " + e.getMessage());
        }
    }

    @JavascriptInterface
    public void setActiveProvider(String id) {
        store.setActiveProvider(id);
    }

    /** Tracks whether a drawer/sheet/page overlay is open so the back key can close it first. */
    @JavascriptInterface
    public void setOverlay(boolean open) {
        overlayOpen = open;
    }

    public boolean isOverlayOpen() {
        return overlayOpen;
    }

    @JavascriptInterface
    public void fetchModels(String providerId) {
        pool.execute(() -> {
            JSONObject p = new JSONObject();
            try {
                String baseUrl = "";
                JSONArray provs = store.providers();
                for (int i = 0; i < provs.length(); i++) {
                    JSONObject pr = provs.getJSONObject(i);
                    if (pr.optString("id").equals(providerId)) {
                        baseUrl = pr.optString("baseUrl");
                        break;
                    }
                }
                String key = store.key(providerId);
                if (baseUrl.isEmpty()) throw new Exception("未找到该服务商");
                if (key.isEmpty()) throw new Exception("该服务商还没有填写 API Key");
                JSONArray models = Http.fetchModels(baseUrl, key);
                p.put("providerId", providerId);
                p.put("ok", true);
                p.put("models", models);
            } catch (Exception e) {
                try {
                    p.put("providerId", providerId);
                    p.put("ok", false);
                    p.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
                } catch (Exception ignored) {
                }
            }
            emit("onModels", p);
        });
    }

    // ---------------------------------------------------------------- chat

    @JavascriptInterface
    public void chat(String payload) {
        try {
            JSONObject p = new JSONObject(payload);
            String msgId = p.optString("msgId", "");
            String providerId = p.optString("providerId", "");

            String baseUrl = "";
            JSONArray provs = store.providers();
            for (int i = 0; i < provs.length(); i++) {
                JSONObject pr = provs.getJSONObject(i);
                if (pr.optString("id").equals(providerId)) {
                    baseUrl = pr.optString("baseUrl");
                    break;
                }
            }
            String key = store.key(providerId);
            if (baseUrl.isEmpty()) {
                emitError(msgId, "没有找到该服务商，请到设置里添加");
                return;
            }
            if (key.isEmpty()) {
                emitError(msgId, "还没有填写 API Key");
                return;
            }
            String model = p.optString("model", "");
            if (model.isEmpty()) {
                emitError(msgId, "还没有选择模型");
                return;
            }

            JSONObject body = new JSONObject();
            body.put("model", model);
            body.put("stream", p.optBoolean("stream", true));

            JSONArray msgs = new JSONArray(p.optString("messages", "[]"));
            JSONArray out = new JSONArray();
            String system = p.optString("system", "");
            if (!system.isEmpty()) {
                JSONObject sys = new JSONObject();
                sys.put("role", "system");
                sys.put("content", system);
                out.put(sys);
            }
            for (int i = 0; i < msgs.length(); i++) out.put(msgs.get(i));
            body.put("messages", out);

            double temp = p.optDouble("temperature", -1);
            if (temp >= 0 && temp <= 2) body.put("temperature", temp);
            int maxTok = p.optInt("maxTokens", 0);
            if (maxTok > 0) body.put("max_tokens", maxTok);
            double topP = p.optDouble("topP", -1);
            if (topP >= 0 && topP <= 1) body.put("top_p", topP);

            JSONObject streamOpts = p.optJSONObject("streamOptions");
            if (streamOpts != null && body.optBoolean("stream", false)) {
                body.put("stream_options", streamOpts);
            }

            JSONArray tools = p.optJSONArray("tools");
            if (tools != null && tools.length() > 0) {
                body.put("tools", tools);
                body.put("tool_choice", "auto");
                // OpenRouter silently routes to providers that ignore unknown fields (e.g. tools);
                // require_parameters forces a provider that actually supports them.
                if (p.optBoolean("requireParams", false)) {
                    JSONObject prov = new JSONObject();
                    prov.put("require_parameters", true);
                    body.put("provider", prov);
                }
            }
            Log.d(TAG, "chat model=" + model + " tools=" + (tools == null ? 0 : tools.length())
                    + " msgs=" + out.length() + " sys=" + system.length());

            stop();

            final Http.Job j = new Http.Job();
            job = j;
            jobMsgId = msgId;
            synchronized (bufC) {
                bufC.setLength(0);
            }
            synchronized (bufR) {
                bufR.setLength(0);
            }
            streaming = true;
            turnPrompt = 0;
            turnCompletion = 0;
            main.post(ticker);

            startStream(j, msgId, baseUrl, key, body, 0);
        } catch (Exception e) {
            emitError("", "请求构造失败: " + e.getMessage());
        }
    }

    private static boolean looksLikeToolRejection(String message) {
        if (message == null) return false;
        String m = message.toLowerCase();
        if (m.indexOf("tool") < 0 && m.indexOf("function") < 0) return false;
        return m.indexOf("400") >= 0 || m.indexOf("422") >= 0 || m.indexOf("404") >= 0
                || m.indexOf("unsupport") >= 0 || m.indexOf("unknown") >= 0
                || m.indexOf("invalid") >= 0 || m.indexOf("unrecognized") >= 0;
    }

    /**
     * 逐级降级重试：0 原样 → 1 简化表情 schema（去掉 enum）→ 2 去掉表情工具 → 3 去掉全部工具。
     * 有些模型（如 deepseek-v4-pro）在挂上带 enum 的工具后直接返回空内容。
     */
    private void startStream(final Http.Job j, final String msgId, final String base, final String key,
                             final JSONObject body, final int stage) {
        final JSONArray[] acc = new JSONArray[1];
        pool.execute(() -> Http.streamChat(base, key, body, j, new Http.Listener() {
            @Override
            public void onDelta(String content, String reasoning) {
                synchronized (bufC) {
                    bufC.append(content);
                }
                synchronized (bufR) {
                    bufR.append(reasoning);
                }
            }

            @Override
            public void onUsage(int prompt, int completion) {
                turnPrompt = prompt;
                turnCompletion = completion;
            }

            @Override
            public void onToolCalls(JSONArray calls) {
                acc[0] = calls;
                Log.d(TAG, "tool_calls n=" + (calls == null ? 0 : calls.length()));
            }

            @Override
            public void onDone() {
                // 注意：模型可能只吐了空格/换行，必须用 trim 判断，否则降级链永远不触发
                String gotText = bufC.toString().trim();
                emitDebug("tools", "请求结束 stage=" + stage
                        + " content=" + bufC.length()
                        + " reasoning=" + bufR.length()
                        + " toolCalls=" + (acc[0] == null ? 0 : acc[0].length()));
                // 思考内容也算有输出：否则推理模型（只有 reasoning_content、content 为空）
                // 会触发降级链，导致同一轮思考 2-3 遍
                boolean empty = gotText.isEmpty()
                        && bufR.toString().trim().isEmpty()
                        && (acc[0] == null || acc[0].length() == 0);
                if (empty) {
                    emitDebug("tools", "本轮空回复：content=" + bufC.length()
                            + " reasoning=" + bufR.length() + " stage=" + stage);
                }
                if (stage < 3 && body.has("tools") && empty) {
                    JSONObject next = downgrade(body, stage + 1);
                    if (next != null) {
                        synchronized (bufC) {
                            bufC.setLength(0);
                        }
                        synchronized (bufR) {
                            bufR.setLength(0);
                        }
                        acc[0] = null;
                        emitReset(msgId);
                        startStream(j, msgId, base, key, next, stage + 1);
                        return;
                    }
                }
                finish(j, msgId, true, null, acc[0]);
            }

            @Override
            public void onError(String message) {
                if (stage < 3 && body.has("tools") && looksLikeToolRejection(message)) {
                    JSONObject next = downgrade(body, 3);
                    if (next != null) {
                        Log.w(TAG, "endpoint rejected tools, retrying without them: " + message);
                        emitReset(msgId);
                        startStream(j, msgId, base, key, next, 3);
                        return;
                    }
                }
                finish(j, msgId, false, message, null);
            }
        }));
    }

    /** 构造下一级请求体（深拷贝后修改）。返回 null 表示无法再降级。 */
    private JSONObject downgrade(JSONObject body, int target) {
        try {
            JSONObject next = new JSONObject(body.toString());
            JSONArray tools = next.optJSONArray("tools");
            if (tools == null) return null;

            if (target >= 3) {
                next.remove("tools");
                next.remove("tool_choice");
                next.remove("parallel_tool_calls");
                emitDebug("tools", "去掉全部工具重试（模型对工具不兼容）");
                return next;
            }

            if (target == 2) {
                JSONArray kept = new JSONArray();
                for (int i = 0; i < tools.length(); i++) {
                    JSONObject t = tools.optJSONObject(i);
                    JSONObject fn = t == null ? null : t.optJSONObject("function");
                    String name = fn == null ? "" : fn.optString("name", "");
                    if (!"send_sticker".equals(name)) kept.put(t);
                }
                if (kept.length() == 0) return downgrade(body, 3);
                next.put("tools", kept);
                emitDebug("tools", "去掉表情工具重试（该模型多工具不兼容）");
                return next;
            }

            if (target == 1) {
                boolean changed = false;
                for (int i = 0; i < tools.length(); i++) {
                    JSONObject t = tools.optJSONObject(i);
                    JSONObject fn = t == null ? null : t.optJSONObject("function");
                    if (fn == null || !"send_sticker".equals(fn.optString("name", ""))) continue;
                    String cats = enumList(fn);
                    JSONObject cat = new JSONObject();
                    cat.put("type", "string");
                    cat.put("description", cats.isEmpty()
                            ? "情绪分类名" : ("情绪分类名，必须是以下之一：" + cats));
                    JSONObject props = new JSONObject();
                    props.put("category", cat);
                    JSONObject params = new JSONObject();
                    params.put("type", "object");
                    params.put("properties", props);
                    params.put("required", new JSONArray().put("category"));
                    fn.put("parameters", params);
                    changed = true;
                }
                if (!changed) return downgrade(body, 2);
                emitDebug("tools", "简化表情工具参数（去掉 enum）重试");
                return next;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static String enumList(JSONObject fn) {
        try {
            JSONObject p = fn.optJSONObject("parameters");
            JSONObject props = p == null ? null : p.optJSONObject("properties");
            JSONObject cat = props == null ? null : props.optJSONObject("category");
            JSONArray en = cat == null ? null : cat.optJSONArray("enum");
            if (en == null) return "";
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < en.length(); i++) {
                if (i > 0) sb.append("、");
                sb.append(en.optString(i));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** 通知前端丢弃该消息已收到的一半内容（降级重试前调用） */
    private void emitReset(String msgId) {
        JSONObject p = new JSONObject();
        try {
            p.put("id", msgId);
        } catch (Exception ignored) {
        }
        emit("onReset", p);
    }

    private void finish(Http.Job j, String msgId, boolean ok, String err, JSONArray toolCalls) {
        if (job != j) return; // superseded by a newer request
        streaming = false;
        job = null;
        jobMsgId = msgId;
        flushChunk();
        JSONObject p = new JSONObject();
        try {
            p.put("id", msgId);
            if (!ok && err != null) p.put("msg", err);
            if (ok && toolCalls != null && toolCalls.length() > 0) p.put("tools", toolCalls);
            if (ok && (turnPrompt > 0 || turnCompletion > 0)) {
                JSONObject u = new JSONObject();
                u.put("p", turnPrompt);
                u.put("c", turnCompletion);
                p.put("usage", u);
            }
        } catch (Exception ignored) {
        }
        emit(ok ? "onDone" : "onError", p);
    }

    /** 查询余额：按服务商地址依次尝试 DeepSeek / OpenRouter / one-api */
    @JavascriptInterface
    public void fetchBalance(String providerId) {
        final String pid = providerId == null ? "" : providerId;
        pool.execute(() -> {
            JSONObject out = new JSONObject();
            try {
                String baseUrl = "";
                JSONArray provs = store.providers();
                for (int i = 0; i < provs.length(); i++) {
                    JSONObject pr = provs.getJSONObject(i);
                    if (pr.optString("id").equals(pid)) {
                        baseUrl = pr.optString("baseUrl");
                        break;
                    }
                }
                String key = store.key(pid);
                if (baseUrl.isEmpty() || key.isEmpty()) throw new Exception("服务商未配置");
                out = probeBalance(baseUrl, key);
            } catch (Exception e) {
                try {
                    out.put("ok", false);
                    out.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
                } catch (Exception ignored) {
                }
            }
            emit("onBalance", out);
        });
    }

    private static String originOf(String baseUrl) {
        try {
            java.net.URL u = new java.net.URL(baseUrl);
            return u.getProtocol() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        } catch (Exception e) {
            return baseUrl;
        }
    }

    private JSONObject probeBalance(String baseUrl, String key) {
        String origin = originOf(baseUrl);
        String[] urls = new String[]{
                origin + "/user/balance",
                origin + "/api/v1/credits",
                origin + "/dashboard/billing/subscription",
                origin + "/v1/dashboard/billing/subscription"
        };
        Exception last = null;
        for (String url : urls) {
            try {
                JSONObject o = Http.getJson(url, key);
                if (o == null) continue;
                JSONObject r = parseBalance(o);
                if (r != null) return r;
            } catch (Exception e) {
                last = e;
            }
        }
        JSONObject fail = new JSONObject();
        try {
            fail.put("ok", false);
            fail.put("error", last == null ? "该服务商没有可用的余额接口" : ("查询失败：" + last.getMessage()));
        } catch (Exception ignored) {
        }
        return fail;
    }

    private JSONObject parseBalance(JSONObject o) {
        try {
            JSONArray infos = o.optJSONArray("balance_infos");
            if (infos != null && infos.length() > 0) {
                JSONObject info = infos.getJSONObject(0);
                JSONObject r = new JSONObject();
                r.put("ok", true);
                r.put("currency", info.optString("currency", "CNY"));
                r.put("balance", info.optDouble("total_balance", 0));
                r.put("source", "deepseek");
                return r;
            }
            JSONObject data = o.optJSONObject("data");
            if (data != null && data.has("total_credits")) {
                double credits = data.optDouble("total_credits", 0);
                double used = data.optDouble("total_usage", 0);
                JSONObject r = new JSONObject();
                r.put("ok", true);
                r.put("currency", "USD");
                r.put("balance", Math.round((credits - used) * 10000d) / 10000d);
                r.put("total", credits);
                r.put("used", used);
                r.put("source", "openrouter");
                return r;
            }
            if (o.has("hard_limit_usd") || o.has("system_hard_limit_usd")) {
                double limit = o.optDouble("hard_limit_usd", o.optDouble("system_hard_limit_usd", 0));
                JSONObject r = new JSONObject();
                r.put("ok", true);
                r.put("currency", "USD");
                r.put("balance", Math.round(limit * 100d) / 100d);
                r.put("source", "oneapi");
                return r;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    @JavascriptInterface
    public void stop() {
        Http.Job j = job;
        job = null;
        streaming = false;
        if (j != null) j.cancel();
    }

    // ---------------------------------------------------------------- sessions

    @JavascriptInterface
    public void saveSession(String json) {
        try {
            store.put(json);
        } catch (Exception e) {
            Log.e(TAG, "saveSession", e);
        }
    }

    @JavascriptInterface
    public String loadSession(String id) {
        return store.get(id);
    }

    @JavascriptInterface
    public String listSessions() {
        return store.list();
    }

    @JavascriptInterface
    public void deleteSession(String id) {
        store.delete(id);
    }

    // ---------------------------------------------------------------- files

    @JavascriptInterface
    public void exportFile(String name, String content) {
        pendingExport = content;
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("application/json");
        i.putExtra(Intent.EXTRA_TITLE, name);
        act.startActivityForResult(i, RC_EXPORT);
    }

    @JavascriptInterface
    public void importFile() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json", "text/plain", "application/octet-stream"});
        act.startActivityForResult(i, RC_IMPORT);
    }

    @JavascriptInterface
    public void pickImage() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("image/*");
        act.startActivityForResult(i, RC_IMAGE);
    }

    /** Picks an image and returns it as a small (avatar / sticker sized) data URL. */
    @JavascriptInterface
    public void pickSmallImage(int sizePx, String tag) {
        smallTag = tag == null ? "" : tag;
        smallSize = sizePx <= 0 ? 192 : Math.min(sizePx, 512);
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("image/*");
        act.startActivityForResult(i, RC_SMALL);
    }

    // ---------------------------------------------------------------- 朗读（CloneTTS 本地 API / 系统 TTS）

    private Tts tts;

    private Tts tts() {
        if (tts == null) {
            tts = new Tts(act, pool, (state, detail) -> {
                try {
                    JSONObject o = new JSONObject();
                    o.put("state", state);
                    o.put("detail", detail == null ? "" : detail);
                    emit("onTts", o);
                } catch (Exception ignored) {
                }
            });
        }
        return tts;
    }

    @JavascriptInterface
    public String ttsStatus() {
        return tts().status();
    }

    @JavascriptInterface
    public void ttsConfigure(String json) {
        try {
            JSONObject o = new JSONObject(json == null ? "{}" : json);
            tts().configure(o.optString("voice", ""), (float) o.optDouble("rate", 1.0),
                    o.optBoolean("preferApi", true));
        } catch (Exception ignored) {
        }
    }

    @JavascriptInterface
    public void ttsSpeak(String text) {
        tts().speak(text);
    }

    @JavascriptInterface
    public void ttsStop() {
        tts().stop();
    }

    /** 打开系统的「文字转语音」设置页，方便装引擎/选引擎。 */
    @JavascriptInterface
    public void openTtsSettings() {
        try {
            Intent i = new Intent("com.android.settings.TTS_SETTINGS");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            act.startActivity(i);
        } catch (Exception e) {
            try {
                Intent i = new Intent(android.provider.Settings.ACTION_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                act.startActivity(i);
            } catch (Exception ignored) {
                emitToast("打不开系统 TTS 设置");
            }
        }
    }
    /** Picks a chat background: long side capped at 1080px, aspect ratio kept. */
    @JavascriptInterface
    public void pickBackground() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("image/*");
        act.startActivityForResult(i, RC_BG);
    }

    // ---------------------------------------------------------------- 表情包（导入应用目录，子文件夹=情绪分类）

    private volatile JSONObject stickerState = new JSONObject();

    private File stickerRoot() {
        File d = new File(act.getFilesDir(), "stickers");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private static boolean isImage(String name) {
        if (name == null) return false;
        String n = name.toLowerCase();
        return n.endsWith(".gif") || n.endsWith(".png") || n.endsWith(".jpg")
                || n.endsWith(".jpeg") || n.endsWith(".webp");
    }

    private static String safeName(String name) {
        if (name == null) return "分类";
        String s = name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        if (s.isEmpty()) s = "分类";
        return s.length() > 40 ? s.substring(0, 40) : s;
    }

    private static String uniqueFile(File dir, String name) {
        String base = name;
        String ext = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0) {
            base = name.substring(0, dot);
            ext = name.substring(dot);
        }
        File f = new File(dir, name);
        int i = 1;
        while (f.exists()) {
            f = new File(dir, base + "-" + i + ext);
            i++;
        }
        return f.getName();
    }

    private static void copyStream(InputStream in, File dst) throws Exception {
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(dst)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
        }
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursive(k);
        f.delete();
    }

    /** 选一个文件夹：里面的每个子文件夹是一种情绪分类，图片/GIF 会被复制进应用目录。 */
    @JavascriptInterface
    public void importStickers() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        act.startActivityForResult(i, RC_STICKER_DIR);
    }

    @JavascriptInterface
    public String stickerInfo() {
        scanStickers();
        return stickerState.toString();
    }

    @JavascriptInterface
    public void rescanStickers() {
        pool.execute(() -> {
            scanStickers();
            emit("onStickerState", stickerState);
        });
    }

    @JavascriptInterface
    public void deleteStickerCategory(String category) {
        final String cat = safeName(category);
        pool.execute(() -> {
            deleteRecursive(new File(stickerRoot(), cat));
            scanStickers();
            emit("onStickerState", stickerState);
        });
    }

    @JavascriptInterface
    public void deleteSticker(String category, String file) {
        final String cat = safeName(category);
        final String name = file == null ? "" : file;
        pool.execute(() -> {
            new File(new File(stickerRoot(), cat), name).delete();
            scanStickers();
            emit("onStickerState", stickerState);
        });
    }

    @JavascriptInterface
    public String listStickerFiles(String category) {
        JSONArray arr = new JSONArray();
        File dir = new File(stickerRoot(), safeName(category));
        File[] files = dir.listFiles();
        if (files != null) {
            java.util.Arrays.sort(files, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
            for (File f : files) {
                if (!f.isFile() || !isImage(f.getName())) continue;
                try {
                    JSONObject o = new JSONObject();
                    o.put("name", f.getName());
                    o.put("url", stickerPublicUrl(safeName(category) + "/" + f.getName()));
                    arr.put(o);
                } catch (Exception ignored) {
                }
            }
        }
        return arr.toString();
    }

    /** 随机取一张指定分类的图，交给前端插入消息。 */
    @JavascriptInterface
    public void pickSticker(String category) {
        final String cat = safeName(category);
        pool.execute(() -> {
            JSONObject out = new JSONObject();
            try {
                File dir = new File(stickerRoot(), cat);
                File[] files = dir.listFiles();
                java.util.List<File> list = new java.util.ArrayList<>();
                if (files != null) for (File f : files) if (f.isFile() && isImage(f.getName())) list.add(f);
                if (list.isEmpty()) throw new Exception("分类「" + cat + "」里没有图");
                File pick = list.get((int) (Math.random() * list.size()));
                out.put("ok", true);
                out.put("category", cat);
                out.put("url", stickerPublicUrl(cat + "/" + pick.getName()));
            } catch (Exception e) {
                try {
                    out.put("ok", false);
                    out.put("category", cat);
                    out.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
                } catch (Exception ignored) {
                }
            }
            emit("onSticker", out);
        });
    }

    /** WebView 通过这个地址取图，GIF 也能动。 */
    public static String stickerPublicUrl(String relative) {
        return "https://llmchat.local/sticker?p=" + Uri.encode(relative);
    }

    /** 由 WebViewClient 调用：把表情文件流式返回给页面。 */
    public android.webkit.WebResourceResponse serveSticker(Uri request) {
        try {
            String rel = request.getQueryParameter("p");
            if (rel == null || rel.isEmpty() || rel.contains("..")) return null;
            File root = stickerRoot();
            File f = new File(root, rel);
            if (!f.getCanonicalPath().startsWith(root.getCanonicalPath())) return null;
            if (!f.isFile()) return null;
            return new android.webkit.WebResourceResponse(guessMime(f.getName()), "UTF-8",
                    new java.io.FileInputStream(f));
        } catch (Exception e) {
            return null;
        }
    }

    private static String guessMime(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".mp4")) return "video/mp4";
        return "image/jpeg";
    }

    private void scanStickers() {
        JSONArray cats = new JSONArray();
        JSONObject state = new JSONObject();
        int total = 0;
        try {
            File root = stickerRoot();
            File[] dirs = root.listFiles();
            if (dirs != null) {
                java.util.Arrays.sort(dirs, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
                for (File d : dirs) {
                    if (!d.isDirectory()) continue;
                    File[] files = d.listFiles();
                    int n = 0;
                    if (files != null) for (File f : files) if (f.isFile() && isImage(f.getName())) n++;
                    if (n == 0) continue;
                    total += n;
                    JSONObject c = new JSONObject();
                    c.put("name", d.getName());
                    c.put("count", n);
                    cats.put(c);
                }
            }
            state.put("ok", true);
            state.put("tree", total > 0);
            state.put("total", total);
            state.put("categories", cats);
        } catch (Exception e) {
            try {
                state.put("ok", false);
                state.put("categories", cats);
                state.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
            } catch (Exception ignored) {
            }
        }
        stickerState = state;
    }

    private interface ChildVisitor {
        void visit(String documentId, String name, String mime);
    }

    private void queryChildren(Uri childrenUri, ChildVisitor visitor) {
        try (android.database.Cursor c = act.getContentResolver().query(childrenUri,
                new String[]{
                        android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE
                }, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                String id = c.getString(0);
                String name = c.getString(1);
                String mime = c.getString(2);
                if (id == null || name == null) continue;
                visitor.visit(id, name, mime == null ? "" : mime);
            }
        } catch (Exception ignored) {
        }
    }

    /** 把选中文件夹里的分类和图片复制进应用目录（之后与原文件无关）。 */
    private void importFromTree(Uri treeUri) {
        int cats = 0;
        int files = 0;
        try {
            String rootId = android.provider.DocumentsContract.getTreeDocumentId(treeUri);
            Uri children = android.provider.DocumentsContract
                    .buildChildDocumentsUriUsingTree(treeUri, rootId);

            java.util.List<String[]> dirs = new java.util.ArrayList<>();
            queryChildren(children, (id, name, mime) -> {
                if ("vnd.android.document/directory".equals(mime)) dirs.add(new String[]{id, name});
            });

            for (String[] d : dirs) {
                String catName = safeName(d[1]);
                File catDir = new File(stickerRoot(), catName);
                if (!catDir.exists() && !catDir.mkdirs()) continue;
                Uri dirChildren = android.provider.DocumentsContract
                        .buildChildDocumentsUriUsingTree(treeUri, d[0]);
                final int[] copied = {0};
                queryChildren(dirChildren, (id, name, mime) -> {
                    if (!isImage(name)) return;
                    File dst = new File(catDir, uniqueFile(catDir, name));
                    try (InputStream in = act.getContentResolver().openInputStream(
                            android.provider.DocumentsContract.buildDocumentUriUsingTree(treeUri, id))) {
                        if (in == null) return;
                        copyStream(in, dst);
                        copied[0]++;
                    } catch (Exception ignored) {
                    }
                });
                if (copied[0] > 0) {
                    cats++;
                    files += copied[0];
                }
            }
            scanStickers();
            emit("onStickerState", stickerState);
            emitToast("已导入 " + cats + " 个分类、" + files + " 张图");
        } catch (Exception e) {
            scanStickers();
            emit("onStickerState", stickerState);
            emitToast("导入失败：" + (e.getMessage() == null ? e.toString() : e.getMessage()));
        }
    }

    public void onActivityResult(int req, int resCode, Intent data) {
        if (resCode != Activity.RESULT_OK || data == null) return;
        final Uri uri = data.getData();
        if (uri == null) return;
        if (req == RC_IMAGE) {
            pool.execute(() -> handleImage(uri));
        } else if (req == RC_EXPORT) {
            pool.execute(() -> writeExport(uri));
        } else if (req == RC_IMPORT) {
            pool.execute(() -> readImport(uri));
        } else if (req == RC_SMALL) {
            final String tag = smallTag;
            final int size = smallSize;
            pool.execute(() -> handleSmallImage(uri, size, tag));
        } else if (req == RC_BG) {
            pool.execute(() -> handleBackground(uri));
        } else if (req == RC_STICKER_DIR) {
            pool.execute(() -> importFromTree(uri));
        }
    }

    private void writeExport(Uri uri) {
        try (OutputStream os = act.getContentResolver().openOutputStream(uri, "wt")) {
            if (os == null) throw new Exception("无法写入");
            os.write(pendingExport.getBytes("UTF-8"));
            os.flush();
            emitToast("已导出");
        } catch (Exception e) {
            emitToast("导出失败: " + e.getMessage());
        } finally {
            pendingExport = "";
        }
    }

    private void readImport(Uri uri) {
        try (InputStream in = act.getContentResolver().openInputStream(uri)) {
            if (in == null) throw new Exception("无法读取");
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            int total = 0;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > 64 * 1024 * 1024) throw new Exception("文件过大");
                bo.write(buf, 0, n);
            }
            JSONObject p = new JSONObject();
            p.put("text", new String(bo.toByteArray(), "UTF-8"));
            emit("onImported", p);
        } catch (Exception e) {
            emitToast("导入失败: " + e.getMessage());
        }
    }

    private int rotationOf(Uri uri) {
        try (InputStream in = act.getContentResolver().openInputStream(uri)) {
            if (in == null) return 0;
            ExifInterface ex = new ExifInterface(in);
            int o = ex.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            if (o == ExifInterface.ORIENTATION_ROTATE_90) return 90;
            if (o == ExifInterface.ORIENTATION_ROTATE_180) return 180;
            if (o == ExifInterface.ORIENTATION_ROTATE_270) return 270;
        } catch (Exception ignored) {
        }
        return 0;
    }

    private void handleImage(Uri uri) {
        try {
            final int max = 1568;

            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            try (InputStream in = act.getContentResolver().openInputStream(uri)) {
                BitmapFactory.decodeStream(in, null, bounds);
            }
            int sample = 1;
            while (bounds.outWidth / sample > max * 2 || bounds.outHeight / sample > max * 2) sample *= 2;

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bmp;
            try (InputStream in = act.getContentResolver().openInputStream(uri)) {
                bmp = BitmapFactory.decodeStream(in, null, opts);
            }
            if (bmp == null) {
                emitToast("无法读取这张图片");
                return;
            }
            int rot = rotationOf(uri);
            if (rot != 0) {
                Matrix m = new Matrix();
                m.postRotate(rot);
                bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
            }
            int w = bmp.getWidth();
            int h = bmp.getHeight();
            if (w > max || h > max) {
                float s = max / (float) Math.max(w, h);
                Bitmap scaled = Bitmap.createScaledBitmap(bmp, Math.max(1, (int) (w * s)),
                        Math.max(1, (int) (h * s)), true);
                if (scaled != bmp) bmp.recycle();
                bmp = scaled;
            }
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 86, bo);
            byte[] bytes = bo.toByteArray();
            JSONObject p = new JSONObject();
            p.put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP));
            p.put("w", bmp.getWidth());
            p.put("h", bmp.getHeight());
            p.put("kb", bytes.length / 1024);
            bmp.recycle();
            emit("onImage", p);
        } catch (Exception e) {
            emitToast("图片处理失败: " + e.getMessage());
        }
    }

    /** Small crop/scale used for avatars and sticker slots (kept tiny so it fits in prefs). */
    private void handleSmallImage(Uri uri, int size, String tag) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            try (InputStream in = act.getContentResolver().openInputStream(uri)) {
                BitmapFactory.decodeStream(in, null, bounds);
            }
            int sample = 1;
            while (bounds.outWidth / sample > size * 3 || bounds.outHeight / sample > size * 3) sample *= 2;

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bmp;
            try (InputStream in = act.getContentResolver().openInputStream(uri)) {
                bmp = BitmapFactory.decodeStream(in, null, opts);
            }
            if (bmp == null) {
                emitToast("无法读取这张图片");
                return;
            }
            int rot = rotationOf(uri);
            if (rot != 0) {
                Matrix m = new Matrix();
                m.postRotate(rot);
                bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
            }
            int w = bmp.getWidth();
            int h = bmp.getHeight();
            int edge = Math.min(w, h);
            int sx = (w - edge) / 2;
            int sy = (h - edge) / 2;
            Bitmap square = Bitmap.createBitmap(bmp, sx, sy, edge, edge);
            Bitmap small = Bitmap.createScaledBitmap(square, size, size, true);

            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            small.compress(Bitmap.CompressFormat.JPEG, 84, bo);
            byte[] bytes = bo.toByteArray();
            JSONObject p = new JSONObject();
            p.put("tag", tag == null ? "" : tag);
            p.put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP));
            p.put("kb", bytes.length / 1024);
            if (small != square) small.recycle();
            if (square != bmp) square.recycle();
            bmp.recycle();
            emit("onSmallImage", p);
        } catch (Exception e) {
            emitToast("图片处理失败: " + e.getMessage());
        }
    }

    /** Background image: keeps the aspect ratio, long side <= 1080, JPEG quality 82. */
    private void handleBackground(Uri uri) {
        try {
            final int max = 1080;

            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            try (InputStream in = act.getContentResolver().openInputStream(uri)) {
                BitmapFactory.decodeStream(in, null, bounds);
            }
            int sample = 1;
            while (bounds.outWidth / sample > max * 2 || bounds.outHeight / sample > max * 2) sample *= 2;

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bmp;
            try (InputStream in = act.getContentResolver().openInputStream(uri)) {
                bmp = BitmapFactory.decodeStream(in, null, opts);
            }
            if (bmp == null) {
                emitToast("无法读取这张图片");
                return;
            }
            int rot = rotationOf(uri);
            if (rot != 0) {
                Matrix m = new Matrix();
                m.postRotate(rot);
                bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
            }
            int w = bmp.getWidth();
            int h = bmp.getHeight();
            if (w > max || h > max) {
                float s = max / (float) Math.max(w, h);
                Bitmap scaled = Bitmap.createScaledBitmap(bmp, Math.max(1, (int) (w * s)),
                        Math.max(1, (int) (h * s)), true);
                if (scaled != bmp) bmp.recycle();
                bmp = scaled;
            }
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 82, bo);
            byte[] bytes = bo.toByteArray();
            JSONObject p = new JSONObject();
            p.put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP));
            p.put("kb", bytes.length / 1024);
            bmp.recycle();
            emit("onBackground", p);
        } catch (Exception e) {
            emitToast("背景设置失败: " + e.getMessage());
        }
    }

    // ---------------------------------------------------------------- meta & search

    @JavascriptInterface
    public String loadMeta() {
        JSONObject o;
        try {
            o = new JSONObject(store.meta());
        } catch (Exception e) {
            o = new JSONObject();
        }
        try {
            o.put("hasSearchKey", store.hasKey("__search"));
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    @JavascriptInterface
    public void saveMeta(String json) {
        try {
            JSONObject o = new JSONObject(json);
            o.remove("hasSearchKey");
            store.setMeta(o.toString());
        } catch (Exception e) {
            emitToast("保存设置失败: " + e.getMessage());
        }
    }

    @JavascriptInterface
    public void saveSearchKey(String key) {
        if (key == null || key.trim().isEmpty()) store.removeKey("__search");
        else store.setKey("__search", key.trim());
    }

    /** Runs a web search on the configured engine and hands the snippets back to the UI. */
    @JavascriptInterface
    public void webSearch(String query) {
        final String q = query == null ? "" : query;
        pool.execute(() -> {
            JSONObject p = new JSONObject();
            try {
                if (q.trim().isEmpty()) throw new Exception("搜索词为空");

                String engine = Search.DEFAULT_ENGINE;
                try {
                    JSONObject meta = new JSONObject(store.meta());
                    JSONObject search = meta.optJSONObject("search");
                    if (search != null) engine = search.optString("engine", Search.DEFAULT_ENGINE);
                } catch (Exception ignored) {
                }

                String key = store.key("__search");
                boolean keyless = !Search.needsKey(engine);
                if (!keyless && key.isEmpty()) {
                    throw new Exception("这个搜索引擎需要 API Key，或改用内置的免 Key 引擎");
                }

                // 免 Key 引擎容易碰上改版/验证码，串行回退到其它两个
                java.util.List<String> order = new java.util.ArrayList<>();
                order.add(engine);
                if (keyless) {
                    for (String e : new String[]{Search.ENGINE_DDG, Search.ENGINE_BING, Search.ENGINE_BAIDU}) {
                        if (!e.equals(engine)) order.add(e);
                    }
                }

                String text = "";
                String lastError = null;
                String used = engine;
                for (String e : order) {
                    if (e != null && !e.equals(engine) && Search.needsKey(e)) continue;
                    try {
                        String got = Search.run(e, key, q);
                        if (got != null && !got.trim().isEmpty()) {
                            text = got;
                            used = e;
                            break;
                        }
                    } catch (Exception ex) {
                        lastError = ex.getMessage();
                    }
                }
                if (text.trim().isEmpty()) {
                    throw new Exception(lastError != null ? lastError
                            : "没有搜到结果（搜索引擎可能改版或触发了验证码）");
                }

                Log.d(TAG, "search engine=" + used + " q=" + q + " chars=" + text.length());
                emitDebug("search", used + " 「" + q + "」 " + text.length() + "B");
                p.put("ok", true);
                p.put("text", text);
                p.put("engine", used);
                p.put("query", q);
            } catch (Exception e) {
                Log.e(TAG, "search failed: " + e.getMessage());
                emitDebug("search", "失败: " + e.getMessage());
                try {
                    p.put("ok", false);
                    p.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
                } catch (Exception ignored) {
                }
            }
            emit("onSearch", p);
        });
    }

    /** News verticals first (dated articles), falling back to the configured web engine. */
    @JavascriptInterface
    public void webSearchNews(String query) {
        final String q = query == null ? "" : query;
        pool.execute(() -> {
            JSONObject p = new JSONObject();
            java.util.List<String> trace = new java.util.ArrayList<>();
            try {
                if (q.trim().isEmpty()) throw new Exception("搜索词为空");

                String engine = Search.DEFAULT_ENGINE;
                try {
                    JSONObject meta = new JSONObject(store.meta());
                    JSONObject search = meta.optJSONObject("search");
                    if (search != null) engine = search.optString("engine", Search.DEFAULT_ENGINE);
                } catch (Exception ignored) {
                }

                String text = Search.news(q, engine, store.key("__search"), trace);
                for (String line : trace) emitDebug("news", line);

                String used = "news";
                if (text == null || text.trim().isEmpty()) {
                    // 新闻源全灭时，退回网页搜索：先配置的引擎，再 Bing，再 DuckDuckGo
                    String[] order = {engine, Search.ENGINE_BING, Search.ENGINE_DDG};
                    for (String e : order) {
                        if (used.equals("news") && text != null && !text.trim().isEmpty()) break;
                        try {
                            String got = Search.run(e, store.key("__search"), q);
                            emitDebug("news", "回落 " + e + ": " + (got == null ? 0 : got.length()) + "B");
                            if (got != null && !got.trim().isEmpty()) {
                                text = got;
                                used = e;
                                break;
                            }
                        } catch (Exception ex) {
                            emitDebug("news", "回落 " + e + " 失败: " + ex.getMessage());
                        }
                    }
                }
                if (text == null || text.trim().isEmpty()) {
                    String tail = trace.isEmpty() ? "" : "（" + trace.get(trace.size() - 1) + "）";
                    throw new Exception("新闻源和通用搜索都没有返回结果" + tail);
                }

                Log.d(TAG, "news search q=" + q + " via=" + used + " chars=" + text.length());
                p.put("ok", true);
                p.put("text", text);
                p.put("engine", used);
                p.put("query", q);
            } catch (Exception e) {
                Log.e(TAG, "news search failed: " + e.getMessage());
                for (String line : trace) Log.d(TAG, "  " + line);
                try {
                    p.put("ok", false);
                    p.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
                } catch (Exception ignored) {
                }
            }
            emit("onSearch", p);
        });
    }

    /** Opens a URL in the system browser (used by the "search in browser" action). */
    @JavascriptInterface
    public void openUrl(String url) {
        final String u = url == null ? "" : url.trim();
        if (u.isEmpty()) return;
        main.post(() -> {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                act.startActivity(i);
            } catch (Exception e) {
                Toast.makeText(act, "没有可用的浏览器", Toast.LENGTH_SHORT).show();
            }
        });
    }

    @JavascriptInterface
    public void copy(String text) {
        main.post(() -> {
            try {
                ClipboardManager cm = (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("text", text));
                Toast.makeText(act, "已复制", Toast.LENGTH_SHORT).show();
            } catch (Exception ignored) {
            }
        });
    }

    @JavascriptInterface
    public void toast(String msg) {
        main.post(() -> Toast.makeText(act, msg, Toast.LENGTH_SHORT).show());
    }

    public void shutdown() {
        stop();
        pool.shutdownNow();
    }
}
