// Mock OpenAI-compatible server used to exercise the Android Java HTTP layer on the desktop JVM.
import http from "node:http";

const PORT = Number(process.argv[2] || 8791);
const KEY = "test-key";

const server = http.createServer((req, res) => {
  const url = req.url || "";
  const auth = req.headers["authorization"] || "";

  if (req.method === "GET" && url.endsWith("/models")) {
    if (auth !== "Bearer " + KEY) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-stream" }, { id: "mock-nostream", name: "NoStream Model" }] }));
    return;
  }

  if (req.method === "POST" && url.endsWith("/chat/completions")) {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (e) { /* ignore */ }

      if (body.model === "mock-401") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Authentication Fails, Your api key: sk-x is invalid" } }));
        return;
      }

      if (body.model === "mock-nostream") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "非流式回答" } }] }));
        return;
      }

      if (!body.stream) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "expected stream:true" } }));
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const frames = [
        { choices: [{ delta: { reasoning_content: "先想一想。" } }] },
        { choices: [{ delta: { content: "你好" } }] },
        { choices: [{ delta: { content: "，世界" } }] },
        { choices: [{ delta: { content: "！" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] }
      ];
      let i = 0;
      const timer = setInterval(() => {
        if (i < frames.length) {
          res.write("data: " + JSON.stringify(frames[i]) + "\n\n");
          i++;
        } else {
          res.write("data: [DONE]\n\n");
          clearInterval(timer);
          res.end();
        }
      }, 20);
      req.on("close", () => clearInterval(timer));
    });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => console.log("mock server on http://127.0.0.1:" + PORT));
