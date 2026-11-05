package dev.local.llmchat;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {

    /** 把事件广播给情趣版（插件） */
    void sendPetEvent(String json) {
        try {
            org.json.JSONObject o = new org.json.JSONObject(json);
            android.content.Intent i = new android.content.Intent("dev.local.yujian.PET_EVENT");
            i.setPackage("dev.local.yujian.pet");
            i.putExtra("type", o.optString("type", ""));
            i.putExtra("value", o.optString("value", ""));
            i.putExtra("text", o.optString("text", ""));
            sendBroadcast(i);
        } catch (Exception e) {
            Log.w(TAG, "sendPetEvent failed", e);
        }
    }

    /** 暴露给页面：Native.petEvent(json) */
    public static class PetBridge {
        private final MainActivity act;
        PetBridge(MainActivity a) { this.act = a; }

        @android.webkit.JavascriptInterface
        public void petEvent(String json) {
            act.runOnUiThread(() -> act.sendPetEvent(json));
        }
    }

    private static final String TAG = "LLMChat";
    private WebView web;
    private Bridge bridge;

    /** 接收情趣版回报的实际执行值 */
    private final android.content.BroadcastReceiver petReportReceiver = new android.content.BroadcastReceiver() {
        @Override
        public void onReceive(android.content.Context context, android.content.Intent intent) {
            if (intent == null) return;
            try {
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("cy", intent.getIntExtra("cy", 0));
                o.put("yc", intent.getIntExtra("yc", 0));
                o.put("note", intent.getStringExtra("note"));
                if (web != null) {
                    web.evaluateJavascript("window.__petReport(" + o.toString() + ")", null);
                }
            } catch (Exception e) {
                Log.w(TAG, "pet report failed", e);
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int bg = Color.parseColor("#0f1115");
        getWindow().setBackgroundDrawable(new ColorDrawable(bg));
        getWindow().setStatusBarColor(bg);
        getWindow().setNavigationBarColor(bg);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
            getWindow().setStatusBarContrastEnforced(false);
        }

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setBackgroundColor(bg);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        bridge = new Bridge(this, web);
        web.addJavascriptInterface(new PetBridge(this), "NativePet");
        web.addJavascriptInterface(bridge, "Native");

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.d(TAG, "[js] " + cm.message() + " @" + cm.lineNumber());
                return true;
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u != null && "llmchat.local".equals(u.getHost()) && "/sticker".equals(u.getPath())) {
                    android.webkit.WebResourceResponse r = bridge.serveSticker(u);
                    if (r != null) return r;
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u == null) return false;
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if (scheme.startsWith("http")) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, u));
                    } catch (Exception ignored) {
                    }
                    return true;
                }
                return false;
            }
        });

        try {
            android.content.IntentFilter f = new android.content.IntentFilter("dev.local.yujian.PET_REPORT");
            registerReceiver(petReportReceiver, f);
        } catch (Exception e) {
            Log.w(TAG, "register report receiver failed", e);
        }

        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (bridge != null) bridge.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.shutdown();
        if (web != null) {
            web.removeJavascriptInterface("Native");
            web.destroy();
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (bridge != null && bridge.isOverlayOpen()) {
            if (web != null) {
                web.evaluateJavascript("window.__bridge && window.__bridge.onBack && window.__bridge.onBack();", null);
            }
            return;
        }
        super.onBackPressed();
    }
}
