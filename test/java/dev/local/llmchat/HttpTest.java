package dev.local.llmchat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Desktop harness: exercises the real Http.java (same file that ships in the APK)
 * against the mock server. Run: java -cp "out;json.jar" dev.local.llmchat.HttpTest <baseUrl> <key>
 */
public final class HttpTest {

    private static int pass = 0;
    private static int fail = 0;

    private static void check(String name, boolean ok) {
        check(name, ok, "");
    }

    private static void check(String name, boolean ok, String extra) {
        if (ok) {
            pass++;
            System.out.println("PASS " + name);
        } else {
            fail++;
            System.out.println("FAIL " + name + (extra == null || extra.isEmpty() ? "" : ("  -> " + extra)));
        }
    }

    public static void main(String[] args) throws Exception {
        String base = args.length > 0 ? args[0] : "http://127.0.0.1:8791/v1";
        String key = args.length > 1 ? args[1] : "test-key";

        // ---- models
        try {
            JSONArray models = Http.fetchModels(base, key);
            check("fetchModels returns list", models.length() == 2, "len=" + models.length());
            check("fetchModels keeps id", models.getJSONObject(0).optString("id").equals("mock-stream"));
            check("fetchModels falls back to id for name", models.getJSONObject(0).optString("name").equals("mock-stream"));
            check("fetchModels keeps provided name", models.getJSONObject(1).optString("name").equals("NoStream Model"));
        } catch (Exception e) {
            check("fetchModels returns list", false, e.toString());
        }

        try {
            Http.fetchModels(base, "wrong-key");
            check("fetchModels surfaces 401", false, "no exception");
        } catch (Exception e) {
            check("fetchModels surfaces 401", e.getMessage().contains("401") && e.getMessage().contains("bad key"),
                    e.getMessage());
        }

        // ---- streaming
        final List<String> content = new ArrayList<>();
        final List<String> reasoning = new ArrayList<>();
        final CountDownLatch done = new CountDownLatch(1);
        final String[] error = new String[1];
        final boolean[] sawDone = new boolean[1];

        JSONObject body = new JSONObject();
        body.put("model", "mock-stream");
        body.put("stream", true);
        JSONArray msgs = new JSONArray();
        msgs.put(new JSONObject().put("role", "user").put("content", "hi"));
        body.put("messages", msgs);

        Http.streamChat(base, key, body, new Http.Job(), new Http.Listener() {
            public void onDelta(String c, String r) {
                if (!c.isEmpty()) content.add(c);
                if (!r.isEmpty()) reasoning.add(r);
            }

            public void onDone() {
                sawDone[0] = true;
                done.countDown();
            }

            public void onError(String message) {
                error[0] = message;
                done.countDown();
            }
        });

        check("stream completed", done.await(15, TimeUnit.SECONDS), "timeout");
        check("stream no error", error[0] == null, error[0]);
        check("stream saw onDone", sawDone[0]);
        check("stream content concatenated", String.join("", content).equals("你好，世界！"), "got " + String.join("|", content));
        check("stream reasoning captured", String.join("", reasoning).equals("先想一想。"), "got " + String.join("|", reasoning));

        // ---- non-streaming fallback (server ignores stream:true)
        final List<String> nsContent = new ArrayList<>();
        final CountDownLatch nsDone = new CountDownLatch(1);
        JSONObject nsBody = new JSONObject();
        nsBody.put("model", "mock-nostream");
        nsBody.put("stream", true);
        nsBody.put("messages", msgs);
        Http.streamChat(base, key, nsBody, new Http.Job(), new Http.Listener() {
            public void onDelta(String c, String r) {
                if (!c.isEmpty()) nsContent.add(c);
            }

            public void onDone() {
                nsDone.countDown();
            }

            public void onError(String message) {
                nsDone.countDown();
            }
        });
        check("non-stream fallback completes", nsDone.await(15, TimeUnit.SECONDS));
        check("non-stream fallback content", String.join("", nsContent).equals("非流式回答"), "got " + nsContent);

        // ---- http error surfaced
        final String[] err2 = new String[1];
        final CountDownLatch errDone = new CountDownLatch(1);
        JSONObject errBody = new JSONObject();
        errBody.put("model", "mock-401");
        errBody.put("stream", true);
        errBody.put("messages", msgs);
        Http.streamChat(base, key, errBody, new Http.Job(), new Http.Listener() {
            public void onDelta(String c, String r) {
            }

            public void onDone() {
                errDone.countDown();
            }

            public void onError(String message) {
                err2[0] = message;
                errDone.countDown();
            }
        });
        check("401 error reported", errDone.await(15, TimeUnit.SECONDS) && err2[0] != null && err2[0].contains("Authentication Fails"),
                String.valueOf(err2[0]));

        System.out.println("\n" + pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }
}
