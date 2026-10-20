// Download the base "Android SDK Platform 34" zip directly (the repo has ext12/ext11 variants
// under the same path, so we pick by display-name).
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const BASE = "https://dl.google.com/android/repository/";
const OUT = process.argv[2] || ".";
const xml = await (await fetch(BASE + "repository2-1.xml")).text();
const blocks = [...xml.matchAll(/<remotePackage path="platforms;android-34">([\s\S]*?)<\/remotePackage>/g)];
let target = null;
for (const [, b] of blocks) {
  const name = (b.match(/<display-name>([^<]+)<\/display-name>/) || [])[1] || "";
  if (name.trim() === "Android SDK Platform 34") {
    target = b;
    break;
  }
}
if (!target) {
  for (const [, b] of blocks) {
    const name = (b.match(/<display-name>([^<]+)<\/display-name>/) || [])[1] || "";
    console.log("candidate:", name);
  }
  process.exit(1);
}
const url = target.match(/<url>([^<]+)<\/url>/)[1];
console.log("platform zip:", url);
const dest = `${OUT}\\${url}`;
const res = await fetch(BASE + url);
if (!res.ok) throw new Error("HTTP " + res.status);
await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
console.log("saved", dest);
