package dev.local.llmchat;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Persistence: preferences (providers + encrypted keys) and one JSON file per conversation. */
public class Store {

    private final Context ctx;
    private final SharedPreferences prefs;

    public Store(Context c) {
        ctx = c.getApplicationContext();
        prefs = ctx.getSharedPreferences("llmchat", Context.MODE_PRIVATE);
    }

    public SharedPreferences prefs() {
        return prefs;
    }

    public JSONArray providers() {
        try {
            String s = prefs.getString("providers", "");
            if (s == null || s.isEmpty()) return new JSONArray();
            return new JSONArray(s);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    public void setProviders(JSONArray a) {
        prefs.edit().putString("providers", a.toString()).apply();
    }

    public String key(String providerId) {
        return Crypto.decrypt(prefs.getString("k_" + providerId, ""));
    }

    public void setKey(String providerId, String plain) {
        prefs.edit().putString("k_" + providerId, Crypto.encrypt(plain)).apply();
    }

    public boolean hasKey(String providerId) {
        String v = prefs.getString("k_" + providerId, "");
        return v != null && !v.isEmpty();
    }

    public void removeKey(String providerId) {
        prefs.edit().remove("k_" + providerId).apply();
    }

    /** Provider ids that still have a stored (encrypted) key. */
    public java.util.Set<String> keyIds() {
        java.util.Set<String> out = new java.util.HashSet<>();
        for (String k : prefs.getAll().keySet()) {
            if (k.startsWith("k_")) out.add(k.substring(2));
        }
        return out;
    }

    public String activeProvider() {
        return prefs.getString("activeProvider", "");
    }

    public void setActiveProvider(String id) {
        prefs.edit().putString("activeProvider", id).apply();
    }

    /** Avatars, sticker slots and search settings (everything except secrets). */
    public String meta() {
        String s = prefs.getString("meta", "");
        return s == null || s.isEmpty() ? "{}" : s;
    }

    public void setMeta(String json) {
        prefs.edit().putString("meta", json).apply();
    }

    private File dir() {
        File d = new File(ctx.getFilesDir(), "sessions");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private File file(String id) {
        return new File(dir(), id + ".json");
    }

    public String list() {
        JSONArray arr = new JSONArray();
        File[] files = dir().listFiles();
        if (files == null) return arr.toString();
        List<File> sorted = new ArrayList<>(Arrays.asList(files));
        sorted.sort((a, b) -> Long.compare(b.lastModified(), a.lastModified()));
        for (File f : sorted) {
            if (!f.getName().endsWith(".json")) continue;
            try {
                JSONObject o = new JSONObject(read(f));
                JSONObject item = new JSONObject();
                item.put("id", o.optString("id", f.getName().substring(0, f.getName().length() - 5)));
                item.put("title", o.optString("title", "新会话"));
                item.put("updatedAt", o.optLong("updatedAt", f.lastModified()));
                item.put("model", o.optString("model", ""));
                item.put("providerId", o.optString("providerId", ""));
                JSONArray msgs = o.optJSONArray("messages");
                item.put("count", msgs == null ? 0 : msgs.length());
                arr.put(item);
            } catch (Exception ignored) {
            }
        }
        return arr.toString();
    }

    public String get(String id) {
        File f = file(id);
        if (!f.exists()) return "";
        try {
            return read(f);
        } catch (Exception e) {
            return "";
        }
    }

    public void put(String json) throws Exception {
        JSONObject o = new JSONObject(json);
        String id = o.getString("id");
        if (id.isEmpty()) throw new Exception("missing id");
        File dst = file(id);
        File tmp = new File(dir(), id + ".json.tmp");
        write(tmp, json);
        if (!tmp.renameTo(dst)) {
            write(dst, json);
            tmp.delete();
        }
    }

    public void delete(String id) {
        file(id).delete();
    }

    private static String read(File f) throws Exception {
        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return new String(bo.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static void write(File f, String s) throws Exception {
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(s.getBytes(StandardCharsets.UTF_8));
            out.flush();
        }
    }
}
