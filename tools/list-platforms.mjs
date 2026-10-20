for (const f of ["repository2-1.xml", "repository2-3.xml", "repository2-4.xml"]) {
  try {
    const r = await fetch("https://dl.google.com/android/repository/" + f);
    if (!r.ok) { console.log(f, "HTTP", r.status); continue; }
    const t = await r.text();
    const paths = [...t.matchAll(/<remotePackage path="([^"]+)"/g)].map((m) => m[1])
      .filter((p) => p.startsWith("platforms;"));
    console.log(f, "bytes", t.length, "platforms:", paths.join(", "));
  } catch (e) {
    console.log(f, "ERR", e.message);
  }
}
