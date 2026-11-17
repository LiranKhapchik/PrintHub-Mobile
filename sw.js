// PrintHub Mobile service worker: offline app shell + receiving files shared from other apps (Android).
const VERSION = "printhub-v1";
const SHELL = [
  "./", "index.html", "css/app.css", "js/app.js", "js/core.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
  "vendor/pdf.min.mjs", "vendor/pdf.worker.min.mjs", "vendor/pdf-lib.min.js", "vendor/fontkit.umd.min.js",
  "vendor/Sortable.min.js", "vendor/NotoSansHebrew-Regular.ttf",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== "printhub-shared") await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Web Share Target: "Share > PrintHub" from the gallery, WhatsApp, Drive...
  if (e.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const cache = await caches.open("printhub-shared");
      let i = 0;
      for (const f of form.getAll("files")) {
        if (!(f instanceof File)) continue;
        await cache.put(`shared/${Date.now()}-${i++}`,
          new Response(f, { headers: { "content-type": f.type, "x-name": encodeURIComponent(f.name) } }));
      }
      return Response.redirect("./?shared=1", 303);
    })());
    return;
  }
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // network first (updates show up immediately), cached copy when offline or slow (> 4 s)
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const r = await Promise.race([fetch(e.request), new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 4000))]);
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    } catch (_) {
      return (await cache.match(e.request, { ignoreSearch: true })) || new Response("offline", { status: 503 });
    }
  })());
});
