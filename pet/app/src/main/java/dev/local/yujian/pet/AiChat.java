package dev.local.yujian.pet;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** 情趣版自己的模型会话（流式 SSE），只负责把文本片段抛给前端。 */
public class AiChat {

    private static final String TAG = "YujianPetAi";

    public interface Listener {
        void onDelta(String text);
        void onDone(boolean ok, String err);
        void onLog(String line);
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Listener listener;
    private volatile Thread worker;
    private volatile boolean cancelled = false;

    public AiChat(Listener l) {
        this.listener = l;
    }

    public void cancel() {
        cancelled = true;
        Thread t = worker;
        if (t != null) t.interrupt();
    }

    public void send(final String baseUrl, final String apiKey, final String model,
                     final JSONArray messages, final double temperature) {
        cancel();
        cancelled = false;
        worker = new Thread(() -> {
            HttpURLConnection c = null;
            try {
                String url = clean(baseUrl) + "/chat/completions";
                JSONObject body = new JSONObject();
                body.put("model", model);
                body.put("messages", messages);
                body.put("stream", true);
                body.put("temperature", temperature);
                JSONObject so = new JSONObject();
                so.put("include_usage", true);
                body.put("stream_options", so);

                c = (HttpURLConnection) new URL(url).openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(15000);
                c.setReadTimeout(120000);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setRequestProperty("Accept", "text/event-stream");
                if (apiKey != null && !apiKey.isEmpty()) {
                    c.setRequestProperty("Authorization", "Bearer " + apiKey);
                }
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(payload.length);
                OutputStream os = c.getOutputStream();
                os.write(payload);
                os.flush();
                os.close();

                int code = c.getResponseCode();
                if (code >= 400) {
                    String err = drain(c.getErrorStream());
                    Log.w(TAG, "HTTP " + code + " " + err);
                    emitDone(false, "HTTP " + code + "：" + shortMsg(err));
                    return;
                }

                BufferedReader br = new BufferedReader(
                        new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8), 8192);
                String line;
                while (!cancelled && (line = br.readLine()) != null) {
                    String t = line.trim();
                    if (t.isEmpty() || t.startsWith(":")) continue;
                    if (!t.startsWith("data:")) continue;
                    String data = t.substring(5).trim();
                    if ("[DONE]".equals(data)) break;
                    try {
                        JSONObject o = new JSONObject(data);
                        JSONArray ch = o.optJSONArray("choices");
                        if (ch == null || ch.length() == 0) continue;
                        JSONObject d = ch.getJSONObject(0).optJSONObject("delta");
                        if (d == null) continue;
                        String content = d.optString("content", "");
                        if (!content.isEmpty()) {
                            final String s = content;
                            main.post(() -> listener.onDelta(s));
                        }
                    } catch (Exception ignored) {
                    }
                }
                br.close();
                emitDone(true, null);
            } catch (Exception e) {
                if (!cancelled) {
                    Log.w(TAG, "request failed", e);
                    emitDone(false, e.getMessage() == null ? e.toString() : e.getMessage());
                }
            } finally {
                if (c != null) c.disconnect();
            }
        }, "ai-chat");
        worker.start();
    }

    private void emitDone(final boolean ok, final String err) {
        main.post(() -> listener.onDone(ok, err));
    }

    private static String shortMsg(String s) {
        if (s == null) return "";
        s = s.replace('\n', ' ').trim();
        return s.length() > 160 ? s.substring(0, 160) + "…" : s;
    }

    private static String clean(String base) {
        String s = base == null ? "" : base.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    private static String drain(InputStream in) {
        if (in == null) return "";
        try {
            StringBuilder sb = new StringBuilder();
            BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            String line;
            while ((line = br.readLine()) != null) sb.append(line).append('\n');
            br.close();
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }
}
