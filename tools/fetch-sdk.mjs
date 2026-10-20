// Resolve official Android SDK package URLs from the Google repository manifest,
// then download the zips with Node's fetch (java/sdkmanager networking is blocked here).
import { createWriteStream, mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const BASE = "https://dl.google.com/android/repository/";
const OUT = process.argv[2] || ".";
mkdirSync(OUT, { recursive: true });

const xml = await (await fetch(BASE + "repository2-1.xml")).text();
console.log("manifest bytes:", xml.length);

const blocks = [...xml.matchAll(/<remotePackage path="([^"]+)">([\s\S]*?)<\/remotePackage>/g)];
console.log("packages:", blocks.length);

function revision(block) {
  const m = block.match(/<revision>\s*<major>(\d+)<\/major>\s*<minor>(\d+)<\/minor>\s*<micro>(\d+)<\/micro>/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}
function windowsUrl(block) {
  const arch = block.match(/<archive>([\s\S]*?)<\/archive>/g) || [];
  for (const a of arch) {
    if (!/windows/.test(a)) continue;
    const u = a.match(/<url>([^<]+)<\/url>/);
    if (u) return u[1];
  }
  // host-independent archives (platforms have <host-os>any</host-os>)
  for (const a of arch) {
    const u = a.match(/<url>([^<]+)<\/url>/);
    const os = a.match(/<host-os>([^<]+)<\/host-os>/);
    if (u && os && os[1] === "any") return u[1];
  }
  return null;
}

const wanted = ["platform-tools", "platforms;android-34", "build-tools;34.0.0"];
const picked = {};

for (const [, path, block] of blocks) {
  if (!wanted.includes(path)) continue;
  const url = windowsUrl(block);
  if (!url) continue;
  const rev = revision(block);
  const cur = picked[path];
  if (!cur || (rev[0] > cur.rev[0]) || (rev[0] === cur.rev[0] && rev[1] > cur.rev[1]) ||
      (rev[0] === cur.rev[0] && rev[1] === cur.rev[1] && rev[2] >= cur.rev[2])) {
    picked[path] = { url, rev };
  }
}

for (const p of wanted) {
  if (!picked[p]) { console.log("MISSING", p); continue; }
  console.log(p, "->", picked[p].url, "rev", picked[p].rev.join("."));
}

for (const [p, v] of Object.entries(picked)) {
  const name = v.url.split("/").pop();
  const dest = `${OUT}\\${name}`;
  console.log("downloading", v.url);
  const res = await fetch(BASE + v.url, { redirect: "follow" });
  if (!res.ok) { console.log("FAIL", res.status, p); continue; }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log("saved", dest);
}
console.log("DONE");
