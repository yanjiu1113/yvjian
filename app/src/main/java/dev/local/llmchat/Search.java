package dev.local.llmchat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;

/**
 * Web search backends.
 *
 * Key-free engines (DuckDuckGo / Bing / Baidu) scrape the public result pages,
 * so the app works without registering anything. Tavily / Serper / Brave are optional
 * for people who want cleaner snippets and higher rate limits.
 */
public final class Search {

    public static final String ENGINE_DDG = "duckduckgo";
    public static final String ENGINE_BING = "bing";
    public static final String ENGINE_BAIDU = "baidu";
    public static final String ENGINE_TAVILY = "tavily";
    public static final String ENGINE_SERPER = "serper";
    public static final String ENGINE_BRAVE = "brave";

    public static final String DEFAULT_ENGINE = ENGINE_DDG;

    private static final int MAX_RESULTS = 5;
    // Desktop UA: the scraped result pages keep their classic markup, mobile pages differ per engine.
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
                    "Chrome/124.0.0.0 Safari/537.36";

    private static final Pattern TAG_BLOCK = Pattern.compile("<[^>]+>");
    private static final Pattern SPACES = Pattern.compile("[ \\t\\x0B\\f\\r]+");
    private static final Pattern NEWLINES = Pattern.compile("\\n{2,}");

    public static final class Hit {
        public String title = "";
        public String url = "";
        public String snippet = "";
        public String date = "";
    }

    private Search() {
    }

    /** Engines that work without any key at all. */
    public static boolean needsKey(String engine) {
        return ENGINE_TAVILY.equals(engine) || ENGINE_SERPER.equals(engine) || ENGINE_BRAVE.equals(engine);
    }

    public static String displayName(String engine) {
        if (ENGINE_BING.equals(engine)) return "Bing";
        if (ENGINE_BAIDU.equals(engine)) return "百度";
        if (ENGINE_TAVILY.equals(engine)) return "Tavily";
        if (ENGINE_SERPER.equals(engine)) return "Serper";
        if (ENGINE_BRAVE.equals(engine)) return "Brave";
        return "DuckDuckGo";
    }

    public static String run(String engine, String apiKey, String query) throws Exception {
        if (query == null || query.trim().isEmpty()) return "";
        String q = query.trim();
        List<Hit> hits;

        if (ENGINE_BING.equals(engine)) {
            hits = bing(q);
        } else if (ENGINE_BAIDU.equals(engine)) {
            hits = baidu(q);
        } else if (ENGINE_DDG.equals(engine)) {
            hits = duckduckgo(q);
        } else if (ENGINE_SERPER.equals(engine)) {
            hits = serper(apiKey, q);
        } else if (ENGINE_BRAVE.equals(engine)) {
            hits = brave(apiKey, q);
        } else if (ENGINE_TAVILY.equals(engine)) {
            hits = tavily(apiKey, q);
        } else {
            hits = duckduckgo(q);
        }
        return format(hits);
    }

    // ---------------------------------------------------------------- key-free engines

    private static List<Hit> duckduckgo(String query) throws Exception {
        String html = fetch("https://html.duckduckgo.com/html/?q=" + enc(query));
        List<Hit> hits = parseDdg(html);
        if (hits.isEmpty()) {
            // lite endpoint has a different (simpler) layout
            String lite = fetch("https://lite.duckduckgo.com/lite/?q=" + enc(query));
            hits = parseDdgLite(lite);
        }
        return hits;
    }

    private static List<Hit> bing(String query) throws Exception {
        String html = fetch("https://www.bing.com/search?q=" + enc(query) + "&setlang=zh-hans&count=10");
        return parseBing(html);
    }

    private static List<Hit> baidu(String query) throws Exception {
        String html = fetch("https://www.baidu.com/s?wd=" + enc(query) + "&rn=10&ie=utf-8");
        return parseBaidu(html);
    }

    // ---------------------------------------------------------------- news verticals

    /**
     * News-first search. Generic web results for "北京 新闻" are dominated by encyclopedia and
     * portal home pages; news feeds return dated articles instead. RSS endpoints come first
     * because their markup is stable, then the HTML verticals.
     */
    public static String news(String query) throws Exception {
        return news(query, null, null, null);
    }

    public static String news(String query, String engine, String apiKey, List<String> trace) {
        if (query == null || query.trim().isEmpty()) return "";
        String q = query.trim();

        // 配了付费搜索 API 就先用 API（结构化、稳定），没有才去抓页面
        if (engine != null && needsKey(engine) && apiKey != null && !apiKey.isEmpty()) {
            try {
                List<Hit> api = ENGINE_TAVILY.equals(engine) ? tavilyNews(apiKey, q) : runApi(engine, apiKey, q);
                if (trace != null) trace.add("API " + engine + ": " + api.size() + " 条");
                if (!api.isEmpty()) return format(api);
            } catch (Exception e) {
                if (trace != null) trace.add("API " + engine + " 失败: " + e.getMessage());
            }
        }

        List<Hit> hits = attemptRss("百度RSS", trace,
                "https://news.baidu.com/ns?tn=newsrss&sr=0&cl=2&rn=20&ct=0&word=" + encSafe(q));
        if (hits.isEmpty()) {
            hits = attemptRss("BingRSS", trace,
                    "https://www.bing.com/news/search?q=" + encSafe(q) + "&format=rss&setmkt=zh-CN&setlang=zh-hans");
        }
        if (hits.isEmpty()) {
            hits = attemptHtml("百度新闻", trace,
                    "https://www.baidu.com/s?tn=news&rtt=1&bsst=1&cl=2&wd=" + encSafe(q), Search::parseBaiduNews);
        }
        if (hits.isEmpty()) {
            hits = attemptHtml("Bing新闻", trace,
                    "https://www.bing.com/news/search?q=" + encSafe(q) + "&setmkt=zh-CN&setlang=zh-hans",
                    Search::parseBingNews);
        }
        if (hits.isEmpty()) {
            hits = attemptHtml("搜狗新闻", trace,
                    "https://news.sogou.com/news?query=" + encSafe(q) + "&sort=0&mode=1", Search::parseSogouNews);
        }
        return format(hits);
    }

    private static List<Hit> runApi(String engine, String apiKey, String q) throws Exception {
        if (ENGINE_SERPER.equals(engine)) return serper(apiKey, q);
        if (ENGINE_BRAVE.equals(engine)) return brave(apiKey, q);
        return tavily(apiKey, q);
    }

    /** Tavily with topic=news: dated articles instead of encyclopedia pages. */
    private static List<Hit> tavilyNews(String apiKey, String query) throws Exception {
        JSONObject body = new JSONObject();
        body.put("api_key", apiKey);
        body.put("query", query);
        body.put("topic", "news");
        body.put("days", 7);
        body.put("max_results", MAX_RESULTS);
        body.put("search_depth", "basic");
        body.put("include_answer", false);
        return parseTavily(request("https://api.tavily.com/search", "POST", null, body.toString()));
    }
    private interface Parser {
        List<Hit> parse(String body) throws Exception;
    }

    private static List<Hit> attemptRss(String name, List<String> trace, String url) {
        return attemptHtml(name, trace, url, Search::parseRss);
    }

    private static List<Hit> attemptHtml(String name, List<String> trace, String url, Parser parser) {
        long t0 = System.currentTimeMillis();
        try {
            String body = fetch(url);
            List<Hit> hits = parser.parse(body);
            long ms = System.currentTimeMillis() - t0;
            if (trace != null) {
                trace.add(name + ": " + (body == null ? 0 : body.length()) + "B, " + hits.size() + " 条, " + ms + "ms");
                if (hits.isEmpty() && body != null && !body.isEmpty()) {
                    trace.add(name + " 页面开头: " + clip(stripHtml(body).replace("\n", " "), 120));
                }
            }
            return hits;
        } catch (Exception e) {
            if (trace != null) trace.add(name + ": " + (e.getMessage() == null ? e.toString() : e.getMessage()));
            return new ArrayList<>();
        }
    }

    /** RSS 2.0 / RDF items, used by the Baidu and Bing news feeds. */
    static List<Hit> parseRss(String xml) {
        List<Hit> out = new ArrayList<>();
        if (xml == null) return out;
        String[] items = xml.split("<item[ >]");
        for (String it : items) {
            if (out.size() >= MAX_RESULTS) break;
            String title = unwrapCdata(tag(it, "title"));
            String link = unwrapCdata(tag(it, "link"));
            if (title.isEmpty() || link.isEmpty()) continue;
            Hit h = new Hit();
            h.title = stripHtml(title);
            h.url = cleanUrl(link.trim());
            h.snippet = stripHtml(unwrapCdata(tag(it, "description")));
            h.date = normalizeDate(unwrapCdata(tag(it, "pubDate")));
            if (h.url.isEmpty() || h.title.isEmpty()) continue;
            out.add(h);
        }
        return out;
    }

    private static String tag(String block, String name) {
        Matcher m = Pattern.compile("<" + name + "[^>]*>(.*?)</" + name + ">", Pattern.DOTALL).matcher(block);
        return m.find() ? m.group(1).trim() : "";
    }

    private static String unwrapCdata(String s) {
        if (s == null) return "";
        String t = s.trim();
        if (t.startsWith("<![CDATA[")) t = t.substring(9);
        if (t.endsWith("]]>")) t = t.substring(0, t.length() - 3);
        return t.trim();
    }

    private static String normalizeDate(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        String t = raw.trim();
        try {
            java.text.SimpleDateFormat rfc = new java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss Z", java.util.Locale.US);
            java.text.SimpleDateFormat out = new java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.US);
            return out.format(rfc.parse(t));
        } catch (Exception ignored) {
        }
        return clip(t, 24);
    }

    private static String encSafe(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (Exception e) {
            return s;
        }
    }


    private static final Pattern DATE_HINT = Pattern.compile(
            "(\\d{4}[-年]\\d{1,2}[-月]\\d{1,2}日?|\\d{1,2}月\\d{1,2}日|\\d{1,2}\\s*小时前|\\d{1,2}\\s*分钟前|昨天|今天|刚刚)");

    private static String dateOf(String text) {
        if (text == null) return "";
        Matcher m = DATE_HINT.matcher(text);
        return m.find() ? m.group(1).replace(" ", "") : "";
    }

    static List<Hit> parseBaiduNews(String html) {
        List<Hit> out = new ArrayList<>();
        if (html == null) return out;
        String[] blocks = html.split("<div class=\"result-op c-container|<div class=\"result c-container");
        for (String block : blocks) {
            if (out.size() >= MAX_RESULTS) break;
            Matcher link = Pattern.compile("<h3[^>]*>\\s*<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>", Pattern.DOTALL)
                    .matcher(block);
            if (!link.find()) continue;
            Hit h = new Hit();
            h.url = cleanUrl(link.group(1));
            h.title = stripHtml(link.group(2));
            Matcher snip = Pattern.compile("<span[^>]*class=\"[^\"]*(?:c-color-gray2|summary|content-right)[^\"]*\"[^>]*>(.*?)</span>",
                    Pattern.DOTALL).matcher(block);
            if (snip.find()) h.snippet = stripHtml(snip.group(1));
            h.date = dateOf(block);
            if (h.url.isEmpty() || h.title.isEmpty()) continue;
            out.add(h);
        }
        return out;
    }

    static List<Hit> parseBingNews(String html) {
        List<Hit> out = new ArrayList<>();
        if (html == null) return out;
        String[] blocks = html.split("<div class=\"news-card");
        for (String block : blocks) {
            if (out.size() >= MAX_RESULTS) break;
            Matcher link = Pattern.compile("<a[^>]*class=\"title\"[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>", Pattern.DOTALL)
                    .matcher(block);
            boolean found = link.find();
            if (!found) {
                link = Pattern.compile("<a[^>]*href=\"(https?://[^\"]+)\"[^>]*class=\"title\"[^>]*>(.*?)</a>", Pattern.DOTALL)
                        .matcher(block);
                found = link.find();
            }
            if (!found) continue;
            Hit h = new Hit();
            h.url = cleanUrl(link.group(1));
            h.title = stripHtml(link.group(2));
            Matcher snip = Pattern.compile("<div[^>]*class=\"[^\"]*snippet[^\"]*\"[^>]*>(.*?)</div>", Pattern.DOTALL)
                    .matcher(block);
            if (snip.find()) h.snippet = stripHtml(snip.group(1));
            h.date = dateOf(block);
            if (h.url.isEmpty() || h.title.isEmpty()) continue;
            out.add(h);
        }
        return out;
    }

    static List<Hit> parseSogouNews(String html) {
        List<Hit> out = new ArrayList<>();
        if (html == null) return out;
        String[] blocks = html.split("<div class=\"vrwrap|<div class=\"news-box");
        for (String block : blocks) {
            if (out.size() >= MAX_RESULTS) break;
            Matcher link = Pattern.compile("<h3[^>]*>\\s*<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>", Pattern.DOTALL)
                    .matcher(block);
            if (!link.find()) continue;
            Hit h = new Hit();
            String u = cleanUrl(link.group(1));
            if (u.startsWith("/")) u = "https://news.sogou.com" + u;
            h.url = u;
            h.title = stripHtml(link.group(2));
            Matcher snip = Pattern.compile("<p[^>]*class=\"[^\"]*star-wiki[^\"]*\"[^>]*>(.*?)</p>", Pattern.DOTALL)
                    .matcher(block);
            boolean hasSnip = snip.find();
            if (!hasSnip) {
                snip = Pattern.compile("<div[^>]*class=\"[^\"]*text-layout[^\"]*\"[^>]*>(.*?)</div>", Pattern.DOTALL)
                        .matcher(block);
                hasSnip = snip.find();
            }
            if (hasSnip) h.snippet = stripHtml(snip.group(1));
            h.date = dateOf(block);
            if (h.url.isEmpty() || h.title.isEmpty()) continue;
            out.add(h);
        }
        return out;
    }

    // ---------------------------------------------------------------- parsers (unit tested)

    static List<Hit> parseDdg(String html) {
        List<Hit> out = new ArrayList<>();
        if (html == null) return out;
        String[] blocks = html.split("<div class=\"result ");
        for (String block : blocks) {
            if (out.size() >= MAX_RESULTS) break;
            Hit h = new Hit();
            Matcher link = Pattern.compile("<a[^>]*class=\"result__a\"[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>",
                    Pattern.DOTALL).matcher(block);
            if (!link.find()) continue;
            h.url = cleanUrl(link.group(1));
            h.title = stripHtml(link.group(2));
            Matcher snip = Pattern.compile("<a[^>]*class=\"result__snippet\"[^>]*>(.*?)</a>", Pattern.DOTALL)
                    .matcher(block);
            if (snip.find()) h.snippet = stripHtml(snip.group(1));
            if (h.url.isEmpty() || h.title.isEmpty()) continue;
            out.add(h);
        }
        return out;
    }

    /** lite.duckduckgo.com renders a table of <a class="result-link"> rows followed by a snippet. */
    static List<Hit> parseDdgLite(String html) {
        List<Hit> out = new ArrayList<>();
        if (html == null) return out;
        Matcher m = Pattern.compile("<a[^>]*class=\"result-link\"[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>",
                Pattern.DOTALL).matcher(html);
        List<Hit> links = new ArrayList<>();
        while (m.find() && links.size() < MAX_RESULTS * 3) {
            Hit h = new Hit();
            h.url = cleanUrl(m.group(1));
            h.title = stripHtml(m.group(2));
            if (!h.url.isEmpty() && !h.title.isEmpty()) links.add(h);
        }
        Matcher s = Pattern.compile("<td[^>]*class=\"result-snippet\"[^>]*>(.*?)</td>", Pattern.DOTALL).matcher(html);
        int i = 0;
        while (s.find() && i < links.size()) {
            links.get(i++).snippet = stripHtml(s.group(1));
        }
        for (Hit h : links) {
            if (out.size() >= MAX_RESULTS) break;
            out.add(h);
        }
        return out;
    }

    static List<Hit> parseBing(String html) {
        List<Hit> out = new ArrayList<>();
        if (html == null) return out;
        String[] blocks = html.split("<li class=\"b_algo\"");
        for (String block : blocks) {
            if (out.size() >= MAX_RESULTS) break;
            Hit h = new Hit();
            Matcher link = Pattern.compile("<h2[^>]*>\\s*<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>", Pattern.DOTALL)
                    .matcher(block);
            if (!link.find()) continue;
            h.url = cleanUrl(link.group(1));
            h.title = stripHtml(link.group(2));
            Matcher snip = Pattern.compile("<p[^>]*>(.*?)</p>", Pattern.DOTALL).matcher(block);
            if (snip.find()) h.snippet = stripHtml(snip.group(1));
            if (h.url.isEmpty() || h.title.isEmpty()) continue;
            out.add(h);
        }
        return out;
    }

    static List<Hit> parseBaidu(String html) {
        List<Hit> out = new ArrayList<>();
        if (html == null) return out;
        String[] blocks = html.split("<h3[^>]*class=\"[^\"]*t[^\"]*\"");
        for (String block : blocks) {
            if (out.size() >= MAX_RESULTS) break;
            Hit h = new Hit();
            Matcher link = Pattern.compile("<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>", Pattern.DOTALL).matcher(block);
            if (!link.find()) continue;
            h.url = cleanUrl(link.group(1));
            h.title = stripHtml(link.group(2));
            Matcher snip = Pattern.compile("class=\"c-abstract[^\"]*\"[^>]*>(.*?)</div>", Pattern.DOTALL)
                    .matcher(block);
            boolean found = snip.find();
            if (!found) {
                snip = Pattern.compile("class=\"content-right[^\"]*\"[^>]*>(.*?)</span>", Pattern.DOTALL).matcher(block);
                found = snip.find();
            }
            if (found) h.snippet = stripHtml(snip.group(1));
            if (h.url.isEmpty() || h.title.isEmpty()) continue;
            out.add(h);
        }
        return out;
    }

    // ---------------------------------------------------------------- key based engines

    private static List<Hit> tavily(String apiKey, String query) throws Exception {
        JSONObject body = new JSONObject();
        body.put("api_key", apiKey);
        body.put("query", query);
        body.put("max_results", MAX_RESULTS);
        body.put("search_depth", "basic");
        body.put("include_answer", false);
        return parseTavily(request("https://api.tavily.com/search", "POST", null, body.toString()));
    }

    private static List<Hit> serper(String apiKey, String query) throws Exception {
        JSONObject body = new JSONObject();
        body.put("q", query);
        body.put("num", MAX_RESULTS);
        return parseSerper(request("https://google.serper.dev/search", "POST", apiKey, body.toString()));
    }

    private static List<Hit> brave(String apiKey, String query) throws Exception {
        String url = "https://api.search.brave.com/res/v1/web/search?count=" + MAX_RESULTS + "&q=" + enc(query);
        return parseBrave(request(url, "GET", apiKey, null));
    }

    static List<Hit> parseTavily(String raw) throws Exception {
        List<Hit> out = new ArrayList<>();
        JSONArray arr = new JSONObject(raw).optJSONArray("results");
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject r = arr.optJSONObject(i);
            if (r == null) continue;
            Hit h = new Hit();
            h.title = r.optString("title", "");
            h.url = r.optString("url", "");
            h.snippet = r.optString("content", r.optString("snippet", ""));
            String date = r.optString("published_date", r.optString("date", ""));
            if (date != null && date.length() >= 10) date = date.substring(0, 10);
            h.date = date == null ? "" : date;
            out.add(h);
        }
        return out;
    }

    static List<Hit> parseSerper(String raw) throws Exception {
        List<Hit> out = new ArrayList<>();
        JSONArray arr = new JSONObject(raw).optJSONArray("organic");
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject r = arr.optJSONObject(i);
            if (r == null) continue;
            Hit h = new Hit();
            h.title = r.optString("title", "");
            h.url = r.optString("link", r.optString("url", ""));
            h.snippet = r.optString("snippet", r.optString("description", ""));
            out.add(h);
        }
        return out;
    }

    static List<Hit> parseBrave(String raw) throws Exception {
        List<Hit> out = new ArrayList<>();
        JSONObject web = new JSONObject(raw).optJSONObject("web");
        JSONArray arr = web == null ? null : web.optJSONArray("results");
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject r = arr.optJSONObject(i);
            if (r == null) continue;
            Hit h = new Hit();
            h.title = r.optString("title", "");
            h.url = r.optString("url", "");
            h.snippet = r.optString("description", "");
            out.add(h);
        }
        return out;
    }

    // ---------------------------------------------------------------- formatting

    /** Plain-text block handed to the model. Kept stable so it is easy to assert in tests. */
    static String format(List<Hit> hits) {
        if (hits == null || hits.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        int n = 0;
        for (Hit h : hits) {
            if (h == null || h.url == null || h.url.isEmpty()) continue;
            if (n >= MAX_RESULTS) break;
            n++;
            String title = clip(h.title, 120);
            if (h.date != null && !h.date.isEmpty()) {
                sb.append(n).append(". ").append(title).append("（").append(clip(h.date, 24)).append("）").append('\n');
            } else {
                sb.append(n).append(". ").append(title).append('\n');
            }
            sb.append("   ").append(h.url).append('\n');
            String s = clip(h.snippet, 320);
            if (!s.isEmpty()) sb.append("   ").append(s).append('\n');
        }
        return sb.toString().trim();
    }

    private static String clip(String s, int max) {
        if (s == null) return "";
        String t = s.replaceAll("\\s+", " ").trim();
        return t.length() > max ? t.substring(0, max) + "…" : t;
    }

    // ---------------------------------------------------------------- html helpers

    static String cleanUrl(String raw) {
        if (raw == null) return "";
        String u = raw.trim();
        if (u.startsWith("//")) u = "https:" + u;
        int idx = u.indexOf("uddg=");
        if (idx >= 0) {
            String enc = u.substring(idx + 5);
            int amp = enc.indexOf('&');
            if (amp >= 0) enc = enc.substring(0, amp);
            try {
                u = URLDecoder.decode(enc, "UTF-8");
            } catch (Exception ignored) {
            }
        } else if (u.contains("bing.com/ck/a")) {
            // Bing wraps some links; keep whatever target it carries
            int uu = u.indexOf("u=a1");
            if (uu >= 0) {
                String tail = u.substring(uu + 4);
                int amp = tail.indexOf('&');
                if (amp >= 0) tail = tail.substring(0, amp);
                try {
                    String b64 = URLDecoder.decode(tail, "UTF-8");
                    u = new String(java.util.Base64.getDecoder().decode(padBase64(b64)), StandardCharsets.UTF_8);
                } catch (Exception ignored) {
                }
            }
        }
        return u;
    }

    private static String padBase64(String s) {
        String t = s.replace('-', '+').replace('_', '/');
        while (t.length() % 4 != 0) t += "=";
        return t;
    }

    static String stripHtml(String html) {
        if (html == null) return "";
        String s = html.replaceAll("(?is)<script.*?</script>", " ");
        s = s.replaceAll("(?is)<style.*?</style>", " ");
        s = TAG_BLOCK.matcher(s).replaceAll(" ");
        s = s.replace("&nbsp;", " ")
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&#x27;", "'")
                .replace("&hellip;", "…")
                .replace("&mdash;", "—")
                .replace("&ndash;", "–")
                .replace("&rsquo;", "’")
                .replace("&lsquo;", "‘")
                .replace("&ldquo;", "“")
                .replace("&rdquo;", "”");
        s = s.replaceAll("&#(\\d+);", " ");
        s = SPACES.matcher(s).replaceAll(" ");
        s = NEWLINES.matcher(s).replaceAll("\n");
        return s.trim();
    }

    private static String enc(String s) throws Exception {
        return URLEncoder.encode(s, "UTF-8");
    }

    // ---------------------------------------------------------------- http

    /** Cookies per host, so Baidu stops answering with 安全验证. */
    private static final java.util.Map<String, String> COOKIE = new java.util.HashMap<>();
    private static final java.util.Set<String> WARMED = new java.util.HashSet<>();

    private static String hostOf(String url) {
        try {
            return new URL(url).getHost();
        } catch (Exception e) {
            return "";
        }
    }

    /** First hit on a host often only hands out a cookie; do it once and reuse. */
    private static void warmUp(String url) {
        String root = "https://" + hostOf(url);
        synchronized (WARMED) {
            if (WARMED.contains(root)) return;
            WARMED.add(root);
        }
        try {
            request(root + "/", "GET", null, null);
        } catch (Exception ignored) {
        }
    }

    private static String fetch(String url) throws Exception {
        if (url.contains("baidu.com")) warmUp(url);
        return request(url, "GET", null, null);
    }

    private static void storeCookies(String host, HttpURLConnection c) {
        try {
            java.util.List<String> list = c.getHeaderFields().get("Set-Cookie");
            if (list == null || list.isEmpty()) return;
            StringBuilder sb = new StringBuilder();
            String old = COOKIE.get(host);
            if (old != null && !old.isEmpty()) sb.append(old);
            for (String raw : list) {
                if (raw == null) continue;
                int semi = raw.indexOf(';');
                String pair = semi > 0 ? raw.substring(0, semi) : raw;
                if (pair.indexOf('=') <= 0) continue;
                if (sb.length() > 0) sb.append("; ");
                sb.append(pair);
            }
            COOKIE.put(host, sb.toString());
        } catch (Exception ignored) {
        }
    }

    private static String request(String url, String method, String apiKey, String payload) throws Exception {
        String current = url;
        String currentMethod = method;
        String currentPayload = payload;

        for (int hop = 0; hop < 4; hop++) {
            String host = hostOf(current);
            HttpURLConnection c = (HttpURLConnection) new URL(current).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setRequestMethod(currentMethod);
            c.setConnectTimeout(20000);
            c.setReadTimeout(25000);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
            c.setRequestProperty("Accept", currentPayload == null
                    ? "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7"
                    : "application/json");
            String cookie = COOKIE.get(host);
            if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);

            if (apiKey != null && !apiKey.isEmpty()) {
                if (current.contains("serper.dev")) {
                    c.setRequestProperty("X-API-KEY", apiKey);
                } else if (current.contains("brave.com")) {
                    c.setRequestProperty("X-Subscription-Token", apiKey);
                } else if (!current.contains("tavily.com")) {
                    c.setRequestProperty("Authorization", "Bearer " + apiKey);
                }
            }
            if (currentPayload != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                byte[] bytes = currentPayload.getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(bytes);
                    os.flush();
                }
            }

            int code = c.getResponseCode();
            storeCookies(host, c);

            if ((code == 301 || code == 302 || code == 303 || code == 307 || code == 308) && hop < 3) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null || loc.isEmpty()) throw new Exception("HTTP " + code + " 但没有 Location");
                current = new URL(new URL(current), loc).toString();
                currentMethod = "GET";
                currentPayload = null;
                continue;
            }

            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String encHeader = c.getContentEncoding();
            if (in != null && encHeader != null && encHeader.toLowerCase().contains("gzip")) {
                in = new GZIPInputStream(in);
            }
            String text = drain(in);
            c.disconnect();

            if (code >= 400) {
                String msg = text;
                try {
                    JSONObject o = new JSONObject(text);
                    JSONObject err = o.optJSONObject("error");
                    if (err != null) msg = err.optString("message", err.toString());
                    else if (o.has("detail")) msg = String.valueOf(o.get("detail"));
                    else if (o.has("message")) msg = String.valueOf(o.get("message"));
                } catch (Exception ignored) {
                }
                if (msg != null && msg.length() > 300) msg = msg.substring(0, 300) + "…";
                throw new Exception("搜索 HTTP " + code + ": " + msg);
            }
            return text;
        }
        throw new Exception("重定向次数过多");
    }

    private static String drain(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return new String(bo.toByteArray(), StandardCharsets.UTF_8);
    }
}
