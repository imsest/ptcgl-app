/* オフラインでもアプリの画面が開けるようにする仕組み。
   アプリのファイルは毎回サーバーに「新しい版があるか」を確認してから使い（更新がすぐ反映される）、
   電波がないときだけ保存しておいたものを使う。Gemini や Limitless への問い合わせには手を出さない。 */
const CACHE = "ptcgl-v4";
const FILES = ["./", "index.html", "app.js", "core.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(FILES.map((f) => fetch(f, { cache: "no-cache" }).then((r) => c.put(f, r)).catch(() => {}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" }).then((res) => {   // 毎回サーバーに確認（変わっていなければ通信は小さい）
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});
