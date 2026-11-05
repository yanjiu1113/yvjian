package dev.local.yujian.pet;

import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

/** 暴露给 WebView 的设备接口，前缀 Coyote。 */
public class PetNative {

    private final MainActivity act;

    PetNative(MainActivity act) {
        this.act = act;
    }

    @JavascriptInterface
    public String deviceState() {
        JSONObject o = new JSONObject();
        try {
            o.put("enabled", act.coyote != null && act.coyote.isEnabled());
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    @JavascriptInterface
    public void autoFind() {
        act.runOnUiThread(() -> {
            if (act.ensureBtPermission()) act.coyote.autoFind();
        });
    }

    @JavascriptInterface
    public void scan() {
        act.runOnUiThread(() -> {
            if (act.ensureBtPermission()) act.coyote.startScan();
        });
    }

    @JavascriptInterface
    public void connect(String address) {
        act.runOnUiThread(() -> {
            if (act.ensureBtPermission()) act.coyote.connect(address);
        });
    }

    @JavascriptInterface
    public void setDebug(boolean sendBf, boolean flip) {
        act.runOnUiThread(() -> act.coyote.setDebug(sendBf, flip));
    }

    @JavascriptInterface
    public void setPulse(int freqA, int intenA, int freqB, int intenB) {
        act.runOnUiThread(() -> act.coyote.setPulse(freqA, intenA, freqB, intenB));
    }

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
    public void ycyScan() {
        act.runOnUiThread(() -> { if (act.ensureBtPermission()) act.ycyToy.startScan(); });
    }

    @JavascriptInterface
    public void ycyStopScan() {
        act.runOnUiThread(() -> act.ycyToy.stopScan());
    }

    @JavascriptInterface
    public void stopScan() {
        act.runOnUiThread(() -> act.coyote.stopScan());
    }

    @JavascriptInterface
    public void ycyScanAll() {
        act.runOnUiThread(() -> { if (act.ensureBtPermission()) act.ycyToy.startScan(true); });
    }

    @JavascriptInterface
    public void ycyConnect(String address) {
        act.runOnUiThread(() -> { if (act.ensureBtPermission()) act.ycyToy.connect(address); });
    }

    @JavascriptInterface
    public void ycyDisconnect() {
        act.runOnUiThread(() -> act.ycyToy.disconnect());
    }

    @JavascriptInterface
    public void ycyQuery() {
        act.runOnUiThread(() -> act.ycyToy.queryInfo());
    }

    @JavascriptInterface
    public void ycyDevType(int t) {
        act.runOnUiThread(() -> act.ycyToy.setDevType(t));
    }

    @JavascriptInterface
    public void ycyEmsFixed(int strength, int mode) {
        act.runOnUiThread(() -> act.emsToy.setEmsFixed(strength, mode));
    }

    @JavascriptInterface
    public void ycyEmsReal(int strength, int freq, int pulse) {
        act.runOnUiThread(() -> act.emsToy.setEmsReal(strength, freq, pulse));
    }

    @JavascriptInterface
    public void ycyEmsFixedTimed(int strength, int mode, int holdMs) {
        act.runOnUiThread(() -> act.emsToy.setEmsFixedTimed(strength, mode, holdMs));
    }

    @JavascriptInterface
    public void emsZeroB(boolean on) {
        act.runOnUiThread(() -> act.emsToy.setZeroB(on));
    }

    @JavascriptInterface
    public void emsBFollow(boolean on) {
        act.runOnUiThread(() -> act.emsToy.setBFollow(on));
    }

    @JavascriptInterface
    public void emsBurstB(int strength, int mode, int holdMs) {
        act.runOnUiThread(() -> act.emsToy.burstB(strength, mode, holdMs));
    }

    @JavascriptInterface
    public void emsChanTest(int ch, int strength) {
        act.runOnUiThread(() -> act.emsToy.setEmsChanWave(ch, strength));
    }

    @JavascriptInterface
    public void emsChanStop() {
        act.runOnUiThread(() -> act.emsToy.setEmsChanStop());
    }

    @JavascriptInterface
    public void emsChannel(int idx) {
        act.runOnUiThread(() -> act.emsToy.setChannel(idx));
    }

    @JavascriptInterface
    public void emsDual(boolean on) {
        act.runOnUiThread(() -> act.emsToy.setDualChannel(on));
    }

    @JavascriptInterface
    public void emsRaw(String hexStr) {
        act.runOnUiThread(() -> act.emsToy.sendRaw(hexStr));
    }

    @JavascriptInterface
    public void emsScan(boolean all) {
        act.runOnUiThread(() -> act.emsToy.startScan(all));
    }

    @JavascriptInterface
    public void emsStopScan() {
        act.runOnUiThread(() -> act.emsToy.stopScan());
    }

    @JavascriptInterface
    public void emsConnect(String address) {
        act.runOnUiThread(() -> act.emsToy.connect(address));
    }

    @JavascriptInterface
    public void emsDisconnect() {
        act.runOnUiThread(() -> act.emsToy.disconnect());
    }

    @JavascriptInterface
    public void emsWaveUnlock(boolean on) {
        act.runOnUiThread(() -> act.emsToy.setWaveUnlocked(on));
    }

    @JavascriptInterface
    public void emsWave(int qda, int pla, int tla, int qdb, int plb, int tlb) {
        act.runOnUiThread(() -> act.emsToy.setEmsWave(qda, pla, tla, qdb, plb, tlb));
    }

    @JavascriptInterface
    public void emsStop() {
        act.runOnUiThread(() -> act.emsToy.emergencyStop());
    }

    @JavascriptInterface
    public void ycyMode(int motors, int mode) {
        act.runOnUiThread(() -> act.ycyToy.setMode(motors, mode));
    }

    @JavascriptInterface
    public void ycySpeed(int a, int b, int c) {
        act.runOnUiThread(() -> act.ycyToy.setSpeed(a, b, c));
    }

    @JavascriptInterface
    public void setStrengthTimed(int a, int b, int holdMs) {
        act.runOnUiThread(() -> act.coyote.setStrengthTimed(a, b, holdMs));
    }

    @JavascriptInterface
    public void ycySpeedTimed(int a, int b, int c, int holdMs) {
        act.runOnUiThread(() -> act.ycyToy.setSpeedTimed(a, b, c, holdMs));
    }

    @JavascriptInterface
    public void ycyStop() {
        act.runOnUiThread(() -> act.ycyToy.emergencyStop());
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

    @JavascriptInterface
    public void disconnect() {
        act.runOnUiThread(() -> act.coyote.disconnect());
    }

    @JavascriptInterface
    public void setLimit(int a, int b) {
        act.runOnUiThread(() -> act.coyote.setLimit(a, b));
    }

    @JavascriptInterface
    public void setStrength(int a, int b) {
        act.runOnUiThread(() -> act.coyote.setStrength(a, b));
    }

    @JavascriptInterface
    public void stopStrenght() {
        act.runOnUiThread(() -> act.coyote.emergencyStop());
    }

    @JavascriptInterface
    public void emergencyStop() {
        act.runOnUiThread(() -> act.coyote.emergencyStop());
    }
}
