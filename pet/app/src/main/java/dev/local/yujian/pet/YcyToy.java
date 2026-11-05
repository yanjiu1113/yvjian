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
 * 役次元（YSKJ_TOY_BLE V1.1）蓝牙驱动。
 *
 * 服务 FF40：FF41 写入（无响应）/ FF42 通知
 * 指令：0x35 开头，最后一位是前面所有字节的累加和（低 8 位）
 *   0x10  查询设备信息
 *   0x11  固定模式：马达掩码 + 模式号（0=关，1..N）
 *   0x12  速率控制：A/B/C 力度（0=关，1-20）
 *   0x13  设备上报电量
 */
public class YcyToy {

    private static final String TAG = "YujianPetYcy";

    static final UUID SVC = UUID.fromString("0000ff40-0000-1000-8000-00805f9b34fb");
    static final UUID CH_WRITE = UUID.fromString("0000ff41-0000-1000-8000-00805f9b34fb");
    static final UUID CH_NOTIFY = UUID.fromString("0000ff42-0000-1000-8000-00805f9b34fb");
    static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    public interface Listener {
        void onDevices(JSONArray list);
        void onState(JSONObject state);
        void onLog(String line);
    }

    /** 实例编号：0=榨精杯，1=电击器 */
    public int devId = 0;

    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Listener listener;

    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic chWrite, chNotify;

    private volatile boolean scanning = false;
    private volatile boolean connected = false;
    private volatile String name = "", addr = "";
    private volatile int battery = -1;
    private volatile int modesA = 0, modesB = 0, modesC = 0;
    private volatile int modelId = 0, version = 0;
    private volatile int speedA = 0, speedB = 0, speedC = 0;
    private volatile boolean writeBusy = false;

    // 设备类型：0=飞机杯（0x12 力度 / 0x11 马达模式）；1=电击器（EMS 0x11 子命令）
    private volatile int devType = 0;

    /** 这个实例是不是电击器（由 MainActivity 创建时指定，或按服务列表自动判定） */
    public volatile boolean emsRole = false;

    /** 电击器全局硬上限：任何入口传进来的强度都不会超过它 */
    public static final int EMS_HARD_LIMIT = 20;


    /** 波形帧硬限幅：默认锁在 20，必须显式解锁才允许更高 */
    private volatile boolean waveUnlocked = false;

    public void setWaveUnlocked(boolean on) {
        waveUnlocked = on;
        log(on ? "波形限幅已解除（最高 180，危险）" : "波形已限制在 20 以内");
    }
    private volatile int emsMode = 1;        // 1-16
    private volatile int emsStrength = 0;    // 0-276
    private volatile int emsFreq = 50;       // 1-100 Hz
    private volatile int emsPulse = 50;      // 0-100
    private volatile int chLink = -1, chOpen = -1, chStrength = 0, chMode = 0;
    private volatile String lastNotify = "";
    private volatile String servicesInfo = "";
    private final java.util.List<BluetoothGattService> candidates = new java.util.ArrayList<>();
    private volatile int channelIndex = 0;

    /** 连接代号：断开/重连后 +1，用来作废上一轮遗留的延时写入 */
    private volatile int gen = 0;
    private volatile int retryLeft = 1;
    private volatile int notifyCount = 0;
    private volatile int writeOk = 0, writeFail = 0;

    public YcyToy(Context ctx, Listener l) {
        this.ctx = ctx.getApplicationContext();
        this.listener = l;
        BluetoothManager bm = (BluetoothManager) this.ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bm != null) adapter = bm.getAdapter();
    }

    // ---------------------------------------------------------------- 指令构造

    static byte sum(byte[] b, int len) {
        int s = 0;
        for (int i = 0; i < len; i++) s += (b[i] & 0xFF);
        return (byte) (s & 0xFF);
    }

    /** 0x10 查询设备信息 */
    static byte[] cmdInfo() {
        byte[] f = new byte[3];
        f[0] = 0x35;
        f[1] = 0x10;
        f[2] = sum(f, 2);
        return f;
    }

    /** 0x11 固定模式：motors 位掩码，mode 0=关 */
    static byte[] cmdMode(int motors, int mode) {
        byte[] f = new byte[5];
        f[0] = 0x35;
        f[1] = 0x11;
        f[2] = (byte) (motors & 0x07);
        f[3] = (byte) (mode & 0xFF);
        f[4] = sum(f, 4);
        return f;
    }

    /** 0x12 速率：A/B/C 力度 0-20 */
    static byte[] cmdSpeed(int a, int b, int c) {
        byte[] f = new byte[6];
        f[0] = 0x35;
        f[1] = 0x12;
        f[2] = (byte) clamp(a, 0, 20);
        f[3] = (byte) clamp(b, 0, 20);
        f[4] = (byte) clamp(c, 0, 20);
        f[5] = sum(f, 5);
        return f;
    }

    /** 查询：0x35 0x71 type（1=通道 2=马达 3=电量） */
    static byte[] cmdQuery(int type) {
        byte[] f = new byte[4];
        f[0] = 0x35;
        f[1] = 0x71;
        f[2] = (byte) clamp(type, 1, 5);
        f[3] = sum(f, 3);
        return f;
    }

    /** 统一限幅：先夹到 0-276，再夹到硬上限 */
    private static int emsClamp(int v) {
        return clamp(v, 0, EMS_HARD_LIMIT);
    }

    /** EMS 固定模式：0x35 0x11 0x01 强度高 强度低 模式 校验 */
    static byte[] cmdEmsFixed(int strength, int mode) {
        int s = clamp(strength, 0, 276);
        byte[] f = new byte[7];
        f[0] = 0x35;
        f[1] = 0x11;
        f[2] = 0x01;
        f[3] = (byte) ((s >> 8) & 0xFF);
        f[4] = (byte) (s & 0xFF);
        f[5] = (byte) clamp(mode, 1, 16);
        f[6] = sum(f, 6);
        return f;
    }

    /** EMS 实时模式（旧写法，只带 A 段）：0x35 0x11 0x02 强度高 强度低 频率 脉冲 校验 */
    static byte[] cmdEmsReal(int strength, int freq, int pulse) {
        int s = clamp(strength, 0, 276);
        byte[] f = new byte[8];
        f[0] = 0x35;
        f[1] = 0x11;
        f[2] = 0x02;
        f[3] = (byte) ((s >> 8) & 0xFF);
        f[4] = (byte) (s & 0xFF);
        f[5] = (byte) clamp(freq, 1, 100);
        f[6] = (byte) clamp(pulse, 0, 100);
        f[7] = sum(f, 7);
        return f;
    }

    /**
     * EMS 实时模式（官方新协议完整帧，A/B 两路同帧）：
     * 35 11 02 [A强度2B][A波形][A时长] [B强度2B][B波形][B时长] 校验
     */
    static byte[] cmdEmsDual(int sa, int pla, int tla, int sb, int plb, int tlb) {
        int a = clamp(sa, 0, 276), b = clamp(sb, 0, 276);
        byte[] f = new byte[12];
        f[0] = 0x35;
        f[1] = 0x11;
        f[2] = 0x02;
        f[3] = (byte) ((a >> 8) & 0xFF);
        f[4] = (byte) (a & 0xFF);
        f[5] = (byte) clamp(pla, 1, 100);
        f[6] = (byte) clamp(tla, 0, 100);
        f[7] = (byte) ((b >> 8) & 0xFF);
        f[8] = (byte) (b & 0xFF);
        f[9] = (byte) clamp(plb, 1, 100);
        f[10] = (byte) clamp(tlb, 0, 100);
        f[11] = sum(f, 11);
        return f;
    }

    private static int clamp(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    // ---------------------------------------------------------------- 扫描

    @SuppressLint("MissingPermission")
    public void startScan() {
        startScan(false);
    }

    /** all=true 时不过滤服务，列出所有 BLE 设备，方便找无广播的型号 */
    @SuppressLint("MissingPermission")
    public void startScan(boolean all) {
        if (adapter == null || !adapter.isEnabled()) {
            log("蓝牙未开启");
            return;
        }
        stopScan();
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) { log("不支持 BLE 扫描"); return; }

        List<ScanFilter> filters = new ArrayList<>();
        if (!all) {
            filters.add(new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SVC)).build());
        }

        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();

        scanning = true;
        log(all ? "扫描全部 BLE 设备（15 秒）…" : "扫描役次元设备（15 秒）…");
        try {
            scanner.startScan(filters, settings, cb);
        } catch (Exception e) {
            scanning = false;
            log("扫描失败：" + e.getMessage());
            return;
        }
        main.postDelayed(this::stopScan, all ? 12000 : 15000);
    }

    @SuppressLint("MissingPermission")
    public void stopScan() {
        if (!scanning) return;
        scanning = false;
        try { if (scanner != null) scanner.stopScan(cb); } catch (Exception ignored) { }
        log("扫描结束");
    }

    private final ScanCallback cb = new ScanCallback() {
        @Override
        public void onScanResult(int type, ScanResult r) {
            if (r == null || r.getDevice() == null) return;
            BluetoothDevice d = r.getDevice();
            String n = r.getScanRecord() != null ? r.getScanRecord().getDeviceName() : null;
            if (n == null) {
                try { n = d.getName(); } catch (Exception ignored) { }
            }
            try {
                JSONObject o = new JSONObject();
                o.put("dev", devId);
                o.put("name", n == null || n.isEmpty() ? "(无名)" : n);
                o.put("address", d.getAddress());
                o.put("rssi", r.getRssi());
                listener.onDevices(new JSONArray().put(o));
            } catch (Exception ignored) { }
        }

        @Override
        public void onScanFailed(int code) {
            scanning = false;
            log("扫描失败 code=" + code);
        }
    };

    // ---------------------------------------------------------------- 连接

    @SuppressLint("MissingPermission")
    public void connect(String address) {
        if (adapter == null) return;
        stopScan();
        try {
            // 旧连接必须先关掉，否则系统会把两条链路都留在栈里，第二条直接 133/断开
            main.removeCallbacks(emsKeepAlive);
            main.removeCallbacks(emsZero);
            writeBusy = false;
            gen++;
            if (gatt != null) {
                try { gatt.disconnect(); gatt.close(); } catch (Exception ignored) { }
                gatt = null;
            }
            connected = false;
            chWrite = null;
            chNotify = null;
            candidates.clear();
            BluetoothDevice dev = adapter.getRemoteDevice(address);
            addr = address;
            name = dev.getName() == null ? "" : dev.getName();
            log("连接 " + addr + " …");
            gatt = dev.connectGatt(ctx, false, gattCb, BluetoothDevice.TRANSPORT_LE);
        } catch (Exception e) {
            log("连接失败：" + e.getMessage());
        }
    }

    @SuppressLint("MissingPermission")
    public void disconnect() {
        try {
            stopKeepAlive();
        if (connected && devType == 0 && !emsRole) sendSpeed(0, 0, 0);
            if (gatt != null) { gatt.disconnect(); gatt.close(); }
        } catch (Exception ignored) { }
        gatt = null;
        chWrite = null;
        chNotify = null;
        connected = false;
        pushState();
    }

    public void queryInfo() {
        write(cmdInfo());
        log("查询设备信息");
    }

    public void setMode(int motors, int mode) {
        write(cmdMode(motors, mode));
        log("模式：马达 0x" + Integer.toHexString(motors) + " → " + mode);
    }

    public void setSpeed(int a, int b, int c) {
        speedA = clamp(a, 0, 20);
        speedB = clamp(b, 0, 20);
        speedC = clamp(c, 0, 20);
        sendSpeed(speedA, speedB, speedC);
        pushState();
    }

    private void sendSpeed(int a, int b, int c) {
        write(cmdSpeed(a, b, c));
    }

    /** 带超时的力度设置：到点由原生层归零，避免后台定时器失效 */
    public void setSpeedTimed(int a, int b, int c, int holdMs) {
        setSpeed(a, b, c);
        main.removeCallbacks(ycyZero);
        main.postDelayed(ycyZero, clamp(holdMs, 1000, 60000));
    }

    private final Runnable ycyZero = new Runnable() {
        @Override
        public void run() {
            speedA = speedB = speedC = 0;
            write(cmdSpeed(0, 0, 0));
            write(cmdMode(0x07, 0));
            log("到时归零（役次元）");
            pushState();
        }
    };

    /** 切换控制通道（0=第一个候选，1=第二个…） */
    public void setChannel(int idx) {
        if (candidates.isEmpty()) { log("没有可切换的通道"); return; }
        BluetoothGattService sv = candidates.get(Math.max(0, Math.min(idx, candidates.size() - 1)));
        BluetoothGattCharacteristic wt = null, nt = null;
        for (BluetoothGattCharacteristic c : sv.getCharacteristics()) {
            int pr = c.getProperties();
            if (wt == null && ((pr & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
                    || (pr & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0)) wt = c;
            if (nt == null && (pr & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) nt = c;
        }
        if (wt == null || nt == null) { log("该服务不可用"); return; }
        chWrite = wt;
        chNotify = nt;
        channelIndex = idx;
        log("切到通道 " + shortUuid(sv.getUuid()) + "（写 " + shortUuid(wt.getUuid()) + " 通知 " + shortUuid(nt.getUuid()) + "）");
        try {
            if (gatt != null) {
                gatt.setCharacteristicNotification(chNotify, true);
                BluetoothGattDescriptor dd = chNotify.getDescriptor(CCCD);
                if (dd != null) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        gatt.writeDescriptor(dd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                    } else {
                        dd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                        gatt.writeDescriptor(dd);
                    }
                }
            }
        } catch (Exception ignored) { }
        pushState();
    }

    /** 发送任意十六进制（自动补校验和） */
    public void sendRaw(String hexStr) {
        try {
            String s = hexStr.replaceAll("[^0-9A-Fa-f]", "");
            if (s.length() < 2 || s.length() % 2 != 0) { log("HEX 长度不对"); return; }
            byte[] b = new byte[s.length() / 2];
            for (int i = 0; i < b.length; i++) {
                b[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
            }
            // 手动 HEX 也受硬上限约束：35 11 01/02 的强度是大端两字节
            if (b.length >= 6 && (b[0] & 0xFF) == 0x35 && (b[1] & 0xFF) == 0x11
                    && ((b[2] & 0xFF) == 0x01 || (b[2] & 0xFF) == 0x02)) {
                int want = ((b[3] & 0xFF) << 8) | (b[4] & 0xFF);
                if (want > EMS_HARD_LIMIT) {
                    b[3] = (byte) (EMS_HARD_LIMIT >> 8);
                    b[4] = (byte) (EMS_HARD_LIMIT & 0xFF);
                    log("HEX 强度 " + want + " 超过硬上限，已改为 " + EMS_HARD_LIMIT);
                }
            }
            byte[] full = new byte[b.length + 1];
            System.arraycopy(b, 0, full, 0, b.length);
            full[b.length] = sum(b, b.length);
            write(full);
            log("原始发送 " + hex(full));
        } catch (Exception e) {
            log("原始发送失败：" + e.getMessage());
        }
    }

    /** 看门狗：设备几秒收不到指令会自动断输出，所以持续重发 */
    private final Runnable emsKeepAlive = new Runnable() {
        @Override
        public void run() {
            if (emsStrength <= 0) return;
            byte[] f = emsRealMode ? emsRealtimeFrame(emsStrength, emsFreq, emsPulse)
                    : cmdEmsFixed(emsStrength, emsMode);
            write(f);
            if (bFollow && candidates.size() > 1) writeTo(f, 1);
            main.postDelayed(this, 700);
        }
    };

    /**
     * 按当前电极口选择生成实时帧。
     * 官方一帧同时带 A/B 两段，用哪一路就把另一路填 0——这是 B 口能不能出电的关键。
     */
    private byte[] emsRealtimeFrame(int strength, int freq, int pulse) {
        int sa, sb;
        if (dualChannel) {
            sa = sb = strength;
        } else if (channelIndex == 0) {
            sa = strength;
            sb = 0;
        } else {
            sa = 0;
            sb = strength;
        }
        return cmdEmsDual(sa, freq, pulse, sb, freq, pulse);
    }

    private volatile boolean emsRealMode = false;

    /** B 跟随 A：A 出力时，每个保活周期也往备用通道灌一帧（验证 B 口是否需要连续帧） */
    private volatile boolean bFollow = false;

    /** 停止时是否也往 B 通道写零帧。默认关：实测写 B 会让 B 短暂带电 */
    private volatile boolean zeroB = false;

    /** 是否处于 35 11 03 分通道协议模式（需要额外的停止帧） */
    private volatile boolean chanMode = false;

    public void setZeroB(boolean on) {
        zeroB = false;
        log("停止时不再写 B 通道（0.79 起强制关闭：写 AE00 会让 B 口瞬间带电）");
    }

    public void setBFollow(boolean on) {
        bFollow = on;
        log(on ? "B 跟随 A：开（每 700ms 补发一帧到 AE00）" : "B 跟随 A：关");
    }

    private void startKeepAlive() {
        main.removeCallbacks(emsKeepAlive);
        if (channelIndex != 0) return;   // 备用通道是开关型，重发会来回切
        main.postDelayed(emsKeepAlive, 700);
    }

    private void stopKeepAlive() {
        main.removeCallbacks(emsKeepAlive);
    }

    /**
     * 官方 ele 协议（mixins/ele.js）：一帧同时带 A、B 两路
     * 35 11 02 [A强度][A波形][A时长] [B强度][B波形][B时长] [校验]
     * 强度 0-180，波形 1-100，时长 0-100
     */
    public void setEmsWave(int qda, int pla, int tla, int qdb, int plb, int tlb) {
        // 硬上限写死 5：无论界面传什么，永远不超过 5
        qda = Math.max(0, Math.min(5, qda));
        qdb = Math.max(0, Math.min(5, qdb));
        emsStrength = 0;
        byte[] f = {
                0x35, 0x11, 0x02,
                (byte) clamp(qda, 0, 180), (byte) clamp(pla, 0, 100), (byte) clamp(tla, 0, 100),
                (byte) clamp(qdb, 0, 180), (byte) clamp(plb, 0, 100), (byte) clamp(tlb, 0, 100)
        };
        byte cs = 0;
        for (byte b : f) cs += b;
        byte[] frame = new byte[f.length + 1];
        System.arraycopy(f, 0, frame, 0, f.length);
        frame[f.length] = cs;
        emsStrength = clamp(qda, 0, 276);
        if (dualChannel) writeBoth(frame); else write(frame);
        log("EMS 双通道：A " + clamp(qda, 0, 180) + "/" + clamp(pla, 0, 100) + "/" + clamp(tla, 0, 100)
                + "  B " + clamp(qdb, 0, 180) + "/" + clamp(plb, 0, 100) + "/" + clamp(tlb, 0, 100));
        pushState();
    }

    /** 官方停止帧 */
    private byte[] emsWaveStop() {
        byte[] f = {0x35, 0x11, 0x02, 0x00, 0x00, 0x01, 0x00, 0x00, 0x01};
        byte cs = 0;
        for (byte b : f) cs += b;
        byte[] out = new byte[f.length + 1];
        System.arraycopy(f, 0, out, 0, f.length);
        out[f.length] = cs;
        return out;
    }

    /**
     * 分通道"协议模式"（官方 ele_新协议）：35 11 03 [通道] [强度2字节] [波形串]
     * 通道 0=停/全部、1=A 口、2=B 口；官方检测帧为 351103010001110101（A 口，强度 1）。
     * 与之前的 35 11 02 完全不同：0x03 不会和实时帧撞车。
     * 强度在这里再夹一次，最高 5，且 4 秒后自动停。
     */
    public void setEmsChanWave(int ch, int strength) {
        chanMode = true;
        final int c = clamp(ch, 0, 2);
        final int st = Math.max(0, Math.min(5, strength));
        // 官方顺序：先 35 13 01 开一次会话，再发分通道波形。波形串 11 01 11 01 = 两个(波形0x11,时长1)的循环
        byte[] before = {0x35, 0x13, 0x01};
        byte[] f = {0x35, 0x11, 0x03, (byte) c, (byte) ((st >> 8) & 0xFF), (byte) (st & 0xFF),
                0x11, 0x01, 0x11, 0x01};
        emsStrength = st;
        writeBusy = false;
        if (!candidates.isEmpty()) writeTo(before, 0); else write(before);
        main.postDelayed(() -> {
            if (!chanMode) return;
            writeBusy = false;
            if (!candidates.isEmpty()) writeTo(f, 0); else write(f);
        }, 120);
        log("通道协议：口 " + (c == 1 ? "A" : c == 2 ? "B" : "停") + " 强度 " + st + "（会话帧 + 波形帧，4 秒自动停）");
        main.removeCallbacks(emsChanAutoStop);
        main.postDelayed(emsChanAutoStop, 4000);
        pushState();
    }

    /** 关掉分通道输出：35 11 03 00 00 00 00 00 */
    public void setEmsChanStop() {
        chanMode = false;
        main.removeCallbacks(emsChanAutoStop);
        byte[] f = {0x35, 0x11, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00};
        byte[] after = {0x35, 0x13, 0x02};
        writeBusy = false;
        if (!candidates.isEmpty()) writeTo(f, 0); else write(f);
        main.postDelayed(() -> {
            writeBusy = false;
            if (!candidates.isEmpty()) writeTo(f, 0); else write(f);
        }, 90);
        main.postDelayed(() -> {
            writeBusy = false;
            if (!candidates.isEmpty()) writeTo(after, 0); else write(after);
        }, 180);
        log("通道协议：已发送停止帧");
        pushState();
    }

    private final Runnable emsChanAutoStop = new Runnable() {
        @Override
        public void run() {
            if (chanMode) setEmsChanStop();
        }
    };

    /**
     * B 口（AE00）连发测试：备用通道对单帧不响应，但连续帧会短暂出力。
     * 每 250ms 重发同一帧，到期自动停。强度同样受 EMS_HARD_LIMIT 限制。
     */
    public void burstB(int strength, int mode, int holdMs) {
        final int st = emsClamp(strength);
        final int md = clamp(mode, 1, 16);
        final int g0 = gen;
        final long end = System.currentTimeMillis() + clamp(holdMs, 500, 8000);
        final byte[] f = cmdEmsFixed(st, md);
        log("B 口连发：强度 " + st + " 模式 " + md + " 持续 " + clamp(holdMs, 500, 8000) + "ms");
        Runnable[] tick = new Runnable[1];
        tick[0] = () -> {
            if (g0 != gen) return;
            if (System.currentTimeMillis() > end) {
                writeBusy = false;
                byte[] z = cmdEmsFixed(0, md);
                writeTo(z, 1);
                log("B 口连发结束");
                return;
            }
            writeBusy = false;
            writeTo(f, 1);
            main.postDelayed(tick[0], 250);
        };
        main.postDelayed(tick[0], 0);
    }

    /** 带超时的电击输出：到点由原生层归零 */
    public void setEmsFixedTimed(int strength, int mode, int holdMs) {
        setEmsFixed(strength, mode);
        main.removeCallbacks(emsZero);
        main.postDelayed(emsZero, clamp(holdMs, 300, 60000));
    }

    private final Runnable emsZero = new Runnable() {
        @Override
        public void run() {
            emsStrength = 0;
            panicZero();
            log("到时归零（电击器）");
            pushState();
        }
    };

    /**
     * 安全归零：电击器会锁存最后一帧，必须真的把 0 送到"正在出力的那条通道"。
     * 无视 50ms 防抖，主/备两条通道各发三遍。
     */
    private void panicZero() {
        stopKeepAlive();
        emsRealMode = false;
        main.removeCallbacks(emsChanAutoStop);
        chanMode = false;
        final byte[] zc = {0x35, 0x11, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00};
        byte[] zf = cmdEmsFixed(0, emsMode);
        byte[] zr = cmdEmsDual(0, 1, 1, 0, 1, 1);   // 官方 stopFrames：35 11 02 0000 0101 0000 0101
        final int g0 = gen;
        for (int round = 0; round < 3; round++) {
            main.postDelayed(() -> {
                if (g0 != gen) return;      // 已经断线/重连，别再往旧链路写
                writeBusy = false;          // 强制解除防抖，别让归零帧被吞
                if (!candidates.isEmpty()) {
                    writeTo(zf, 0);
                } else {
                    write(zf);
                }
                main.postDelayed(() -> {
                    if (g0 != gen) return;
                    writeBusy = false;
                    byte[] zw = emsWaveStop();
                    if (!candidates.isEmpty()) {
                        writeTo(zw, 0);
                    } else {
                        write(zw);
                    }
                }, 90);
                main.postDelayed(() -> {
                    if (g0 != gen) return;
                    writeBusy = false;
                    if (!candidates.isEmpty()) {
                        writeTo(zr, 0);
                    } else {
                        write(zr);
                    }
                    writeBusy = false;
                    write(zc);          // 顺带把分通道协议也停掉
                }, 45);
            }, round * 260L);
        }
        log("安全归零：0 强度已发往全部通道");
    }

    /** 主动查询电量与通道状态（电击器用 0x71 查询） */
    public void queryStatus() {
        write(cmdQuery(3));
        main.postDelayed(() -> write(cmdQuery(1)), 150);
    }

    public void setDevType(int t) {
        devType = t == 1 ? 1 : 0;
        log("设备类型：" + (devType == 1 ? "电击器(EMS)" : "飞机杯"));
    }

    /** 电击器：固定模式 */
    public void setEmsFixed(int strength, int mode) {
        emsStrength = emsClamp(strength);
        emsMode = clamp(mode, 1, 16);
        emsRealMode = false;
        byte[] frame = cmdEmsFixed(emsStrength, emsMode);
        if (emsStrength > 0) {
            if (dualChannel) writeBoth(frame); else write(frame);
            startKeepAlive();
        } else {
            panicZero();
        }
        log("EMS 固定：强度 " + emsStrength + " 模式 " + emsMode
                + (channelIndex == 0 ? "（主通道·持续）" : "（备用·再发一次=关闭）"));
        pushState();
    }

    /** 电击器：实时模式（频率/脉冲可调），按当前电极口把强度写进 A 段或 B 段 */
    public void setEmsReal(int strength, int freq, int pulse) {
        emsStrength = emsClamp(strength);
        emsFreq = clamp(freq, 1, 100);
        emsPulse = clamp(pulse, 0, 100);
        emsRealMode = true;
        byte[] frame2 = emsRealtimeFrame(emsStrength, emsFreq, emsPulse);
        if (emsStrength > 0) {
            if (dualChannel) writeBoth(frame2); else write(frame2);
            startKeepAlive();
        } else {
            panicZero();
        }
        log("EMS 实时：强度 " + emsStrength + " " + emsFreq + "Hz 脉冲 " + emsPulse
                + " → " + (dualChannel ? "A+B" : channelIndex == 0 ? "A 口" : "B 口"));
        pushState();
    }

    public void emergencyStop() {
        speedA = speedB = speedC = 0;
        if (devType == 1 || emsRole) {
            emsStrength = 0;
            emsRealMode = false;
            panicZero();
        } else {
            write(cmdMode(0x07, 0));
            write(cmdSpeed(0, 0, 0));
        }
        log("急停：全部归零");
        pushState();
    }

    // ---------------------------------------------------------------- 蓝牙回调

    @SuppressLint("MissingPermission")
    private volatile boolean dualChannel = false;

    public void setDualChannel(boolean on) {
        dualChannel = on;
        log(on ? "双通道输出：开" : "双通道输出：关");
    }

    /** 同时发到两条通道（A 主 / B 备用） */
    private void writeBoth(byte[] payload) {
        writeTo(payload, 0);
        if (candidates.size() > 1) {
            main.postDelayed(() -> writeTo(payload, 1), 80);
        }
    }

    @SuppressLint("MissingPermission")
    private synchronized void writeTo(byte[] payload, int idx) {
        if (!connected || candidates.size() <= idx) return;
        BluetoothGattCharacteristic wt = null;
        for (BluetoothGattCharacteristic c : candidates.get(idx).getCharacteristics()) {
            int pr = c.getProperties();
            if ((pr & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
                    || (pr & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0) { wt = c; break; }
        }
        if (wt == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeCharacteristic(wt, payload, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            } else {
                wt.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                wt.setValue(payload);
                gatt.writeCharacteristic(wt);
            }
            if (idx == 1) log("已发备用通道 " + hex(payload));
        } catch (Exception e) {
            log("备用通道写入失败：" + e.getMessage());
        }
    }

    private synchronized void write(byte[] payload) {
        if (!connected || chWrite == null) return;
        if (writeBusy) return;
        writeBusy = true;
        try {
            chWrite.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeCharacteristic(chWrite, payload, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            } else {
                chWrite.setValue(payload);
                boolean ok = gatt.writeCharacteristic(chWrite);
                if (!ok) { writeFail++; log("写入被拒 " + hex(payload)); }
            }
            main.postDelayed(() -> writeBusy = false, 50);
            writeOk++;
            if (writeOk <= 3) log("写入成功 " + hex(payload));
        } catch (Exception e) {
            writeBusy = false;
            log("写入失败：" + e.getMessage());
        }
    }

    static String shortUuid(java.util.UUID u) {
        String s = u.toString().toUpperCase();
        if (s.startsWith("0000") && s.endsWith("-0000-1000-8000-00805F9B34FB")) {
            return s.substring(4, 8);
        }
        return s;
    }

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < b.length && i < 12; i++) {
            if (i > 0) sb.append(' ');
            sb.append(String.format("%02X", b[i]));
        }
        return sb.toString();
    }

    private void pushState() {
        try {
            JSONObject o = new JSONObject();
            o.put("dev", devId);
        o.put("connected", connected);
            o.put("name", name);
            o.put("address", addr);
            o.put("battery", battery);
            o.put("modelId", modelId);
            o.put("version", version);
            o.put("modesA", modesA);
            o.put("modesB", modesB);
            o.put("modesC", modesC);
            o.put("devType", devType);
            o.put("emsStrength", emsStrength);
            o.put("emsMode", emsMode);
            o.put("emsFreq", emsFreq);
            o.put("emsPulse", emsPulse);
            o.put("chLink", chLink);
            o.put("chOpen", chOpen);
            o.put("chStrength", chStrength);
            o.put("chMode", chMode);
            o.put("lastNotify", lastNotify);
            o.put("services", servicesInfo);
            o.put("channel", channelIndex);
            o.put("channelCount", candidates.size());
            o.put("channelName", candidates.isEmpty() ? "" : shortUuid(candidates.get(Math.min(channelIndex, candidates.size()-1)).getUuid()));
            o.put("writeOk", writeOk);
            o.put("writeFail", writeFail);
            o.put("a", speedA);
            o.put("b", speedB);
            o.put("c", speedC);
            listener.onState(o);
        } catch (Exception ignored) { }
    }

    private void log(String s) {
        Log.d(TAG, s);
        main.post(() -> listener.onLog(s));
    }

    private final BluetoothGattCallback gattCb = new BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                log("已连上，发现服务…");
                g.discoverServices();
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                connected = false;
                speedA = speedB = speedC = 0;
                emsStrength = 0;
                stopKeepAlive();
                gen++;
                try { g.close(); } catch (Exception ignored) { }
                gatt = null;
                chWrite = null;
                chNotify = null;
                if (status != 0) log("连接异常断开 status=" + status + "（" + (status == 133 ? "GATT 133，常见于设备已被其他连接占用" : "检查设备是否被别的 App 连着") + "）");
                else log("连接断开");
                pushState();
                // 状态非正常时自动重试一次；被占用的情况重试也大概率失败，但值得一次
                if (status != 0 && retryLeft > 0 && addr != null) {
                    retryLeft--;
                    final String a = addr;
                    log("600ms 后重连一次（剩余 " + retryLeft + "）");
                    main.postDelayed(() -> { if (!connected) connect(a); }, 600);
                }
            }
        }

        @SuppressLint("MissingPermission")
        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            // 先把所有服务/特征打进日志，便于排查非 FF40 的设备
            StringBuilder all = new StringBuilder();
            for (BluetoothGattService sv : g.getServices()) {
                all.append(shortUuid(sv.getUuid())).append('[');
                boolean first = true;
                for (BluetoothGattCharacteristic c : sv.getCharacteristics()) {
                    if (!first) all.append(',');
                    first = false;
                    all.append(shortUuid(c.getUuid()));
                    int pr = c.getProperties();
                    if ((pr & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0) all.append('w');
                    else if ((pr & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0) all.append('W');
                    if ((pr & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) all.append('n');
                    if ((pr & BluetoothGattCharacteristic.PROPERTY_READ) != 0) all.append('r');
                }
                all.append("] ");
            }
            servicesInfo = all.toString().trim();
            log("服务列表：" + servicesInfo);

            BluetoothGattService s = g.getService(SVC);
            if (s == null && !candidates.isEmpty()) {
                emsRole = true;
                devType = 1;
                log("无 FF40 服务，按电击器（EMS）处理");
            }
            if (s != null) {
                chWrite = s.getCharacteristic(CH_WRITE);
                chNotify = s.getCharacteristic(CH_NOTIFY);
            }

            // 收集所有「可写 + 可通知」的服务，供手动切换
            candidates.clear();
            for (BluetoothGattService sv : g.getServices()) {
                BluetoothGattCharacteristic wt = null, nt = null;
                for (BluetoothGattCharacteristic c : sv.getCharacteristics()) {
                    int pr = c.getProperties();
                    if (wt == null && ((pr & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
                            || (pr & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0)) {
                        wt = c;
                    }
                    if (nt == null && (pr & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) {
                        nt = c;
                    }
                }
                if (wt != null && nt != null) candidates.add(sv);
            }
            log("可用通道 " + candidates.size() + " 个");

            if (chWrite == null || chNotify == null) {
                if (!candidates.isEmpty()) {
                    BluetoothGattService sv = candidates.get(Math.min(channelIndex, candidates.size() - 1));
                    for (BluetoothGattCharacteristic c : sv.getCharacteristics()) {
                        int pr = c.getProperties();
                        if (chWrite == null && ((pr & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
                                || (pr & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0)) chWrite = c;
                        if (chNotify == null && (pr & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) chNotify = c;
                    }
                    log("改用服务 " + shortUuid(sv.getUuid()) + " 写入 " + shortUuid(chWrite.getUuid())
                            + " 通知 " + shortUuid(chNotify.getUuid()));
                }
            }

            if (chWrite == null || chNotify == null) {
                log("没有可用的读写特征，设备可能不支持");
                return;
            }
            connected = true;
            retryLeft = 1;
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
            pushState();
            main.postDelayed(() -> {
                if (devType == 1 || emsRole) {
                    emsHandshake();                    // 官方连上 200ms 后发 35 14 01
                    main.postDelayed(() -> queryStatus(), 120);   // 电击器：查电量 + 通道
                } else {
                    queryInfo();                       // 杯子：查型号与马达
                }
            }, 300);
        }

        /** 官方连接握手（ele.js onConnected 里 200ms 后发 "351401"，不带校验） */
        @SuppressLint("MissingPermission")
        private void emsHandshake() {
            byte[] f = {0x35, 0x14, 0x01};
            writeBusy = false;
            if (!candidates.isEmpty()) writeTo(f, 0); else write(f);
            log("EMS 握手 35 14 01");
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            byte[] v = c.getValue();
            if (v == null || v.length == 0) return;
            lastNotify = hex(v);
            notifyCount++;
            if (notifyCount <= 3) log("通知 " + lastNotify);
            if (v.length < 3 || (v[0] & 0xFF) != 0x35) return;
            int cmd = v[1] & 0xFF;
            if (cmd == 0x10 && v.length >= 10) {
                modelId = v[2] & 0xFF;
                version = v[3] & 0xFF;
                modesA = v[4] & 0xFF;
                modesB = v[5] & 0xFF;
                modesC = v[6] & 0xFF;
                log("设备信息：型号 " + modelId + " 版本 " + version
                        + " 马达模式 A=" + modesA + " B=" + modesB + " C=" + modesC);
                pushState();
            } else if (cmd == 0x71 && v.length >= 4) {
                int sub = v[2] & 0xFF;
                if (sub == 3) {
                    battery = v[3] & 0xFF;
                    log("电量 " + battery + "%");
                    pushState();
                } else if (sub == 1 && v.length >= 8) {
                    chLink = v[3] & 0xFF;
                    chOpen = v[4] & 0xFF;
                    chStrength = ((v[5] & 0xFF) << 8) | (v[6] & 0xFF);
                    chMode = v[7] & 0xFF;
                    log("通道：接入 " + chLink + " 开关 " + chOpen + " 强度 " + chStrength + " 模式 " + chMode);
                    pushState();
                }
            } else if (cmd == 0x13 && v.length >= 5) {
                battery = v[3] & 0xFF;
                log("电量 " + battery + "%");
                pushState();
            }
        }
    };
}
