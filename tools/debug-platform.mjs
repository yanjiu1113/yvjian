const xml = await (await fetch("https://dl.google.com/android/repository/repository2-1.xml")).text();
const blocks = [...xml.matchAll(/<remotePackage path="(platforms;android-34)">([\s\S]*?)<\/remotePackage>/g)];
console.log("blocks:", blocks.length);
if (blocks.length) {
  const b = blocks[0][2];
  console.log(b.slice(0, 1800));
}
