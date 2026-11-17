package dev.local.llmchat;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Locale;

/**
 * 手机硬件能力：拍照、指南针、水平仪。
 * 模型通过工具调用（take_photo / read_compass / read_level）触发，
 * 结果统一用 onDevice 事件回传页面，页面再决定怎么塞回对话。
 */
class Devices {

    private static final String TAG = "LLMChat";
    static final int RC_PHOTO = 1007;

    private final Activity act;
    private final Bridge bridge;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final SensorManager sensors;

    private volatile Uri photoUri;
    private volatile String photoTag = "";

    Devices(Activity a, Bridge b) {
        this.act = a;
        this.bridge = b;
        this.sensors = (SensorManager) a.getSystemService(Activity.SENSOR_SERVICE);
    }

    // ---------------------------------------------------------------- 拍照

    void takePhoto(String tag) {
        takePhoto(tag, "back");
    }

    /**
     * @param facing "back"（后置，默认）或 "front"（自拍）。
     *               系统相机 App 的 front/back 只能尽量请求：不同厂商认不同的 extra，
     *               这里把几个常见写法一起塞进去，认不出来的相机 App 会忽略、用上次的镜头。
     */
    void takePhoto(String tag, String facing) {
        try {
            String name = "shot_" + System.currentTimeMillis() + ".jpg";
            photoUri = Uri.parse("content://" + PhotoProvider.AUTHORITY + "/" + name);
            photoTag = tag == null ? "" : tag;
            boolean front = "front".equalsIgnoreCase(facing);

            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, photoUri);
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            // 某些机型需要 ClipData 才肯把写权限带过去
            i.setClipData(android.content.ClipData.newRawUri("photo", photoUri));
            // 前置/后置：各厂商的私有 extra 都试一遍
            i.putExtra("android.intent.extras.CAMERA_FACING", front ? 1 : 0);
            i.putExtra("android.intent.extras.LENS_FACING_FRONT", front ? 1 : 0);
            i.putExtra("android.intent.extra.USE_FRONT_CAMERA", front);
            i.putExtra("android.intent.extras.CAMERA_FACING_FRONT", front);
            i.putExtra("camera_facing", front ? 1 : 0);
            if (i.resolveActivity(act.getPackageManager()) == null) {
                fail("photo", "这台手机没有可用的相机 App");
                return;
            }
            act.startActivityForResult(i, RC_PHOTO);
        } catch (Exception e) {
            fail("photo", "打不开相机：" + msgOf(e));
        }
    }

    void onActivityResult(int req, int resCode, Intent data) {
        if (req != RC_PHOTO) return;
        final Uri uri = photoUri;
        if (resCode != Activity.RESULT_OK || uri == null) {
            fail("photo", "取消了拍照");
            return;
        }
        new Thread(() -> handlePhoto(uri)).start();
    }

    private void handlePhoto(Uri uri) {
        try {
            final int max = 1280;
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            try (InputStream in = act.getContentResolver().openInputStream(uri)) {
                BitmapFactory.decodeStream(in, null, bounds);
            }
            if (bounds.outWidth <= 0) {
                fail("photo", "没有拍到照片");
                return;
            }
            int sample = 1;
            while (bounds.outWidth / sample > max * 2 || bounds.outHeight / sample > max * 2) sample *= 2;

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bmp;
            try (InputStream in = act.getContentResolver().openInputStream(uri)) {
                bmp = BitmapFactory.decodeStream(in, null, opts);
            }
            if (bmp == null) {
                fail("photo", "照片读不出来");
                return;
            }
            int w = bmp.getWidth();
            int h = bmp.getHeight();
            if (w > max || h > max) {
                float s = max / (float) Math.max(w, h);
                Bitmap scaled = Bitmap.createScaledBitmap(bmp, Math.max(1, (int) (w * s)),
                        Math.max(1, (int) (h * s)), true);
                if (scaled != bmp) bmp.recycle();
                bmp = scaled;
            }
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 84, bo);
            byte[] bytes = bo.toByteArray();
            JSONObject p = new JSONObject();
            p.put("kind", "photo");
            p.put("tag", photoTag);
            p.put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP));
            p.put("w", bmp.getWidth());
            p.put("h", bmp.getHeight());
            p.put("kb", bytes.length / 1024);
            bmp.recycle();
            bridge.emitDevice(p);
            // 照片已经读进内存，缓存里的原图可以删了
            try {
                act.getContentResolver().delete(uri, null, null);
            } catch (Exception ignored) {
            }
        } catch (Exception e) {
            fail("photo", "照片处理失败：" + msgOf(e));
        }
    }

    // ---------------------------------------------------------------- 指南针

    void readCompass() {
        final Sensor rot = sensors == null ? null
                : sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        if (rot == null) {
            fail("compass", "这台手机没有方向传感器");
            return;
        }
        final float[] v = new float[3];
        final float[] r = new float[9];
        final float[] o = new float[3];
        final boolean[] done = {false};

        SensorEventListener l = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent e) {
                if (done[0]) return;
                done[0] = true;
                try {
                    v[0] = e.values[0];
                    v[1] = e.values[1];
                    v[2] = e.values[2];
                    SensorManager.getRotationMatrixFromVector(r, v);
                    SensorManager.getOrientation(r, o);
                    double az = Math.toDegrees(o[0]);
                    if (az < 0) az += 360;
                    JSONObject p = new JSONObject();
                    p.put("kind", "compass");
                    p.put("azimuth", round1(az));
                    p.put("dir", dirName(az));
                    p.put("pitch", round1(Math.toDegrees(-o[1])));
                    p.put("roll", round1(Math.toDegrees(o[2])));
                    bridge.emitDevice(p);
                } catch (Exception ex) {
                    fail("compass", "读数失败：" + msgOf(ex));
                } finally {
                    sensors.unregisterListener(this);
                }
            }

            @Override
            public void onAccuracyChanged(Sensor s, int accuracy) {
            }
        };
        sensors.registerListener(l, rot, SensorManager.SENSOR_DELAY_UI);
        main.postDelayed(() -> {
            if (!done[0]) {
                done[0] = true;
                try {
                    sensors.unregisterListener(l);
                } catch (Exception ignored) {
                }
                fail("compass", "等不到方向数据，把手机拿起来晃一下再试");
            }
        }, 1500);
    }

    // ---------------------------------------------------------------- 水平仪

    void readLevel() {
        final Sensor acc = sensors == null ? null
                : sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        if (acc == null) {
            fail("level", "这台手机没有加速度传感器");
            return;
        }
        final boolean[] done = {false};
        SensorEventListener l = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent e) {
                if (done[0]) return;
                done[0] = true;
                try {
                    float x = e.values[0], y = e.values[1], z = e.values[2];
                    double pitch = Math.toDegrees(Math.atan2(-x, Math.sqrt(y * y + z * z)));
                    double roll = Math.toDegrees(Math.atan2(y, Math.sqrt(x * x + z * z)));
                    double tilt = Math.max(Math.abs(pitch), Math.abs(roll));
                    JSONObject p = new JSONObject();
                    p.put("kind", "level");
                    p.put("pitch", round1(pitch));
                    p.put("roll", round1(roll));
                    p.put("tilt", round1(tilt));
                    p.put("flat", tilt < 1.0);
                    bridge.emitDevice(p);
                } catch (Exception ex) {
                    fail("level", "读数失败：" + msgOf(ex));
                } finally {
                    sensors.unregisterListener(this);
                }
            }

            @Override
            public void onAccuracyChanged(Sensor s, int accuracy) {
            }
        };
        sensors.registerListener(l, acc, SensorManager.SENSOR_DELAY_UI);
        main.postDelayed(() -> {
            if (!done[0]) {
                done[0] = true;
                try {
                    sensors.unregisterListener(l);
                } catch (Exception ignored) {
                }
                fail("level", "等不到重力数据，把手机放稳再试");
            }
        }, 1500);
    }

    // ---------------------------------------------------------------- 工具

    private void fail(String kind, String reason) {
        try {
            JSONObject p = new JSONObject();
            p.put("kind", kind);
            p.put("error", reason);
            bridge.emitDevice(p);
        } catch (Exception e) {
            Log.w(TAG, "emit device error failed", e);
        }
    }

    private static double round1(double v) {
        return Math.round(v * 10.0) / 10.0;
    }

    private static String msgOf(Exception e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }

    /** 十六方位，中文。 */
    private static String dirName(double az) {
        String[] names = {"北", "北东北", "东北", "东东北", "东", "东东南", "东南", "南东南",
                "南", "南西南", "西南", "西西南", "西", "西西北", "西北", "北西北"};
        int idx = (int) Math.floor(((az + 11.25) % 360) / 22.5);
        return names[Math.max(0, Math.min(15, idx))];
    }

    static String describe(JSONObject p) {
        String kind = p.optString("kind", "");
        if (p.has("error")) return "失败：" + p.optString("error");
        if ("photo".equals(kind)) {
            return String.format(Locale.US, "已拍照 %dx%d（%d KB）", p.optInt("w"), p.optInt("h"), p.optInt("kb"));
        }
        if ("compass".equals(kind)) {
            return String.format(Locale.US, "朝向 %s（%.1f°），俯仰 %.1f°，横滚 %.1f°",
                    p.optString("dir"), p.optDouble("azimuth"), p.optDouble("pitch"), p.optDouble("roll"));
        }
        if ("level".equals(kind)) {
            return String.format(Locale.US, "倾斜 %.1f°（俯仰 %.1f°，横滚 %.1f°）%s",
                    p.optDouble("tilt"), p.optDouble("pitch"), p.optDouble("roll"),
                    p.optBoolean("flat") ? "，接近水平" : "");
        }
        return "完成";
    }
}
