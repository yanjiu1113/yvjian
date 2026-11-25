package dev.local.yujian.pet;

import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 暴露给 WebView 的设备接口，前缀 Coyote。
 *
 * 同类型多设备：所有会碰到硬件的第一个参数都是 int slot（0..MAX_SLOT-1），
 * 对应 MainActivity 里实例池的下标；slot 越界时实例为 null，方法安全返回。
 */
public class PetNative {

    private final MainActivity act;

    PetNative(MainActivity act) {
        this.act = act;
    }

    // ---------- 郊狼 ----------

    @JavascriptInterface
    public String deviceState(int slot) {
        JSONObject o = new JSONObject();
        try {
            Coyote c = act.coyoteFor(slot);
            o.put("enabled", c != null && c.isEnabled());
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    @JavascriptInterface
    public void autoFind(int slot) {
        act.runOnUiThread(() -> {
            Coyote c = act.coyoteFor(slot);
            if (c != null && act.ensureBtPermission()) c.autoFind();
        });
    }

    @JavascriptInterface
    public void scan(int slot) {
        act.runOnUiThread(() -> {
            Coyote c = act.coyoteFor(slot);
            if (c != null && act.ensureBtPermission()) c.startScan();
        });
    }

    @JavascriptInterface
    public void stopScan(int slot) {
        act.runOnUiThread(() -> {
            Coyote c = act.coyoteFor(slot);
            if (c != null) c.stopScan();
        });
    }

    @JavascriptInterface
    public void connect(int slot, String address) {
        act.runOnUiThread(() -> {
            Coyote c = act.coyoteFor(slot);
            if (c != null && act.ensureBtPermission()) c.connect(address);
        });
    }

    @JavascriptInterface
    public void disconnect(int slot) {
        act.runOnUiThread(() -> {
            Coyote c = act.coyoteFor(slot);
            if (c != null) c.disconnect();
        });
    }

    @JavascriptInterface
    public void setDebug(int slot, boolean sendBf, boolean flip) {
        act.runOnUiThread(() -> {
            Coyote c = act.coyoteFor(slot);
            if (c != null) c.setDebug(sendBf, flip);
        });
    }

    @JavascriptInterface
    public void setPulse(int slot, int freqA, int intenA, int freqB, int intenB) {
        act.runOnUiThread(() -> {
            Coyote c = act.coyoteFor(slot);
            if (c != null) c.setPulse(freqA, intenA, freqB, intenB);
        });
    }

    @JavascriptInterface
    public void testFrame(int slot, int a, int b) {
        act.runOnUiThread(() -> {
            Coyote c = act.coyoteFor(slot);
            if (c != null) c.testFrame(a, b);
        });
    }

    @JavascriptInterface
    public void selfCheck(int slot) {
        act.runOnUiThread(() -> {
            Coyote c = act.coyoteFor(slot);
            if (c != null) c.selfCheck();
        });
    }

    @JavascriptInterface
    public void setLimit(int slot, int a, int b) {
        act.runOnUiThread(() -> {
            Coyote c = act.coyoteFor(slot);
            if (c != null) c.setLimit(a, b);
        });
    }

    @JavascriptInterface
    public void setStrength(int slot, int a, int b) {
        act.runOnUiThread(() -> {
            Coyote c = act.coyoteFor(slot);
            if (c != null) c.setStrength(a, b);
        });
    }

    @JavascriptInterface
    public void setStrengthTimed(int slot, int a, int b, int holdMs) {
        act.runOnUiThread(() -> {
            Coyote c = act.coyoteFor(slot);
            if (c != null) c.setStrengthTimed(a, b, holdMs);
        });
    }

    /** 方法名沿用 0.103 的拼写（少一个 e），JS 侧也照旧 */
    @JavascriptInterface
    public void stopStrenght(int slot) {
        act.runOnUiThread(() -> {
            Coyote c = act.coyoteFor(slot);
            if (c != null) c.emergencyStop();
        });
    }

    @JavascriptInterface
    public void emergencyStop(int slot) {
        act.runOnUiThread(() -> {
            Coyote c = act.coyoteFor(slot);
            if (c != null) c.emergencyStop();
        });
    }

    // ---------- 撑精杯 / 电击器共用（YcyToy） ----------

    @JavascriptInterface
    public void ycyScan(int slot) {
        act.runOnUiThread(() -> {
            YcyToy t = act.ycyToyFor(slot);
            if (t != null && act.ensureBtPermission()) t.startScan();
        });
    }

    @JavascriptInterface
    public void ycyScanAll(int slot) {
        act.runOnUiThread(() -> {
            YcyToy t = act.ycyToyFor(slot);
            if (t != null && act.ensureBtPermission()) t.startScan(true);
        });
    }

    @JavascriptInterface
    public void ycyStopScan(int slot) {
        act.runOnUiThread(() -> {
            YcyToy t = act.ycyToyFor(slot);
            if (t != null) t.stopScan();
        });
    }

    @JavascriptInterface
    public void ycyConnect(int slot, String address) {
        act.runOnUiThread(() -> {
            YcyToy t = act.ycyToyFor(slot);
            if (t != null && act.ensureBtPermission()) t.connect(address);
        });
    }

    @JavascriptInterface
    public void ycyDisconnect(int slot) {
        act.runOnUiThread(() -> {
            YcyToy t = act.ycyToyFor(slot);
            if (t != null) t.disconnect();
        });
    }

    @JavascriptInterface
    public void ycyQuery(int slot) {
        act.runOnUiThread(() -> {
            YcyToy t = act.ycyToyFor(slot);
            if (t != null) t.queryInfo();
        });
    }

    @JavascriptInterface
    public void ycyDevType(int slot, int t) {
        act.runOnUiThread(() -> {
            YcyToy y = act.ycyToyFor(slot);
            if (y != null) y.setDevType(t);
        });
    }

    @JavascriptInterface
    public void ycyMode(int slot, int motors, int mode) {
        act.runOnUiThread(() -> {
            YcyToy t = act.ycyToyFor(slot);
            if (t != null) t.setMode(motors, mode);
        });
    }

    @JavascriptInterface
    public void ycySpeed(int slot, int a, int b, int c) {
        act.runOnUiThread(() -> {
            YcyToy t = act.ycyToyFor(slot);
            if (t != null) t.setSpeed(a, b, c);
        });
    }

    @JavascriptInterface
    public void ycySpeedTimed(int slot, int a, int b, int c, int holdMs) {
        act.runOnUiThread(() -> {
            YcyToy t = act.ycyToyFor(slot);
            if (t != null) t.setSpeedTimed(a, b, c, holdMs);
        });
    }

    @JavascriptInterface
    public void ycyStop(int slot) {
        act.runOnUiThread(() -> {
            YcyToy t = act.ycyToyFor(slot);
            if (t != null) t.emergencyStop();
        });
    }

    // ---------- 电击器专有 ----------

    @JavascriptInterface
    public void ycyEmsFixed(int slot, int strength, int mode) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.setEmsFixed(strength, mode);
        });
    }

    @JavascriptInterface
    public void ycyEmsReal(int slot, int strength, int freq, int pulse) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.setEmsReal(strength, freq, pulse);
        });
    }

    @JavascriptInterface
    public void ycyEmsFixedTimed(int slot, int strength, int mode, int holdMs) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.setEmsFixedTimed(strength, mode, holdMs);
        });
    }

    @JavascriptInterface
    public void emsZeroB(int slot, boolean on) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.setZeroB(on);
        });
    }

    @JavascriptInterface
    public void emsBFollow(int slot, boolean on) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.setBFollow(on);
        });
    }

    @JavascriptInterface
    public void emsBurstB(int slot, int strength, int mode, int holdMs) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.burstB(strength, mode, holdMs);
        });
    }

    @JavascriptInterface
    public void emsChanTest(int slot, int ch, int strength) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.setEmsChanWave(ch, strength);
        });
    }

    @JavascriptInterface
    public void emsChanStop(int slot) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.setEmsChanStop();
        });
    }

    @JavascriptInterface
    public void emsChannel(int slot, int idx) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.setChannel(idx);
        });
    }

    @JavascriptInterface
    public void emsDual(int slot, boolean on) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.setDualChannel(on);
        });
    }

    @JavascriptInterface
    public void emsRaw(int slot, String hexStr) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.sendRaw(hexStr);
        });
    }

    @JavascriptInterface
    public void emsScan(int slot, boolean all) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null && act.ensureBtPermission()) t.startScan(all);
        });
    }

    @JavascriptInterface
    public void emsStopScan(int slot) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.stopScan();
        });
    }

    @JavascriptInterface
    public void emsConnect(int slot, String address) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null && act.ensureBtPermission()) t.connect(address);
        });
    }

    @JavascriptInterface
    public void emsDisconnect(int slot) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.disconnect();
        });
    }

    @JavascriptInterface
    public void emsWaveUnlock(int slot, boolean on) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.setWaveUnlocked(on);
        });
    }

    @JavascriptInterface
    public void emsWave(int slot, int qda, int pla, int tla, int qdb, int plb, int tlb) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.setEmsWave(qda, pla, tla, qdb, plb, tlb);
        });
    }

    @JavascriptInterface
    public void emsStop(int slot) {
        act.runOnUiThread(() -> {
            YcyToy t = act.emsToyFor(slot);
            if (t != null) t.emergencyStop();
        });
    }

    // ---------- 与设备无关（AI / 语见） ----------

    @JavascriptInterface
    public void aiSend(String baseUrl, String key, String model, String messagesJson, double temp) {
        try {
            org.json.JSONArray msgs = new org.json.JSONArray(messagesJson);
            act.ai.send(baseUrl, key, model, msgs, temp);
        } catch (Exception e) {
            act.ai.send(baseUrl, key, model, new org.json.JSONArray(), temp);
        }
    }

    @JavascriptInterface
    public void aiStop() {
        act.ai.cancel();
    }

    @JavascriptInterface
    public void petReport(String json) {
        act.sendPetReport(json);
    }

    @JavascriptInterface
    public void ycyBase(String url) {
        act.ycy.setBase(url);
    }

    @JavascriptInterface
    public void ycyStatus() {
        act.ycy.checkStatus();
    }

    @JavascriptInterface
    public void ycySend(String commandId) {
        act.ycy.sendCommand(commandId);
    }
}
