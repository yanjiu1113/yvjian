package dev.local.yujian.pet;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * 郊狼 3.0 (DG-LAB Coyote v3) 蓝牙驱动。
 *
 * 服务 0x180C：0x150A 写入（指令） / 0x150B 通知（回传）
 * 服务 0x180A：0x1500 电量
 * B0 指令 20 字节、每 100ms 一帧；BF 指令设置软上限；B1 回传实际强度。
 */
public class Coyote {

    private static final String TAG = "YujianPetCoyote";

    static final UUID SVC_MAIN = UUID.fromString("0000180c-0000-1000-8000-00805f9b34fb");
    static final UUID CH_WRITE = UUID.fromString("0000150a-0000-1000-8000-00805f9b34fb");
    static final UUID CH_NOTIFY = UUID.fromString("0000150b-0000-1000-8000-00805f9b34fb");
    static final UUID CH_BATT = UUID.fromString("00001500-0000-1000-8000-00805f9b34fb");
    static final UUID CH_INFO = UUID.fromString("00001501-0000-1000-8000-00805f9b34fb");
    static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private static final String DEVICE_NAME = "47L121000";
    private static final int MAX_STRENGTH = 200;

    private static final int MODE_NO_CHANGE = 0x0;
    private static final int MODE_ABSOLUTE = 0x3;

    public interface Listener {
        void onDevices(JSONArray list);
        void onState(JSONObject state);
        void onLog(String line);
    }

    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Listener listener;

    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic chWrite;
    private BluetoothGattCharacteristic chNotify;
    private BluetoothGattCharacteristic chBatt;
    private BluetoothGattCharacteristic chInfo;
    private volatile String firmware = "";

    private volatile boolean scanning = false;
    private volatile boolean connected = false;
    private volatile boolean streaming = false;
    private volatile int seq = 0;
    private volatile int strengthA = 0;
    private volatile int strengthB = 0;
    private volatile int limitA = 30;
    private volatile int limitB = 30;
    private volatile int battery = -1;
    private volatile String deviceName = "";
    private volatile String deviceAddr = "";
    private volatile long lastNotifyAt = 0;
    private volatile boolean writeBusy = false;

    // 协议调试开关
    private volatile boolean bfEnabled = true;    // 是否发送 BF 软上限
    private volatile boolean flipNibble = true;  // B0 第2字节：序列号/解析方式是否互换
    private volatile int pulseFreqA = 60;         // A 通道波形频率 10-240
    private volatile int pulseFreqB = 60;         // B 通道波形频率
    private volatile int pulseIntenA = 20;        // A 通道波形强度 0-100（0 = 没电流）
    private volatile int pulseIntenB = 20;        // B 通道波形强度

    // 自动识别：扫描到的候选（地址 -> rssi）与探测队列
    private final java.util.LinkedHashMap<String, int[]> candidates = new java.util.LinkedHashMap<>();
    private final java.util.ArrayList<String> probeQueue = new java.util.ArrayList<>();
    private volatile boolean autoMode = false;
    private volatile String probingAddr = null;

    // 配对（bond）：官方 App 先绑定再握手，不配对设备可能拒绝写入
    private volatile BluetoothDevice pendingDev = null;
    private volatile boolean bondReceiverRegistered = false;
    private final android.content.BroadcastReceiver bondReceiver = new android.content.BroadcastReceiver() {
        @Override
        public void onReceive(android.content.Context context, android.content.Intent intent) {
            BluetoothDevice d = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
            int state = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR);
            if (d == null) return;
            log("配对状态变化：" + state);
            if (state == BluetoothDevice.BOND_BONDED) {
                log("配对成功，开始连接");
                doConnect(d);
            } else if (state == BluetoothDevice.BOND_NONE) {
                log("配对失败或被取消");
            }
        }
    };

    public Coyote(Context ctx, Listener l) {
        this.ctx = ctx.getApplicationContext();
        this.listener = l;
        BluetoothManager bm = (BluetoothManager) this.ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bm != null) adapter = bm.getAdapter();
    }

    // ---------------------------------------------------------------- 对外接口

    @SuppressLint("MissingPermission")
    public boolean isEnabled() {
        return adapter != null && adapter.isEnabled();
    }

    /** 自动识别：扫描 8 秒后按信号强度逐个试探，找到带 0x180C 服务的设备 */
    public void autoFind() {
        candidates.clear();
        probeQueue.clear();
        probingAddr = null;
        autoMode = true;
        log("自动识别：先扫描 8 秒，再逐个试探");
        startScan();
        main.postDelayed(this::startProbing, 8500);
    }

    private void startProbing() {
        if (!autoMode) return;
        stopScan();
        if (candidates.isEmpty()) {
            autoMode = false;
            log("附近没有任何 BLE 设备");
            return;
        }

        // 优先探测广播里带 0x180C 的设备，其余最多试 3 台
        java.util.List<String> prefer = new java.util.ArrayList<>();
        java.util.List<java.util.Map.Entry<String, int[]>> rest = new java.util.ArrayList<>();
        for (java.util.Map.Entry<String, int[]> e : candidates.entrySet()) {
            if (e.getValue().length > 1 && e.getValue()[1] == 1) prefer.add(e.getKey());
            else rest.add(e);
        }
        rest.sort((a, b) -> Integer.compare(b.getValue()[0], a.getValue()[0]));
        for (String a : prefer) probeQueue.add(a);
        if (prefer.isEmpty()) {
            for (int i = 0; i < rest.size() && i < 3; i++) probeQueue.add(rest.get(i).getKey());
        }
        if (prefer.isEmpty()) {
            log("没有设备广播 0x180C，只试信号最强的 " + probeQueue.size() + " 台");
        } else {
            log("发现 " + prefer.size() + " 台候选（广播含 0x180C）");
        }
        nextProbe();
    }

    @SuppressLint("MissingPermission")
    private void nextProbe() {
        if (!autoMode) return;
        if (probeQueue.isEmpty()) {
            autoMode = false;
            log("自动识别结束：没有找到郊狼");
            return;
        }
        probingAddr = probeQueue.remove(0);
        log("试探 " + probingAddr + " …");
        connect(probingAddr);
        main.postDelayed(this::probeTimeout, 4500);
    }

    private void probeTimeout() {
        if (!autoMode || probingAddr == null) return;
        log("试探超时，跳过");
        String a = probingAddr;
        probingAddr = null;
        try {
            if (gatt != null) { gatt.disconnect(); gatt.close(); }
        } catch (Exception ignored) {
        }
        gatt = null;
        connected = false;
        if (a != null && autoMode) nextProbe();
    }

    @SuppressLint("MissingPermission")
    public void startScan() {
        if (adapter == null || !adapter.isEnabled()) {
            log("蓝牙未开启");
            return;
        }
        stopScan();
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) {
            log("这台设备不支持 BLE 扫描");
            return;
        }

        List<ScanFilter> filters = new ArrayList<>();
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();

        scanning = true;
        log("开始扫描（15 秒）…");
        try {
            scanner.startScan(filters, settings, scanCb);
        } catch (Exception e) {
            scanning = false;
            log("扫描失败：" + e.getMessage());
            return;
        }
        main.postDelayed(this::stopScan, 15000);
    }

    @SuppressLint("MissingPermission")
    public void stopScan() {
        if (!scanning) return;
        scanning = false;
        try {
            if (scanner != null) scanner.stopScan(scanCb);
        } catch (Exception ignored) {
        }
        log("扫描结束");
    }

    @SuppressLint("MissingPermission")
    public void connect(String address) {
        if (adapter == null) return;
        stopScan();
        try {
            BluetoothDevice dev = adapter.getRemoteDevice(address);
            deviceAddr = address;
            deviceName = dev.getName() == null ? "" : dev.getName();

            doConnect(dev);
        } catch (Exception e) {
            log("连接失败：" + e.getMessage());
        }
    }

    @SuppressLint("MissingPermission")
    private void doConnect(BluetoothDevice dev) {
        try {
            pendingDev = null;
            log("连接 " + (dev.getName() == null ? dev.getAddress() : dev.getName()) + " …");
            gatt = dev.connectGatt(ctx, false, gattCb, BluetoothDevice.TRANSPORT_LE);
        } catch (Exception e) {
            log("连接失败：" + e.getMessage());
        }
    }

    private void registerBondReceiver() {
        if (bondReceiverRegistered) return;
        try {
            android.content.IntentFilter f = new android.content.IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
            ctx.registerReceiver(bondReceiver, f);
            bondReceiverRegistered = true;
        } catch (Exception e) {
            log("注册配对监听失败：" + e.getMessage());
        }
    }

    @SuppressLint("MissingPermission")
    public void disconnect() {
        streaming = false;
        strengthA = 0;
        strengthB = 0;
        try {
            if (gatt != null) {
                gatt.disconnect();
                gatt.close();
            }
        } catch (Exception ignored) {
        }
        gatt = null;
        chWrite = null;
        chNotify = null;
        connected = false;
        pushState();
    }

    public void setLimit(int a, int b) {
        limitA = clamp(a, 0, MAX_STRENGTH);
        limitB = clamp(b, 0, MAX_STRENGTH);
        if (strengthA > limitA) strengthA = limitA;
        if (strengthB > limitB) strengthB = limitB;
        writeBf();
        pushState();
    }

    public void setStrength(int a, int b) {
        strengthA = clamp(a, 0, limitA);
        strengthB = clamp(b, 0, limitB);
        if (!streaming) startStream();
        pushState();
    }

    public void setDebug(boolean sendBf, boolean flip) {
        bfEnabled = sendBf;
        flipNibble = flip;
        log("调试：BF=" + (sendBf ? "开" : "关") + " 字节序=" + (flip ? "交换" : "正常"));
    }

    public void setPulse(int freqA, int intenA, int freqB, int intenB) {
        pulseFreqA = clamp(freqA, 10, 240);
        pulseFreqB = clamp(freqB, 10, 240);
        pulseIntenA = clamp(intenA, 0, 100);
        pulseIntenB = clamp(intenB, 0, 100);
        log("波形 A " + pulseFreqA + "/" + pulseIntenA + "  B " + pulseFreqB + "/" + pulseIntenB);
    }

    public void emergencyStop() {
        strengthA = 0;
        strengthB = 0;
        for (int i = 0; i < 3; i++) writeB0(0, 0, MODE_ABSOLUTE);
        log("急停：已归零");
        pushState();
    }

    /** 带超时的强度设置：到点由原生层归零（不依赖 WebView 定时器） */
    public void setStrengthTimed(final int a, final int b, int holdMs) {
        setStrength(a, b);
        main.removeCallbacks(autoZero);
        main.postDelayed(autoZero, clamp(holdMs, 1000, 60000));
    }

    private final Runnable autoZero = new Runnable() {
        @Override
        public void run() {
            strengthA = 0;
            strengthB = 0;
            writeB0(0, 0, MODE_ABSOLUTE);
            log("到时归零（郊狼）");
            pushState();
        }
    };

    public synchronized void startStream() {
        if (streaming || !connected) return;
        streaming = true;
        log("开始下发波形帧（10Hz）");
        main.post(ticker);
    }

    public void stopStream() {
        streaming = false;
        main.removeCallbacks(ticker);
        writeB0(0, 0, MODE_ABSOLUTE);
        log("停止下发");
        pushState();
    }

    // ---------------------------------------------------------------- 内部

    private static int clamp(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (!streaming || !connected) return;
            // 30 秒没收到回传就认为掉线，自动归零
            if (lastNotifyAt > 0 && System.currentTimeMillis() - lastNotifyAt > 30000) {
                log("30 秒没有回传，自动归零并停止");
                strengthA = 0;
                strengthB = 0;
                writeB0(0, 0, MODE_ABSOLUTE);
                streaming = false;
                pushState();
                return;
            }
            writeB0(strengthA, strengthB, MODE_ABSOLUTE);
            main.postDelayed(this, 100);
        }
    };

    private final ScanCallback scanCb = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            if (result == null || result.getDevice() == null) return;
            BluetoothDevice d = result.getDevice();
            String name = result.getScanRecord() != null ? result.getScanRecord().getDeviceName() : null;
            if (name == null) {
                try {
                    name = d.getName();
                } catch (Exception ignored) {
                }
            }
            if (name == null) name = "";

            boolean isCoyote = name.startsWith("47L") || name.contains("Coyote");

            // 记录候选（地址 -> rssi），供自动识别排序
            String addr = d.getAddress();
            boolean advCoyote = false;
            try {
                if (result.getScanRecord() != null && result.getScanRecord().getServiceUuids() != null) {
                    for (ParcelUuid u : result.getScanRecord().getServiceUuids()) {
                        if (u.getUuid().toString().startsWith("0000180c")) advCoyote = true;
                    }
                }
            } catch (Exception ignored) {
            }
            if (!candidates.containsKey(addr)) {
                candidates.put(addr, new int[]{result.getRssi(), advCoyote ? 1 : 0});
            }

            try {
                JSONObject o = new JSONObject();
                o.put("name", name.isEmpty() ? "(无名)" : name);
                o.put("address", addr);
                o.put("rssi", result.getRssi());
                o.put("coyote", isCoyote);
                try {
                    JSONArray uu = new JSONArray();
                    if (result.getScanRecord() != null && result.getScanRecord().getServiceUuids() != null) {
                        for (ParcelUuid u : result.getScanRecord().getServiceUuids()) uu.put(u.toString());
                    }
                    o.put("uuids", uu);
                } catch (Exception ignored) {
                }
                listener.onDevices(new JSONArray().put(o));
            } catch (Exception ignored) {
            }

            // 名字直接命中就不用探测了
            if (isCoyote && autoMode) {
                autoMode = false;
                probeQueue.clear();
                log("发现郊狼（名字匹配），直接连接");
                connect(addr);
            }
        }

        @Override
        public void onScanFailed(int errorCode) {
            scanning = false;
            log("扫描失败，code=" + errorCode);
        }
    };

    private void log(String s) {
        Log.d(TAG, s);
        main.post(() -> listener.onLog(s));
    }

    private void pushState() {
        try {
            JSONObject o = new JSONObject();
            o.put("connected", connected);
            o.put("name", deviceName);
            o.put("address", deviceAddr);
            o.put("battery", battery);
            o.put("name", deviceName);
            o.put("address", deviceAddr);
            o.put("a", strengthA);
            o.put("b", strengthB);
            o.put("limitA", limitA);
            if (!firmware.isEmpty()) o.put("firmware", firmware);
            o.put("limitB", limitB);
            o.put("streaming", streaming);
            main.post(() -> listener.onState(o));
        } catch (Exception ignored) {
        }
    }

    private int nextSeq() {
        seq = (seq + 1) & 0x0F;
        return seq;
    }

    public static byte[] buildB0(int seq, int a, int b, int mode) {
        return buildB0(seq, a, b, mode, false);
    }

    public static byte[] buildB0(int seq, int a, int b, int mode, boolean flip) {
        return buildB0(seq, a, b, mode, flip, 60, 50);
    }

    public static byte[] buildB0(int seq, int a, int b, int mode, boolean flip, int freq, int inten) {
        return buildB0(seq, a, b, mode, flip, freq, inten, freq, inten);
    }

    /** 每通道独立：fA/iA 给 A，fB/iB 给 B。频率 10-240，强度 0-100（0 = 无脉冲） */
    public static byte[] buildB0(int seq, int a, int b, int mode, boolean flip,
                                 int fA, int iA, int fB, int iB) {
        byte[] f = new byte[20];
        f[0] = (byte) 0xB0;
        int head = flip ? (((mode & 0x0F) << 4) | (seq & 0x0F))
                        : (((seq & 0x0F) << 4) | (mode & 0x0F));
        f[1] = (byte) head;
        f[2] = (byte) clamp(a, 0, 200);
        f[3] = (byte) clamp(b, 0, 200);
        int fa = clamp(fA, 10, 240), ia = clamp(iA, 0, 100);
        int fb = clamp(fB, 10, 240), ib = clamp(iB, 0, 100);
        for (int i = 4; i < 8; i++) f[i] = (byte) fa;
        for (int i = 8; i < 12; i++) f[i] = (byte) ia;
        for (int i = 12; i < 16; i++) f[i] = (byte) fb;
        for (int i = 16; i < 20; i++) f[i] = (byte) ib;
        return f;
    }

    public static byte[] buildBf(int a, int b) {
        return new byte[]{
                (byte) 0xBF,
                (byte) clamp(a, 0, 200),
                (byte) clamp(b, 0, 200),
                0, 0, 0, 0
        };
    }

    @SuppressLint("MissingPermission")
    private void writeBf() {
        if (!connected || chWrite == null) return;
        if (!bfEnabled) {
            log("已关闭 BF（不设软上限）");
            return;
        }
        byte[] p = buildBf(limitA, limitB);
        write(p);
        log("软上限 → A=" + limitA + " B=" + limitB);
    }

    private void writeB0(int a, int b, int mode) {
        if (!connected || chWrite == null) return;
        write(buildB0(nextSeq(), a, b, mode, flipNibble,
                pulseFreqA, pulseIntenA, pulseFreqB, pulseIntenB));
    }

    @SuppressLint("MissingPermission")
    private synchronized void write(byte[] payload) {
        if (chWrite == null) return;
        if (writeBusy) return;   // 上一帧还没写完，这一帧丢掉（100ms 会再来）
        writeBusy = true;
        try {
            chWrite.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeCharacteristic(chWrite, payload,
                        BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            } else {
                chWrite.setValue(payload);
                gatt.writeCharacteristic(chWrite);
            }
            main.postDelayed(() -> writeBusy = false, 60);
        } catch (Exception e) {
            writeBusy = false;
            log("写入失败：" + e.getMessage());
        }
    }

    private final BluetoothGattCallback gattCb = new BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                log("GATT 已连上，正在找服务…");
                g.discoverServices();
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                connected = false;
                streaming = false;
                strengthA = 0;
                strengthB = 0;
                main.removeCallbacks(ticker);
                log("连接断开（status=" + status + "）");
                pushState();
                if (autoMode) {
                    probingAddr = null;
                    main.postDelayed(Coyote.this::nextProbe, 500);
                }
            }
        }

        @SuppressLint("MissingPermission")
        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            chWrite = findChar(g, SVC_MAIN, CH_WRITE);
            chNotify = findChar(g, SVC_MAIN, CH_NOTIFY);
            if (chWrite == null || chNotify == null) {
                // 官方 App 把 1500/1501 挂在 180A 下，部分固件 150A/150B 也会出现在 180A
                chWrite = findChar(g, null, CH_WRITE);
                chNotify = findChar(g, null, CH_NOTIFY);
            }
            chBatt = findChar(g, null, CH_BATT);
            chInfo = findChar(g, null, CH_INFO);

            if (chWrite == null || chNotify == null) {
                if (autoMode) {
                    log("不是郊狼（缺特征），换下一台");
                    probingAddr = null;
                    try {
                        g.disconnect();
                        g.close();
                    } catch (Exception ignored) {
                    }
                    gatt = null;
                    connected = false;
                    main.post(Coyote.this::nextProbe);
                    return;
                }
                log("没找到写入/通知特征，设备可能不是郊狼 3.0");
                return;
            }

            if (autoMode) {
                autoMode = false;
                probingAddr = null;
                probeQueue.clear();
                log("✓ 找到郊狼：" + deviceAddr);
            }
            connected = true;
            log("服务就绪");

            try {
                g.setCharacteristicNotification(chNotify, true);
                BluetoothGattDescriptor d = chNotify.getDescriptor(CCCD);
                if (d != null) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        g.writeDescriptor(d, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                    } else {
                        d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                        g.writeDescriptor(d);
                    }
                }
            } catch (Exception e) {
                log("订阅通知失败：" + e.getMessage());
            }

            if (chBatt != null) {
                try {
                    g.readCharacteristic(chBatt);
                    // 官方 App 对 1500 同时开 notify：电量会持续推送
                    g.setCharacteristicNotification(chBatt, true);
                    BluetoothGattDescriptor bd = chBatt.getDescriptor(CCCD);
                    if (bd != null) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            g.writeDescriptor(bd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                        } else {
                            bd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                            g.writeDescriptor(bd);
                        }
                    }
                } catch (Exception ignored) {
                }
            }
            if (chInfo != null) {
                try {
                    g.readCharacteristic(chInfo);
                } catch (Exception ignored) {
                }
            }

            // 先写软上限，再开始发帧
            writeBf();
            startStream();
            pushState();
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            if (c == null) return;
            byte[] v = c.getValue();
            if (CH_BATT.equals(c.getUuid())) {
                if (v != null && v.length > 0) {
                    battery = v[0] & 0xFF;
                    log("电量 " + battery + "%");
                    pushState();
                }
            } else if (CH_INFO.equals(c.getUuid()) && v != null && v.length > 0) {
                StringBuilder sb = new StringBuilder();
                for (byte b : v) {
                    int x = b & 0xFF;
                    sb.append(x >= 32 && x < 127 ? (char) x : '.');
                }
                firmware = sb.toString();
                log("固件信息：" + firmware);
                pushState();
            }
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
            if (c != null && CH_BATT.equals(c.getUuid()) && value != null && value.length > 0) {
                int b = value[0] & 0xFF;
                if (b != battery) {
                    battery = b;
                    pushState();
                    log("电量更新 " + battery + "%");
                }
                return;
            }
            handleNotify(value);
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            handleNotify(c.getValue());
        }

        private void handleNotify(byte[] v) {
            if (v == null || v.length == 0) return;
            lastNotifyAt = System.currentTimeMillis();
            if ((v[0] & 0xFF) == 0xB1 && v.length >= 4) {
                final int a = v[2] & 0xFF;
                final int b = v[3] & 0xFF;
                main.post(() -> {
                    // 设备实际强度回传给界面（不覆盖设定值，只用于显示）
                    try {
                        JSONObject o = new JSONObject();
                        o.put("actualA", a);
                        o.put("actualB", b);
                        listener.onState(o);
                    } catch (Exception ignored) {
                    }
                });
            }
        }
    };

    @SuppressLint("MissingPermission")
    private BluetoothGattCharacteristic findChar(BluetoothGatt g, UUID svc, UUID ch) {
        try {
            if (svc != null) {
                BluetoothGattService s = g.getService(svc);
                return s == null ? null : s.getCharacteristic(ch);
            }
            for (BluetoothGattService s : g.getServices()) {
                BluetoothGattCharacteristic c = s.getCharacteristic(ch);
                if (c != null) return c;
            }
        } catch (Exception ignored) {
        }
        return null;
    }
}
