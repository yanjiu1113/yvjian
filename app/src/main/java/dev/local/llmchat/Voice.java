package dev.local.llmchat;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.Arrays;
import java.util.Comparator;
import java.util.concurrent.ExecutorService;

/**
 * 语音条：把一段文字用 CloneTTS 的本地 API 合成为音频文件，存到 filesDir/voices/<消息id>.*，
 * 之后点一下就能播。文件按消息 id 命名，所以重开应用、翻历史都还能播。
 *
 * 合成失败（没装 CloneTTS / 接口没开）时把错误回给页面，页面再把这条气泡标成「点一下用系统朗读」。
 */
public class Voice {

    public interface Sink {
        void emit(String method, JSONObject payload);
    }

    private static final String API_BASE = "http://127.0.0.1:8080";
    private static final int MAX_FILES = 240;

    private final Context ctx;
    private final ExecutorService pool;
    private final Sink sink;
    private final Handler main = new Handler(Looper.getMainLooper());

    private MediaPlayer player;
    private String playingId = "";

    public Voice(Context ctx, ExecutorService pool, Sink sink) {
        this.ctx = ctx;
        this.pool = pool;
        this.sink = sink;
    }

    // ------------------------------------------------------------ 合成

    public void synth(final String id, final String text, final String voice, final float rate) {
        if (id == null || id.isEmpty()) return;
        final String body = text == null ? "" : text.trim();
        if (body.isEmpty()) {
            fail(id, "文字是空的");
            return;
        }
        pool.execute(() -> {
            // 本地语音服务经常要预热（第一次请求可能要几秒才起来），单次失败不能说明它没开。
            // 这里自己做三次重试，只有“端口根本连不上”才向上层报告 needApp。
            File f = null;
            String err = "";
            for (int attempt = 0; attempt < 3; attempt++) {
                try {
                    f = fetch(id, body, voice, rate);
                    err = "";
                    break;
                } catch (Exception e) {
                    err = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                    boolean retryable = err.contains("连不上语音服务") || err.contains("响应超时");
                    if (attempt < 2 && retryable) {
                        try {
                            Thread.sleep(attempt == 0 ? 700 : 1800);
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            break;
                        }
                        continue;
                    }
                    break;
                }
            }
            final File file = f;
            final String e2 = err;
            main.post(() -> {
                if (file == null) {
                    boolean noApp = e2 != null && e2.contains("连不上语音服务");
                    fail(id, e2 == null || e2.isEmpty() ? "合成失败" : e2, noApp);
                    return;
                }
                int ms = durationOf(file);
                JSONObject o = new JSONObject();
                try {
                    o.put("id", id);
                    o.put("ok", true);
                    o.put("ms", ms);
                    o.put("kb", Math.max(1, file.length() / 1024));
                } catch (Exception ignored) {
                }
                sink.emit("onVoice", o);
                trim();
            });
        });
    }

    private File fetch(String id, String text, String voice, float rate) throws Exception {
        String url = API_BASE + "/api/tts?text=" + URLEncoder.encode(text, "UTF-8");
        if (voice != null && !voice.trim().isEmpty()) {
            url += "&voice=" + URLEncoder.encode(voice.trim(), "UTF-8");
        }
        if (rate > 0.3f && rate < 3.0f && Math.abs(rate - 1.0f) > 0.01f) {
            url += "&rate=" + rate;
        }
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(2500);
        c.setReadTimeout(25000);
        c.setRequestProperty("User-Agent", "LLMChat");
        int code;
        try {
            code = c.getResponseCode();
        } catch (java.net.ConnectException | java.net.NoRouteToHostException e) {
            c.disconnect();
            throw new Exception("连不上语音服务（CloneTTS 没开？）");
        } catch (java.net.SocketTimeoutException e) {
            c.disconnect();
            throw new Exception("语音服务响应超时（可能正在加载模型）");
        } catch (Exception e) {
            c.disconnect();
            throw new Exception("连不上语音服务（CloneTTS 没开？）");
        }
        if (code != 200) {
            c.disconnect();
            throw new Exception("语音服务返回 HTTP " + code);
        }
        byte[] data;
        try (InputStream in = c.getInputStream()) {
            data = readAll(in);
        } catch (java.net.SocketTimeoutException te) {
            c.disconnect();
            throw new Exception("语音服务响应超时（可能正在加载模型）");
        }
        c.disconnect();
        if (data == null || data.length < 512) throw new Exception("音频是空的");

        File dir = new File(ctx.getFilesDir(), "voices");
        if (!dir.exists()) dir.mkdirs();
        File f = new File(dir, safe(id) + "." + sniff(data));
        try (FileOutputStream os = new FileOutputStream(f)) {
            os.write(data);
        }
        return f;
    }

    private void fail(String id, String why) {
        fail(id, why, false);
    }

    private void fail(String id, String why, boolean needApp) {
        JSONObject o = new JSONObject();
        try {
            o.put("id", id);
            o.put("ok", false);
            o.put("error", why);
            if (needApp) o.put("needApp", true);
        } catch (Exception ignored) {
        }
        sink.emit("onVoice", o);
    }

    private static String safe(String id) {
        return id.replaceAll("[^A-Za-z0-9_-]", "_");
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

    private int durationOf(File f) {
        MediaPlayer mp = new MediaPlayer();
        try {
            mp.setDataSource(f.getAbsolutePath());
            mp.prepare();
            return mp.getDuration();
        } catch (Exception e) {
            return 0;
        } finally {
            try {
                mp.release();
            } catch (Exception ignored) {
            }
        }
    }

    /** 只留最近 MAX_FILES 个，别把老音频堆成几个 G。 */
    private void trim() {
        try {
            File dir = new File(ctx.getFilesDir(), "voices");
            File[] all = dir.listFiles();
            if (all == null || all.length <= MAX_FILES) return;
            Arrays.sort(all, Comparator.comparingLong(File::lastModified));
            for (int i = 0; i < all.length - MAX_FILES; i++) all[i].delete();
        } catch (Exception ignored) {
        }
    }

    // ------------------------------------------------------------ 播放

    public void play(final String id) {
        main.post(() -> {
            if (player != null && playingId.equals(id)) {
                stop();
                return;
            }
            stop();
            File f = locate(id);
            if (f == null) {
                JSONObject o = new JSONObject();
                try {
                    o.put("id", id);
                    o.put("state", "missing");
                } catch (Exception ignored) {
                }
                sink.emit("onVoicePlay", o);
                return;
            }
            try {
                MediaPlayer mp = new MediaPlayer();
                mp.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build());
                mp.setDataSource(f.getAbsolutePath());
                mp.setOnCompletionListener(x -> {
                    release(x);
                    emitPlay(id, "end");
                });
                mp.setOnErrorListener((x, what, extra) -> {
                    release(x);
                    emitPlay(id, "end");
                    return true;
                });
                mp.prepare();
                mp.start();
                player = mp;
                playingId = id;
                emitPlay(id, "start");
            } catch (Exception e) {
                stop();
                emitPlay(id, "end");
            }
        });
    }

    public void stop() {
        main.post(() -> {
            String was = playingId;
            playingId = "";
            if (player != null) release(player);
            if (!was.isEmpty()) emitPlay(was, "end");
        });
    }

    private void release(MediaPlayer mp) {
        try {
            mp.release();
        } catch (Exception ignored) {
        }
        if (player == mp) player = null;
    }

    private void emitPlay(String id, String state) {
        JSONObject o = new JSONObject();
        try {
            o.put("id", id);
            o.put("state", state);
        } catch (Exception ignored) {
        }
        sink.emit("onVoicePlay", o);
    }

    private File locate(String id) {
        try {
            File dir = new File(ctx.getFilesDir(), "voices");
            String base = safe(id) + ".";
            File[] all = dir.listFiles();
            if (all == null) return null;
            for (File f : all) if (f.getName().startsWith(base)) return f;
        } catch (Exception ignored) {
        }
        return null;
    }

    public void remove(String id) {
        File f = locate(id);
        if (f != null) f.delete();
    }
}
