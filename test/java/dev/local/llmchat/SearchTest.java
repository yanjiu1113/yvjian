package dev.local.llmchat;

import java.util.List;

/** Offline checks for Search parsing/formatting (no network involved). */
public final class SearchTest {

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
        List<Search.Hit> tavily = Search.parseTavily(
                "{\"results\":[{\"title\":\"T1\",\"url\":\"https://a.example\",\"content\":\"摘要一\"}," +
                        "{\"title\":\"T2\",\"url\":\"https://b.example\",\"content\":\"摘要二\"}]}");
        check("tavily parses two hits", tavily.size() == 2, "size=" + tavily.size());
        check("tavily title", tavily.get(0).title.equals("T1"));
        check("tavily url", tavily.get(1).url.equals("https://b.example"));
        check("tavily snippet", tavily.get(0).snippet.equals("摘要一"));

        List<Search.Hit> serper = Search.parseSerper(
                "{\"organic\":[{\"title\":\"S1\",\"link\":\"https://c.example\",\"snippet\":\"serp 摘要\"}]}");
        check("serper parses organic", serper.size() == 1);
        check("serper maps link to url", serper.get(0).url.equals("https://c.example"));
        check("serper snippet", serper.get(0).snippet.equals("serp 摘要"));

        List<Search.Hit> brave = Search.parseBrave(
                "{\"web\":{\"results\":[{\"title\":\"B1\",\"url\":\"https://d.example\",\"description\":\"brave 摘要\"}]}}");
        check("brave parses web.results", brave.size() == 1);
        check("brave description as snippet", brave.get(0).snippet.equals("brave 摘要"));

        check("empty payload does not throw", Search.parseTavily("{}").isEmpty());
        check("brave without web node", Search.parseBrave("{}").isEmpty());

        String text = Search.format(tavily);
        check("format numbered list", text.startsWith("1. T1"), text);
        check("format includes url", text.contains("https://a.example"));
        check("format includes snippet", text.contains("摘要一"));
        check("format separates entries", text.contains("2. T2"));

        // URL-less hits are dropped, results are capped at 5
        List<Search.Hit> many = new java.util.ArrayList<>();
        for (int i = 0; i < 9; i++) {
            Search.Hit h = new Search.Hit();
            h.title = "H" + i;
            h.url = i == 3 ? "" : ("https://h" + i + ".example");
            h.snippet = "s" + i;
            many.add(h);
        }
        String capped = Search.format(many);
        check("format drops url-less hits", !capped.contains("H3"), capped);
        check("format caps at 5 entries", !capped.contains("6. "), capped);

        Search.Hit odd = new Search.Hit();
        odd.title = "多行\n标题";
        odd.url = "https://x.example";
        odd.snippet = "a\n\nb   c";
        String one = Search.format(java.util.Collections.singletonList(odd));
        check("format collapses whitespace", one.contains("多行 标题") && one.contains("a b c"), one);

        // ---- key-free engines parse public result pages
        String ddg = "<div class=\"result results_links\"><h2><a rel=\"nofollow\" class=\"result__a\" " +
                "href=\"//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1\">Example <b>A</b></a></h2>" +
                "<a class=\"result__snippet\" href=\"x\">Snippet <b>one</b></a></div>" +
                "<div class=\"result results_links\"><h2><a class=\"result__a\" href=\"https://example.org/b\">Second</a></h2>" +
                "<a class=\"result__snippet\">Two</a></div>";
        List<Search.Hit> d = Search.parseDdg(ddg);
        check("ddg parses two results", d.size() == 2, "size=" + d.size());
        check("ddg decodes redirect url", d.get(0).url.equals("https://example.com/a"), d.get(0).url);
        check("ddg strips tags from title", d.get(0).title.equals("Example A"), d.get(0).title);
        check("ddg keeps snippet", d.get(0).snippet.equals("Snippet one"), d.get(0).snippet);

        String bing = "<li class=\"b_algo\"><h2><a href=\"https://cn.bing.com/x\">标题一</a></h2>" +
                "<p class=\"b_lineclamp2\">摘要一</p></li>" +
                "<li class=\"b_algo\"><h2><a href=\"https://b.example\">T2</a></h2><p>P2</p></li>";
        List<Search.Hit> b = Search.parseBing(bing);
        check("bing parses two results", b.size() == 2, "size=" + b.size());
        check("bing title", b.get(0).title.equals("标题一"));
        check("bing snippet", b.get(0).snippet.equals("摘要一"));
        check("bing url", b.get(1).url.equals("https://b.example"));

        String baidu = "<h3 class=\"t\"><a href=\"http://www.baidu.com/link?url=abc\">百度标题</a></h3>" +
                "<div class=\"c-abstract\">百度摘要</div>" +
                "<h3 class=\"t\"><a href=\"https://b2.example\">第二条</a></h3>";
        List<Search.Hit> bd = Search.parseBaidu(baidu);
        check("baidu parses two results", bd.size() == 2, "size=" + bd.size());
        check("baidu title", bd.get(0).title.equals("百度标题"));
        check("baidu snippet", bd.get(0).snippet.equals("百度摘要"));
        check("baidu keeps redirect link", bd.get(0).url.contains("baidu.com/link"));

        check("stripHtml unescapes entities", Search.stripHtml("<b>hi</b> &amp; bye").equals("hi & bye"),
                Search.stripHtml("<b>hi</b> &amp; bye"));
        check("cleanUrl passes plain urls", Search.cleanUrl("https://x.example/p").equals("https://x.example/p"));
        check("cleanUrl adds scheme to protocol-relative", Search.cleanUrl("//x.example/p").equals("https://x.example/p"));
        check("keyless engines report no key", !Search.needsKey("duckduckgo") && !Search.needsKey("bing") && !Search.needsKey("baidu"));
        check("api engines report key", Search.needsKey("tavily") && Search.needsKey("serper") && Search.needsKey("brave"));
        // ---- news verticals
        String baiduNews = "<div class=\"result-op c-container\"><h3 class=\"news-title_1YtI1\">" +
                "<a href=\"https://news.example/a\">北京今日发布暴雨预警</a></h3>" +
                "<span class=\"c-color-gray2 c-font-normal\">2小时前</span>" +
                "<div class=\"result-op c-container\"><h3><a href=\"https://news.example/a2\">第二条新闻</a></h3></div>";
        List<Search.Hit> bn = Search.parseBaiduNews(baiduNews);
        check("baidu news parses items", bn.size() >= 1, "size=" + bn.size());
        check("baidu news title", bn.get(0).title.equals("北京今日发布暴雨预警"), bn.get(0).title);
        check("baidu news date captured", bn.get(0).date.equals("2小时前"), bn.get(0).date);

        String bingNews = "<div class=\"news-card\"><a class=\"title\" href=\"https://news.example/b\">上海地铁新线开通</a>" +
                "<div class=\"snippet\">今日开通试运营，全长 40 公里</div><span class=\"source\">2026-10-19</span></div>";
        List<Search.Hit> bgn = Search.parseBingNews(bingNews);
        check("bing news parses items", bgn.size() == 1, "size=" + bgn.size());
        check("bing news title", bgn.get(0).title.equals("上海地铁新线开通"));
        check("bing news snippet", bgn.get(0).snippet.indexOf("试运营") >= 0, bgn.get(0).snippet);
        check("bing news date", bgn.get(0).date.equals("2026-10-19"), bgn.get(0).date);

        String sogouNews = "<div class=\"vrwrap\"><h3><a href=\"/link?url=abc\">广州天气转凉</a></h3>" +
                "<p class=\"star-wiki\">气温下降 6 度</p></div>";
        List<Search.Hit> sgn = Search.parseSogouNews(sogouNews);
        check("sogou news parses items", sgn.size() == 1, "size=" + sgn.size());
        check("sogou news absolutises links", sgn.get(0).url.startsWith("https://news.sogou.com/link"), sgn.get(0).url);
        check("sogou news snippet", sgn.get(0).snippet.indexOf("气温") >= 0, sgn.get(0).snippet);

        Search.Hit dated = new Search.Hit();
        dated.title = "标题";
        dated.url = "https://x.example";
        dated.date = "2小时前";
        String datedText = Search.format(java.util.Collections.singletonList(dated));
        check("format shows the date", datedText.indexOf("（2小时前）") >= 0, datedText);
        // ---- RSS news feeds (Baidu / Bing)
        String rss = "<rss><channel>" +
                "<item><title><![CDATA[北京今日发布暴雨预警]]></title>" +
                "<link>https://news.example/r1</link>" +
                "<description><![CDATA[预计今日午后有强降雨]]></description>" +
                "<pubDate>Sun, 19 Oct 2026 08:30:00 +0800</pubDate></item>" +
                "<item><title>第二条</title><link>https://news.example/r2</link></item>" +
                "</channel></rss>";
        List<Search.Hit> rssHits = Search.parseRss(rss);
        check("rss parses items", rssHits.size() == 2, "len=" + rssHits.size());
        check("rss unwraps cdata title", rssHits.get(0).title.equals("北京今日发布暴雨预警"), rssHits.get(0).title);
        check("rss keeps link", rssHits.get(0).url.equals("https://news.example/r1"));
        check("rss strips description tags", rssHits.get(0).snippet.equals("预计今日午后有强降雨"), rssHits.get(0).snippet);
        check("rss normalises pubDate", rssHits.get(0).date.equals("10-19 08:30"), rssHits.get(0).date);
        check("rss skips items without link", rssHits.size() == 2);
        System.out.println("\n" + pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }
}
