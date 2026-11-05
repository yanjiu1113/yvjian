package dev.local.yujian.pet;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 接收语见聊天端的显式广播。
 *
 * 约定（发送方 dev.local.llmchat 用 Intent.setPackage("dev.local.yujian.pet")）：
 *   action  : dev.local.yujian.PET_EVENT
 *   extra   : type  = turn.start | turn.thinking | turn.chunk | turn.done | turn.error | sticker | tts.speak
 *   extra   : value = 情绪分类名（turn.done / sticker 时有效）
 *   extra   : text  = 回复全文或片段（可选）
 */
public class PetReceiver extends BroadcastReceiver {

    private static final String TAG = "YujianPet";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String type = intent.getStringExtra("type");
        String value = intent.getStringExtra("value");
        String text = intent.getStringExtra("text");
        Log.d(TAG, "receive type=" + type + " value=" + value);

        MainActivity act = MainActivity.current();
        if (act != null) {
            act.dispatch(type, value, text);
        }
    }
}
