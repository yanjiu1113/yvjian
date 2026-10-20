package dev.local.llmchat;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;

/**
 * 朗读：优先走 CloneTTS 的本地 HTTP API，失败自动回落系统 TTS。
 * 系统 TTS 支持重试（初始化失败过也能再次尝试）。
 */
public class Tts {

    public interface Sink {
        void emit(String state, String detail);
    }

    public static final String CLONE_PKG = "com.sipeter.clonetts";
    private static final String API_BASE = "http://127.0.0.1:8080";
    private static final int MAX_PART = 80;

    private final Context ctx;
    private final ExecutorService pool;
    private final Sink sink;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AudioManager audio;

    private TextToSpeech sysTts;
    private boolean sysReady = false;
    private boolean sysFailed = false;
    private String sysEngineName = "";

    private List<String> pendingParts = null;
    private int pendingGen = -1;

    private MediaPlayer player;
    private volatile int gen = 0;
    private volatile boolean speaking = false;

    private volatile long apiDownUntil = 0;
    private String voiceAlias = "";
    private float rate = 1.0f;
    private boolean preferApi = true;
    private String engineError = "";

    public Tts(Context ctx, ExecutorService pool, Sink sink) {
        this.ctx = ctx;
        this.pool = pool;
        this.sink = sink;
        this.audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
    }

    // ------------------------------------------------------------ 配置 / 状态

    public void configure(String alias, float speechRate, boolean useApi) {
        if (alias != null) voiceAlias = alias.trim();
        if (speechRate > 0.3f && speechRate < 3.0f) rate = speechRate;
        if (useApi && !preferApi) apiDownUntil = 0;
        preferApi = useApi;
        if (sysTts != null && sysReady) {
            try {
                sysTts.setSpeechRate(rate);
            } catch (Exception ignored) {
            }
        }
    }

    public String status() {
        JSONObject o = new JSONObject();
        List<String> engines = engineList();
        try {
            o.put("cloneTts", installed() || hasCloneEngine(engines));
            o.put("voice", voiceAlias);
            o.put("rate", rate);
            o.put("preferApi", preferApi);
            o.put("speaking", speaking);
            o.put("sysReady", sysReady);
            o.put("sysFailed", sysFailed);
            o.put("sysEngine", sysEngineName);
            JSONArray arr = new JSONArray();
            for (String e : engines) arr.put(e);
            o.put("engines", arr);
            o.put("engineCount", engines.size());
            o.put("engineError", engineError);
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    private boolean installed() {
        try {
            ctx.getPackageManager().getPackageInfo(CLONE_PKG, 0);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean hasCloneEngine(List<String> engines) {
        for (String e : engines) {
            if (e != null && e.toLowerCase().contains("clonetts")) return true;
        }
        return false;
    }

    /** 找到 CloneTTS 的引擎包名；找不到返回 null（用系统默认引擎）。 */
    private String cloneEngineName(List<String> engines) {
        for (String e : engines) {
            if (e == null) continue;
            String pkg = e.contains("|") ? e.substring(0, e.indexOf('|')) : e;
            if (e.toLowerCase().contains("clonetts")) return pkg;
        }
        return null;
    }

    @SuppressWarnings("deprecation")
    private List<String> engineList() {
        List<String> out = new ArrayList<>();
        TextToSpeech probe = null;
        try {
            probe = new TextToSpeech(ctx, status -> { });
            for (TextToSpeech.EngineInfo info : probe.getEngines()) {
                out.add(info.name + "|" + (info.label == null ? info.name : info.label));
            }
            engineError = "";
        } catch (Exception e) {
            engineError = e.getMessage() == null ? e.toString() : e.getMessage();
        } finally {
            try {
                if (probe != null) probe.shutdown();
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    // ------------------------------------------------------------ 朗读入口

    public void speak(String text) {
        List<String> parts = split(text);
        if (parts.isEmpty()) {
            sink.emit("error", "没有可朗读的文字");
            return;
        }
        stopInternal();
        final int myGen = ++gen;
        speaking = true;
        sink.emit("start", "");
        boolean apiUsable = preferApi && installed() && System.currentTimeMillis() > apiDownUntil;
        if (apiUsable) {
            runApi(parts, myGen, 0);
        } else {
            runSystem(parts, myGen);
        }
    }

    public void stop() {
        gen++;
        speaking = false;
        pendingParts = null;
        stopInternal();
        sink.emit("stop", "");
    }

    private void stopInternal() {
        try {
            if (player != null) {
                player.stop();
                player.release();
                player = null;
            }
        } catch (Exception ignored) {
        }
        try {
            if (sysTts != null) sysTts.stop();
        } catch (Exception ignored) {
        }
    }

    private void fail(String detail) {
        speaking = false;
        sink.emit("error", detail);
    }

    // ------------------------------------------------------------ 路线 A：本地 API

    private void runApi(List<String> parts, int myGen, int index) {
        if (myGen != gen) return;
        if (index >= parts.size()) {
            speaking = false;
            sink.emit("done", "api");
            return;
        }
        final String text = parts.get(index);
        pool.execute(() -> {
            File f;
            try {
                f = fetchToFile(text);
            } catch (Exception e) {
                f = null;
            }
            final File file = f;
            main.post(() -> {
                if (myGen != gen) {
                    if (file != null) file.delete();
                    return;
                }
                if (file == null) {
                    // 接口没开或出错：10 分钟内直接走系统 TTS，避免每次等超时
                    apiDownUntil = System.currentTimeMillis() + 10 * 60 * 1000L;
                    sink.emit("api-fallback", "");
                    runSystem(parts.subList(index, parts.size()), myGen);
                    return;
                }
                playFile(file, myGen, () -> {
                    file.delete();
                    runApi(parts, myGen, index + 1);
                });
            });
        });
    }

    private File fetchToFile(String text) throws Exception {
        String url = API_BASE + "/api/tts?text=" + URLEncoder.encode(text, "UTF-8");
        if (!voiceAlias.isEmpty()) url += "&voice=" + URLEncoder.encode(voiceAlias, "UTF-8");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(700);
        c.setReadTimeout(20000);
        c.setRequestProperty("User-Agent", "LLMChat");
        int code = c.getResponseCode();
        if (code != 200) {
            c.disconnect();
            throw new Exception("HTTP " + code);
        }
        byte[] data;
        try (InputStream in = c.getInputStream()) {
            data = readAll(in);
        }
        c.disconnect();
        if (data == null || data.length < 512) throw new Exception("音频为空");
        File dir = new File(ctx.getCacheDir(), "tts");
        if (!dir.exists()) dir.mkdirs();
        File f = new File(dir, "s" + System.currentTimeMillis() + "." + sniff(data));
        try (FileOutputStream os = new FileOutputStream(f)) {
            os.write(data);
        }
        return f;
    }

    private static String sniff(byte[] d) {
        if (d.length > 12 && d[0] == 'R' && d[1] == 'I' && d[2] == 'F' && d[3] == 'F') return "wav";
        if (d.length > 4 && d[0] == 'O' && d[1] == 'g' && d[2] == 'g' && d[3] == 'S') return "ogg";
        if (d.length > 4 && d[0] == 'f' && d[1] == 'L' && d[2] == 'a' && d[3] == 'C') return "flac";
        if (d.length > 3 && d[0] == 'I' && d[1] == 'D' && d[2] == '3') return "mp3";
        return "wav";
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toByteArray();
    }

    private void playFile(File file, int myGen, Runnable onDone) {
        try {
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            player.setDataSource(file.getAbsolutePath());
            player.setOnCompletionListener(mp -> {
                releasePlayer(mp);
                onDone.run();
            });
            player.setOnErrorListener((mp, what, extra) -> {
                releasePlayer(mp);
                onDone.run();
                return true;
            });
            player.prepare();
            player.start();
        } catch (Exception e) {
            if (player != null) releasePlayer(player);
            onDone.run();
        }
    }

    private void releasePlayer(MediaPlayer mp) {
        try {
            mp.release();
        } catch (Exception ignored) {
        }
        if (player == mp) player = null;
    }

    // ------------------------------------------------------------ 路线 B：系统 TTS

    /** 系统 TTS：允许重试，每次调用都会尝试重新初始化。 */
    private void runSystem(List<String> parts, int myGen) {
        if (myGen != gen) return;
        pendingParts = new ArrayList<>(parts);
        pendingGen = myGen;

        if (sysTts != null && sysReady) {
            queueSystem(pendingParts, myGen);
            return;
        }
        createSystemTts();
    }

    private void createSystemTts() {
        if (sysTts != null) {
            try {
                sysTts.shutdown();
            } catch (Exception ignored) {
            }
            sysTts = null;
        }
        sysReady = false;
        sysFailed = false;

        List<String> engines = engineList();
        String clonePkg = cloneEngineName(engines);
        sysEngineName = clonePkg == null ? "(系统默认)" : clonePkg;

        try {
            sysTts = new TextToSpeech(ctx, status -> onSysInit(status), clonePkg);
        } catch (Exception e) {
            sysFailed = true;
            fail("系统 TTS 初始化异常：" + e.getMessage());
        }
    }

    private void onSysInit(int status) {
        if (status == TextToSpeech.SUCCESS && sysTts != null) {
            sysReady = true;
            sysFailed = false;
            try {
                int r = sysTts.setLanguage(Locale.SIMPLIFIED_CHINESE);
                if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                    sink.emit("warn", "引擎不支持简体中文，可能读不出来");
                }
                sysTts.setSpeechRate(rate);
                sysTts.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build());
            } catch (Exception ignored) {
            }
            sysTts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String id) {
                }

                @Override
                public void onDone(String id) {
                    if (id != null && id.endsWith("#last")) {
                        speaking = false;
                        sink.emit("done", "system");
                    }
                }

                @Override
                public void onError(String id) {
                    fail("引擎合成失败（音色可能未配置）");
                }
            });
            if (pendingParts != null && pendingGen == gen) {
                queueSystem(pendingParts, pendingGen);
            }
        } else {
            boolean usedExplicit = sysEngineName != null && !sysEngineName.startsWith("(");
            if (usedExplicit) {
                sysEngineName = "(系统默认)";
                try {
                    if (sysTts != null) sysTts.shutdown();
                } catch (Exception ignored) {
                }
                sysTts = new TextToSpeech(ctx, s2 -> onSysInit(s2), null);
                return;
            }
            sysFailed = true;
            int n = engineList().size();
            fail(n == 0
                    ? "手机里没有可用的 TTS 引擎"
                    : "TTS 引擎初始化失败（检测到 " + n + " 个引擎）");
        }
    }

    private void queueSystem(List<String> parts, int myGen) {
        if (myGen != gen || sysTts == null || !sysReady) return;
        try {
            AudioManager am = audio;
            if (am != null) {
                am.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
            }
        } catch (Exception ignored) {
        }
        try {
            sysTts.setSpeechRate(rate);
        } catch (Exception ignored) {
        }
        for (int i = 0; i < parts.size(); i++) {
            String id = "g" + myGen + "_" + i + (i == parts.size() - 1 ? "#last" : "");
            int mode = i == 0 ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
            int r = sysTts.speak(parts.get(i), mode, null, id);
            if (r == TextToSpeech.ERROR) {
                fail("引擎拒绝了这段文本（可能没有可用音色）");
                return;
            }
        }
    }

    // ------------------------------------------------------------ 断句

    public static List<String> split(String text) {
        List<String> out = new ArrayList<>();
        if (text == null) return out;
        String s = text;
        s = s.replaceAll("(?s)```.*?```", " 代码略 ");
        s = s.replaceAll("\\[\\[emo:[^\\]]*\\]\\]", " ");
        s = s.replaceAll("(?m)^\\s*[#>\\-\\*]+\\s*", "");
        s = s.replaceAll("\\[([^\\]]{1,40})\\]\\([^)]*\\)", "$1");
        s = s.replaceAll("[`*_~|]", "");
        StringBuilder cur = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            cur.append(ch);
            boolean hard = ch == '。' || ch == '！' || ch == '？' || ch == '!' || ch == '?'
                    || ch == '；' || ch == ';' || ch == '\n';
            if (hard) {
                flush(out, cur);
            } else if (cur.length() >= MAX_PART) {
                flush(out, cur);
            }
        }
        flush(out, cur);
        return out;
    }

    private static void flush(List<String> out, StringBuilder cur) {
        String t = cur.toString().trim();
        cur.setLength(0);
        if (t.isEmpty()) return;
        if (t.replaceAll("[\\p{Punct}\\s，。！？；：、…—·「」『』（）()《》〈〉\"'“”‘’]", "").isEmpty()) return;
        out.add(t);
    }
}
