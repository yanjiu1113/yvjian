package dev.local.llmchat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.BufferedReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.zip.GZIPInputStream;

/**
 * OpenAI-compatible HTTP layer: streaming chat completions (SSE) and model listing.
 * Runs off the UI thread; never touches the WebView.
 */
public final class Http {

    public interface Listener {
        void onDelta(String content, String reasoning);

        void onDone();

        void onError(String message);

        /** Token 用量（需要在请求里带 stream_options.include_usage） */
    default void onUsage(int prompt, int completion) {
    }

    /** Called once before onDone when the model asked for function/tool calls. */
        default void onToolCalls(org.json.JSONArray calls) {
        }
    }

    public static final class Job {
        volatile boolean cancelled;
        volatile HttpURLConnection conn;

        public void cancel() {
            cancelled = true;
            HttpURLConnection c = conn;
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
    }

    private Http() {
    }

    /** org.json turns JSON null into the string "null"; never let that reach the chat. */
    private static String str(JSONObject o, String... keys) {
        if (o == null) return "";
        for (String k : keys) {
            if (k == null) continue;
            if (!o.has(k) || o.isNull(k)) continue;
            String v = o.optString(k, "");
            if (v == null || "null".equals(v)) continue;
            return v;
        }
        return "";
    }
    private static String clean(String baseUrl) {
        String b = baseUrl == null ? "" : baseUrl.trim();
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        return b;
    }

    private static HttpURLConnection open(String url, String apiKey, String method, Job job) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(25000);
        c.setReadTimeout(300000);
        c.setRequestProperty("Authorization", "Bearer " + apiKey);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("Accept", "application/json, text/event-stream");
        c.setRequestProperty("User-Agent", "LLMChat/1.0 (Android)");
        c.setRequestProperty("HTTP-Referer", "https://llmchat.local");
        c.setRequestProperty("X-Title", "LLM Chat");
        c.setUseCaches(false);
        if (job != null) job.conn = c;
        return c;
    }

    private static InputStream body(HttpURLConnection c) throws Exception {
        InputStream in = c.getInputStream();
        String enc = c.getContentEncoding();
        if (enc != null && enc.toLowerCase().contains("gzip")) {
            return new GZIPInputStream(in);
        }
        return in;
    }

    private static String drain(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return new String(bo.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String errorMessage(int code, String body) {
        String msg = "";
        try {
            JSONObject o = new JSONObject(body);
            JSONObject err = o.optJSONObject("error");
            if (err != null) {
                msg = err.optString("message", err.toString());
            } else {
                msg = o.optString("message", o.optString("detail", ""));
            }
        } catch (Exception ignored) {
            msg = body == null ? "" : body.trim();
        }
        if (msg.length() > 600) msg = msg.substring(0, 600) + "…";
        return "HTTP " + code + (msg.isEmpty() ? "" : ": " + msg);
    }

    /** POST {base}/chat/completions without streaming; returns the assistant text. */
    public static String complete(String baseUrl, String apiKey, JSONObject reqBody) throws Exception {
        HttpURLConnection c = null;
        try {
            String url = clean(baseUrl) + "/chat/completions";
            c = open(url, apiKey, "POST", null);
            c.setDoOutput(true);
            c.setRequestProperty("Accept", "application/json, text/event-stream");
            byte[] payload = reqBody.toString().getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(payload.length);
            try (OutputStream os = c.getOutputStream()) {
                os.write(payload);
                os.flush();
            }
            int code = c.getResponseCode();
            if (code >= 400) throw new Exception(errorMessage(code, drain(c.getErrorStream())));

            String ct = c.getContentType();
            String text = drain(body(c));

            if (ct != null && ct.toLowerCase().contains("event-stream")) {
                StringBuilder sb = new StringBuilder();
                for (String line : text.split("\n")) {
                    String t = line.trim();
                    if (!t.startsWith("data:")) continue;
                    String d = t.substring(5).trim();
                    if (d.isEmpty() || "[DONE]".equals(d)) continue;
                    try {
                        JSONObject o = new JSONObject(d);
                        JSONArray ch = o.optJSONArray("choices");
                        if (ch == null || ch.length() == 0) continue;
                        JSONObject delta = ch.getJSONObject(0).optJSONObject("delta");
                        if (delta != null) sb.append(str(delta, "content"));
                    } catch (Exception ignored) {
                    }
                }
                return sb.toString();
            }

            JSONObject o = new JSONObject(text);
            if (o.has("error")) throw new Exception(errorMessage(200, text));
            JSONArray ch = o.optJSONArray("choices");
            if (ch == null || ch.length() == 0) throw new Exception("模型没有返回内容");
            JSONObject msg = ch.getJSONObject(0).optJSONObject("message");
            return msg == null ? "" : str(msg, "content");
        } finally {
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
    }

    /** GET {base}/models -> {"models":[{"id":..,"name":..}]} */
    /** 通用 GET（用于余额查询这类非 OpenAI 标准接口），失败返回 null */
    public static JSONObject getJson(String url, String apiKey) throws Exception {
        HttpURLConnection c = open(url, apiKey, "GET", null);
        int code = c.getResponseCode();
        String text = drain(code >= 400 ? c.getErrorStream() : body(c));
        c.disconnect();
        if (code >= 400) return null;
        String raw = text == null ? "" : text.trim();
        if (!raw.startsWith("{")) return null;
        return new JSONObject(raw);
    }

    public static JSONArray fetchModels(String baseUrl, String apiKey) throws Exception {
        String url = clean(baseUrl) + "/models";
        HttpURLConnection c = open(url, apiKey, "GET", null);
        int code = c.getResponseCode();
        String text = drain(code >= 400 ? c.getErrorStream() : body(c));
        if (code >= 400) throw new Exception(errorMessage(code, text));

        JSONArray data = null;
        String raw = text.trim();
        if (raw.startsWith("[")) {
            data = new JSONArray(raw);
        } else {
            JSONObject o = new JSONObject(raw);
            data = o.optJSONArray("data");
            if (data == null) data = o.optJSONArray("models");
        }
        JSONArray out = new JSONArray();
        if (data != null) {
            for (int i = 0; i < data.length(); i++) {
                JSONObject m = data.optJSONObject(i);
                if (m == null) continue;
                String id = m.optString("id", m.optString("name", ""));
                if (id.isEmpty()) continue;
                JSONObject item = new JSONObject();
                item.put("id", id);
                item.put("name", m.optString("name", id));
                out.put(item);
            }
        }
        return out;
    }

    /** POST {base}/chat/completions with stream:true, parse SSE deltas. */
    public static void streamChat(String baseUrl, String apiKey, JSONObject body, Job job, Listener l) {
        HttpURLConnection c = null;
        try {
            String url = clean(baseUrl) + "/chat/completions";
            c = open(url, apiKey, "POST", job);
            c.setDoOutput(true);
            c.setRequestProperty("Accept", "text/event-stream");
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(payload.length);
            try (OutputStream os = c.getOutputStream()) {
                os.write(payload);
                os.flush();
            }
            int code = c.getResponseCode();
            if (code >= 400) {
                l.onError(errorMessage(code, drain(c.getErrorStream())));
                return;
            }

            String ct = c.getContentType();
            InputStream in = body(c);

            if (ct != null && ct.toLowerCase().contains("json")) {
                // Server ignored stream:true and returned a normal completion.
                String text = drain(in);
                JSONObject o = new JSONObject(text);
                JSONArray ch = o.optJSONArray("choices");
                if (ch != null && ch.length() > 0) {
                    JSONObject m = ch.getJSONObject(0).optJSONObject("message");
                    if (m != null) {
                        l.onDelta(str(m, "content"), str(m, "reasoning_content", "reasoning"));
                        JSONArray tcs = m.optJSONArray("tool_calls");
                        if (tcs != null && tcs.length() > 0) l.onToolCalls(tcs);
                    }
                }
                JSONObject u1 = o.optJSONObject("usage");
                if (u1 != null) {
                    l.onUsage(u1.optInt("prompt_tokens", 0), u1.optInt("completion_tokens", 0));
                }
                if (o.has("error")) {
                    l.onError(errorMessage(200, text));
                    return;
                }
                l.onDone();
                return;
            }

            BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8), 8192);
            String line;
            boolean gotAny = false;
            java.util.LinkedHashMap<Integer, JSONObject> toolAcc = new java.util.LinkedHashMap<>();
            while (!job.cancelled && (line = br.readLine()) != null) {
                String t = line.trim();
                if (t.isEmpty() || t.startsWith(":")) continue;
                if (!t.startsWith("data:")) continue;
                String data = t.substring(5).trim();
                if (data.isEmpty()) continue;
                if ("[DONE]".equals(data)) break;
                try {
                    JSONObject o = new JSONObject(data);
                    if (o.has("error")) {
                        l.onError(errorMessage(200, data));
                        return;
                    }
                    JSONObject u = o.optJSONObject("usage");
                    if (u != null) {
                        int pt = u.optInt("prompt_tokens", 0);
                        int ctk = u.optInt("completion_tokens", 0);
                        if (pt > 0 || ctk > 0) l.onUsage(pt, ctk);
                    }
                    JSONArray ch = o.optJSONArray("choices");
                    if (ch == null || ch.length() == 0) continue;
                    JSONObject ch0 = ch.getJSONObject(0);
                    JSONObject delta = ch0.optJSONObject("delta");
                    if (delta == null) delta = ch0.optJSONObject("message");
                    if (delta == null) continue;
                    String content = str(delta, "content");
                    String reasoning = str(delta, "reasoning_content", "reasoning");
                    if (!content.isEmpty() || !reasoning.isEmpty()) {
                        gotAny = true;
                        l.onDelta(content, reasoning);
                    }
                    JSONArray tcs = delta.optJSONArray("tool_calls");
                    if (tcs != null && tcs.length() > 0) {
                        gotAny = true;
                        for (int i = 0; i < tcs.length(); i++) {
                            JSONObject tc = tcs.optJSONObject(i);
                            if (tc == null) continue;
                            int idx = tc.optInt("index", i);
                            JSONObject acc = toolAcc.get(idx);
                            if (acc == null) {
                                acc = new JSONObject();
                                acc.put("args", "");
                                acc.put("name", "");
                                acc.put("id", "");
                                toolAcc.put(idx, acc);
                            }
                            if (tc.has("id")) acc.put("id", tc.optString("id", ""));
                            JSONObject fn = tc.optJSONObject("function");
                            if (fn != null) {
                                if (fn.has("name")) acc.put("name", fn.optString("name", ""));
                                if (fn.has("arguments")) {
                                    acc.put("args", acc.optString("args", "") + fn.optString("arguments", ""));
                                }
                            }
                        }
                    }
                } catch (Exception ignored) {
                    // keep-alive garbage or partial frame: ignore
                }
            }
            if (job.cancelled) {
                l.onDone();
                return;
            }
            if (!toolAcc.isEmpty()) {
                JSONArray calls = new JSONArray();
                for (JSONObject acc : toolAcc.values()) {
                    JSONObject c1 = new JSONObject();
                    c1.put("id", acc.optString("id", "call_" + calls.length()));
                    c1.put("name", acc.optString("name", ""));
                    c1.put("args", acc.optString("args", ""));
                    calls.put(c1);
                }
                l.onToolCalls(calls);
            }
            if (!gotAny) {
                l.onError("服务端返回了空内容（可能是模型不存在、额度不足或该端点不支持流式）");
                return;
            }
            l.onDone();
        } catch (Exception e) {
            if (job.cancelled) {
                l.onDone();
            } else {
                String m = e.getMessage();
                l.onError(m == null || m.isEmpty() ? e.toString() : m);
            }
        } finally {
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
    }
}
