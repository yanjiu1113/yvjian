package dev.local.yujian.pet;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * 常驻前台服务：只为把进程留在后台，别让系统在切回语见之后把情趣版冻结/杀掉。
 *
 * BLE 连接本身由 MainActivity 里的 Coyote / YcyToy 持有，进程活着它们就活着；
 * 本服务不碰蓝牙，只挂一条「低优先级」通知。
 */
public class PetService extends Service {

    private static final String TAG = "YujianPet";
    private static final String CH_ID = "pet_alive";
    private static final int NOTIF_ID = 4101;

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel ch = new NotificationChannel(
                        CH_ID, "保持联动", NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                ch.enableVibration(false);
                if (nm != null) nm.createNotificationChannel(ch);
            }
            Intent it = new Intent(this, MainActivity.class);
            it.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getActivity(this, 0, it, flags);

            Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(this, CH_ID)
                    : new Notification.Builder(this);
            b.setContentTitle("情趣版在后台等着")
                    .setContentText("关掉这条通知就不会再响应语见的联动")
                    .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                    .setOngoing(true)
                    .setContentIntent(pi);
            startForeground(NOTIF_ID, b.build());
            Log.d(TAG, "PetService started");
        } catch (Exception e) {
            Log.w(TAG, "startForeground failed", e);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
