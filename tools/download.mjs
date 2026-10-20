import { createWriteStream, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const [, , url, dest] = process.argv;
mkdirSync(dirname(dest), { recursive: true });

const ctrl = new AbortController();
const hardTimeout = setTimeout(() => ctrl.abort(), 30 * 60 * 1000);

function fmt(n) {
  if (n > 1 << 30) return (n / (1 << 30)).toFixed(1) + "G";
  if (n > 1 << 20) return (n / (1 << 20)).toFixed(1) + "M";
  return (n / 1024).toFixed(0) + "K";
}

const started = Date.now();
const res = await fetch(url, { redirect: "follow", signal: ctrl.signal });
if (!res.ok) {
  console.error(`HTTP ${res.status} for ${url}`);
  process.exit(1);
}
const total = Number(res.headers.get("content-length") || 0);
let got = 0;
let last = 0;
const src = Readable.fromWeb(res.body);
src.on("data", (c) => {
  got += c.length;
  if (Date.now() - last > 3000) {
    last = Date.now();
    const secs = (Date.now() - started) / 1000;
    console.log(`${dest.split("\\").pop()}: ${fmt(got)}${total ? " / " + fmt(total) : ""} (${fmt(got / secs)}/s)`);
  }
});
await pipeline(src, createWriteStream(dest));
clearTimeout(hardTimeout);
console.log(`DONE ${dest} ${fmt(statSync(dest).size)} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
