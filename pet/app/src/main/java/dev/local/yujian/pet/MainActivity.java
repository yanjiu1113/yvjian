package dev.local.yujian.pet;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {

    private static final String TAG = "YujianPet";
    private static final int REQ_BT = 1001;
    private static WeakReference<MainActivity> INSTANCE = new WeakReference<>(null);

    /** 每种设备最多支持的同类型实例数（slot 0..3） */
    static final int MAX_SLOT = 4;

    private WebView web;
    /** 页面 JS 是否已经加载完（loadUrl 之前 eval 会被丢掉） */
    private volatile boolean pageReady = false;
    /** 页面没准备好时收到的联动事件，等 onPageFinished 再补发 */
    private volatile String[] pendingPet = null;

    /**
     * 同类型多设备池：列表下标就是 JS 侧的 slot 编号。
     * 0 号懒创建后即 0.103 时代的那一台，其余按需创建，互不影响。
     */
    final List<Coyote> cyPool = new ArrayList<>();
    final List<YcyToy> ycyPool = new ArrayList<>();
    final List<YcyToy> emsPool = new ArrayList<>();

    /** slot 0 的别名（PetNative 的兜底、onDestroy、旧代码都还能直接用） */
    Coyote coyote;
    YcyBridge ycy;
    YcyToy ycyToy;
    YcyToy emsToy;
    AiChat ai;

    static MainActivity current() {
        return INSTANCE.get();
    }

    /** 由 PetReceiver 调用：把聊天端事件转给页面 */
    /** 把执行回执发回语见 */
    void sendPetReport(String json) {
        try {
            org.json.JSONObject o = new org.json.JSONObject(json);
            android.content.Intent i = new android.content.Intent("dev.local.yujian.PET_REPORT");
            i.setPackage("dev.local.llmchat");
            i.putExtra("cy", o.optInt("cy", 0));
            i.putExtra("yc", o.optInt("yc", 0));
            i.putExtra("note", o.optString("note", ""));
            sendBroadcast(i);
        } catch (Exception e) {
            Log.w(TAG, "sendPetReport failed", e);
        }
    }

    void dispatch(String type, String value, String text) {
        if (web == null || !pageReady) {
            // 页面还没加载好：先存着，等 onPageFinished 补发，别把这一轮丢了
            pendingPet = new String[]{type, value, text};
            Log.d(TAG, "dispatch queued (pageReady=" + pageReady + ") type=" + type);
            return;
        }
        String js = "window.PetEvent && window.PetEvent(" + jsStr(type) + "," + jsStr(value) + "," + jsStr(text) + ")";
        eval(js);
    }

    /** 页面就绪后，把排队的那一条补发出去 */
    private void flushPendingPet() {
        String[] p = pendingPet;
        if (p == null) return;
        pendingPet = null;
        Log.d(TAG, "flush queued event type=" + p[0]);
        String js = "window.PetEvent && window.PetEvent(" + jsStr(p[0]) + "," + jsStr(p[1]) + "," + jsStr(p[2]) + ")";
        eval(js);
    }

    /** 从「被广播唤起」的 Intent 里取出联动事件 */
    private static String[] petFromIntent(Intent it) {
        if (it == null) return null;
        String t = it.getStringExtra("pet_event_type");
        if (t == null) return null;
        return new String[]{t, it.getStringExtra("pet_event_value"), it.getStringExtra("pet_event_text")};
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String[] p = petFromIntent(intent);
        if (p != null) {
            Log.d(TAG, "onNewIntent event type=" + p[0]);
            dispatch(p[0], p[1], p[2]);
        }
    }

    private static String jsStr(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append("\"").toString();
    }

    /** 检查并请求蓝牙权限；没有权限返回 false */
    boolean ensureBtPermission() {
        String[] need;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            need = new String[]{Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT};
        } else {
            need = new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
        }
        boolean ok = true;
        for (String p : need) {
            if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) ok = false;
        }
        if (!ok) {
            requestPermissions(need, REQ_BT);
            toastJs("请允许蓝牙权限");
        }
        return ok;
    }

    private void toastJs(String msg) {
        runOnUiThread(() -> { eval("window.CoyoteDev && window.CoyoteDev.onLog(" + jsStr(msg) + ")"); });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_BT) {
            boolean all = grantResults.length > 0;
            for (int g : grantResults) if (g != PackageManager.PERMISSION_GRANTED) all = false;
            toastJs(all ? "权限已授予，再点一次扫描" : "没有蓝牙权限，无法扫描");
        }
    }

    // ================= 同类型多设备：实例池 =================

    /** 第 slot 台郊狼；越界返回 null，不足则懒创建 */
    synchronized Coyote coyoteFor(int slot) {
        if (slot < 0 || slot >= MAX_SLOT) return null;
        while (cyPool.size() <= slot) {
            final int s = cyPool.size();
            cyPool.add(new Coyote(this, coyoteListener(s)));
        }
        return cyPool.get(slot);
    }

    /** 第 slot 台榨精杯（devId=0） */
    synchronized YcyToy ycyToyFor(int slot) {
        if (slot < 0 || slot >= MAX_SLOT) return null;
        while (ycyPool.size() <= slot) {
            final int s = ycyPool.size();
            ycyPool.add(new YcyToy(this, ycyListener(s, "cup", false)));
        }
        return ycyPool.get(slot);
    }

    /** 第 slot 台电击器（devId=1, emsRole=true） */
    synchronized YcyToy emsToyFor(int slot) {
        if (slot < 0 || slot >= MAX_SLOT) return null;
        while (emsPool.size() <= slot) {
            final int s = emsPool.size();
            YcyToy t = new YcyToy(this, ycyListener(s, "ems", true));
            t.devId = 1;
            t.emsRole = true;
            emsPool.add(t);
        }
        return emsPool.get(slot);
    }

    /** 日志前缀：0 号保持 0.103 的原样，其它实例加槽位标记，便于排查 */
    private static String slotTag(String kind, int slot, String line) {
        if (slot <= 0) return line;
        return "[" + kind + (slot + 1) + "] " + (line == null ? "" : line);
    }

    private Coyote.Listener coyoteListener(final int slot) {
        return new Coyote.Listener() {
            @Override
            public void onDevices(JSONArray list) {
                final String js;
                try {
                    JSONObject o = new JSONObject();
                    o.put("slot", slot);
                    o.put("pool", "cy");
                    o.put("devices", list == null ? new JSONArray() : list);
                    js = o.toString();
                } catch (Exception e) {
                    return;
                }
                runOnUiThread(() -> { eval("window.CoyoteDev && window.CoyoteDev.onDevices(" + js + ")"); });
            }

            @Override
            public void onState(JSONObject state) {
                final String js;
                try {
                    state.put("slot", slot);
                    state.put("pool", "cy");
                    js = state.toString();
                } catch (Exception e) {
                    return;
                }
                runOnUiThread(() -> { eval("window.CoyoteDev && window.CoyoteDev.onState(" + js + ")"); });
            }

            @Override
            public void onLog(String line) {
                final String s = slotTag("郊狼", slot, line);
                runOnUiThread(() -> { eval("window.CoyoteDev && window.CoyoteDev.onLog(" + jsStr(s) + ")"); });
            }
        };
    }

    private YcyToy.Listener ycyListener(final int slot, final String pool, final boolean ems) {
        return new YcyToy.Listener() {
            @Override
            public void onDevices(JSONArray arr) {
                final String js;
                try {
                    JSONObject o = new JSONObject();
                    o.put("slot", slot);
                    o.put("pool", pool);
                    o.put("devices", arr == null ? new JSONArray() : arr);
                    js = o.toString();
                } catch (Exception e) {
                    return;
                }
                runOnUiThread(() -> { eval("window.YcyDev && window.YcyDev.onDevices(" + js + ")"); });
            }

            @Override
            public void onState(JSONObject o) {
                final String js;
                try {
                    o.put("slot", slot);
                    o.put("pool", pool);
                    js = o.toString();
                } catch (Exception e) {
                    return;
                }
                runOnUiThread(() -> { eval("window.YcyDev && window.YcyDev.onState(" + js + ")"); });
            }

            @Override
            public void onLog(String line) {
                final String s = slotTag(ems ? "电击器" : "榨精杯", slot, line);
                runOnUiThread(() -> { eval("window.YcyDev && window.YcyDev.onLog(" + jsStr(s) + ")"); });
            }
        };
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        INSTANCE = new WeakReference<>(this);
        pendingPet = petFromIntent(getIntent());
        // 常驻前台服务：切回语见聊天后进程不被冻结，蓝牙和联动继续有效
        try {
            android.content.Intent svc = new android.content.Intent(this, PetService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc);
            else startService(svc);
        } catch (Exception e) {
            Log.w(TAG, "start PetService failed", e);
        }

        int bg = Color.parseColor("#0f1115");
        getWindow().setBackgroundDrawable(new ColorDrawable(bg));
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // slot 0 就是 0.103 的那几台；其余槽位等 JS 点了「再加一台」才创建
        coyote = coyoteFor(0);
        emsToy = emsToyFor(0);
        ycyToy = ycyToyFor(0);

        ai = new AiChat(new AiChat.Listener() {
            @Override
            public void onDelta(String text) {
                eval("window.AiDev && window.AiDev.onDelta(" + jsStr(text) + ")");
            }

            @Override
            public void onDone(boolean ok, String err) {
                eval("window.AiDev && window.AiDev.onDone(" + ok + "," + jsStr(err) + ")");
            }

            @Override
            public void onLog(String line) {
                eval("window.AiDev && window.AiDev.onLog(" + jsStr(line) + ")");
            }
        });

        ycy = new YcyBridge(new YcyBridge.Listener() {
            @Override
            public void onResult(JSONObject obj) {
                runOnUiThread(() -> { eval("window.YcyDev && window.YcyDev.onResult(" + obj.toString() + ")"); });
            }

            @Override
            public void onLog(String line) {
                runOnUiThread(() -> { eval("window.YcyDev && window.YcyDev.onLog(" + jsStr(line) + ")"); });
            }
        });

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.setBackgroundColor(bg);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web.addJavascriptInterface(new PetNative(this), "Coyote");

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.d(TAG, "[js] " + cm.message() + " @" + cm.lineNumber());
                return true;
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                Log.d(TAG, "page ready: " + url);
                flushPendingPet();
            }
        });

        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");

        hideSystemBars();
    }

    private void eval(String js) {
        if (web == null) return;
        runOnUiThread(() -> {
            try {
                web.evaluateJavascript(js, null);
            } catch (Exception ignored) {
            }
        });
    }

    private void hideSystemBars() {
        try {
            View d = getWindow().getDecorView();
            d.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        } catch (Exception ignored) {
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        INSTANCE = new WeakReference<>(this);
        hideSystemBars();
    }

    @Override
    protected void onDestroy() {
        if (INSTANCE.get() == this) INSTANCE = new WeakReference<>(null);
        if (ai != null) { try { ai.cancel(); } catch (Exception ignored) { } }
        // 所有槽位一起收尾：先急停再断开，避免有实例漏掉还在输出
        for (YcyToy t : new ArrayList<>(emsPool)) {
            try { t.emergencyStop(); t.disconnect(); } catch (Exception ignored) { }
        }
        for (YcyToy t : new ArrayList<>(ycyPool)) {
            try { t.emergencyStop(); t.disconnect(); } catch (Exception ignored) { }
        }
        for (Coyote c : new ArrayList<>(cyPool)) {
            try { c.emergencyStop(); c.disconnect(); } catch (Exception ignored) { }
        }
        synchronized (cyPool) { cyPool.clear(); }
        synchronized (ycyPool) { ycyPool.clear(); }
        synchronized (emsPool) { emsPool.clear(); }
        coyote = null;
        ycyToy = null;
        emsToy = null;
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
