package dev.local.yujian.pet;

import android.Manifest;
import android.app.Activity;
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

public class MainActivity extends Activity {

    private static final String TAG = "YujianPet";
    private static final int REQ_BT = 1001;
    private static WeakReference<MainActivity> INSTANCE = new WeakReference<>(null);

    private WebView web;
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
        if (web == null) return;
        String js = "window.PetEvent && window.PetEvent(" + jsStr(type) + "," + jsStr(value) + "," + jsStr(text) + ")";
        eval(js);
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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        INSTANCE = new WeakReference<>(this);

        int bg = Color.parseColor("#0f1115");
        getWindow().setBackgroundDrawable(new ColorDrawable(bg));
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        coyote = new Coyote(this, new Coyote.Listener() {
            @Override
            public void onDevices(JSONArray list) {
                runOnUiThread(() -> { eval("window.CoyoteDev && window.CoyoteDev.onDevices(" + list.toString() + ")"); });
            }

            @Override
            public void onState(JSONObject state) {
                runOnUiThread(() -> { eval("window.CoyoteDev && window.CoyoteDev.onState(" + state.toString() + ")"); });
            }

            @Override
            public void onLog(String line) {
                runOnUiThread(() -> { eval("window.CoyoteDev && window.CoyoteDev.onLog(" + jsStr(line) + ")"); });
            }
        });

        emsToy = new YcyToy(this, new YcyToy.Listener() {
            @Override
            public void onDevices(org.json.JSONArray arr) {
                runOnUiThread(() -> { eval("window.YcyDev && window.YcyDev.onDevices(" + arr.toString() + ")"); });
            }

            @Override
            public void onState(org.json.JSONObject o) {
                runOnUiThread(() -> { eval("window.YcyDev && window.YcyDev.onState(" + o.toString() + ")"); });
            }

            @Override
            public void onLog(String line) {
                runOnUiThread(() -> { eval("window.YcyDev && window.YcyDev.onLog(" + jsStr(line) + ")"); });
            }
        });
        emsToy.devId = 1;
        emsToy.emsRole = true;

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

        ycyToy = new YcyToy(this, new YcyToy.Listener() {
            @Override
            public void onDevices(JSONArray list) {
                runOnUiThread(() -> { eval("window.YcyDev && window.YcyDev.onDevices(" + list.toString() + ")"); });
            }

            @Override
            public void onState(JSONObject state) {
                runOnUiThread(() -> { eval("window.YcyDev && window.YcyDev.onState(" + state.toString() + ")"); });
            }

            @Override
            public void onLog(String line) {
                runOnUiThread(() -> { eval("window.YcyDev && window.YcyDev.onLog(" + jsStr(line) + ")"); });
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

        web.setWebViewClient(new WebViewClient());

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
        if (emsToy != null) {
            try { emsToy.emergencyStop(); emsToy.disconnect(); } catch (Exception ignored) { }
        }
        if (ycyToy != null) {
            try { ycyToy.emergencyStop(); ycyToy.disconnect(); } catch (Exception ignored) { }
        }
        if (coyote != null) {
            try {
                coyote.emergencyStop();
                coyote.disconnect();
            } catch (Exception ignored) {
            }
        }
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
