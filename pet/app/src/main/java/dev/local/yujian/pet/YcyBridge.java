package dev.local.yujian.pet;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 役次元（YOKONEX）桥接客户端。
 *
 * 役次元走腾讯云 IM，Android 端直接内联 IM SDK 成本过高，
 * 因此在 PC（或 Termux）上运行官方 API-bridge，这里通过 HTTP 调用它：
 *   GET  {base}/api/status          查询 IM 是否就绪
 *   POST {base}/api/send-command    {"commandId":"..."} 发送控制命令
 */
public class YcyBridge {

    private static final String TAG = "YujianPetYcy";

    public interface Listener {
        void onResult(JSONObject obj);
        void onLog(String line);
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Listener listener;
    private volatile String base = "";

    public YcyBridge(Listener l) {
        this.listener = l;
    }

    public void setBase(String url) {
        base = url == null ? "" : url.trim();
        if (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        log("桥接地址设为 " + base);
    }

    public void checkStatus() {
        request("GET", "/api/status", null);
    }

    public void sendCommand(String commandId) {
        if (commandId == null || commandId.trim().isEmpty()) {
            log("命令 ID 为空");
            return;
        }
        try {
            JSONObject body = new JSONObject();
            body.put("commandId", commandId.trim());
            request("POST", "/api/send-command", body.toString());
        } catch (Exception e) {
            log("构造请求失败：" + e.getMessage());
        }
    }

    private void request(final String method, final String path, final String body) {
        if (base.isEmpty()) {
            log("还没设置桥接地址");
            return;
        }
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                URL u = new URL(base + path);
                c = (HttpURLConnection) u.openConnection();
                c.setConnectTimeout(6000);
                c.setReadTimeout(10000);
                c.setRequestMethod(method);
                c.setRequestProperty("Accept", "application/json");
                if (body != null) {
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json");
                    byte[] data = body.getBytes("UTF-8");
                    c.setFixedLengthStreamingMode(data.length);
                    OutputStream os = c.getOutputStream();
                    os.write(data);
                    os.flush();
                    os.close();
                }
                int code = c.getResponseCode();
                InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                String text = readAll(in);
                Log.d(TAG, method + " " + path + " -> " + code + " " + text);
                JSONObject out = new JSONObject();
                out.put("ok", code < 400);
                out.put("status", code);
                out.put("path", path);
                try {
                    out.put("data", text == null || text.isEmpty() ? new JSONObject() : new JSONObject(text));
                } catch (Exception e) {
                    out.put("raw", text == null ? "" : text);
                }
                main.post(() -> listener.onResult(out));
            } catch (Exception e) {
                log("请求失败：" + e.getMessage());
                try {
                    JSONObject out = new JSONObject();
                    out.put("ok", false);
                    out.put("path", path);
                    out.put("error", e.getMessage());
                    main.post(() -> listener.onResult(out));
                } catch (Exception ignored) {
                }
            } finally {
                if (c != null) c.disconnect();
            }
        }, "ycy-bridge").start();
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        StringBuilder sb = new StringBuilder();
        BufferedReader br = new BufferedReader(new InputStreamReader(in, "UTF-8"));
        String line;
        while ((line = br.readLine()) != null) sb.append(line).append('\n');
        br.close();
        return sb.toString().trim();
    }

    private void log(String s) {
        Log.d(TAG, s);
        main.post(() -> listener.onLog(s));
    }
}
