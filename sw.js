// PWA としてホーム画面にインストールした後、PC (adb reverse) や Wi-Fi が無くても
// 起動できるようにするための Service Worker。
//
// 方針は「オンライン中はネットワーク優先、失敗したらキャッシュ」:
//   - Serve-WebMonitor.ps1 で開いている間は毎回ネットワークから取りにいくので、
//     ファイルを保存 → リロードするいつもの開発ループはそのまま効く。
//   - ネットワークが無い（PC を落とした後の単体起動）ときだけキャッシュへ落ちる。
// これにより「一度 PC から開いて PWA インストール」の後は、その PC/adb セッションが
// 無くなっても同じ origin (http://localhost:<port>) のままオフラインで起動できる。
// WebUSB の secure context 判定は origin の文字列に対する判定であり、実際に
// その番号へ接続できるかどうかとは無関係なので、これで壊れない。

const CACHE = "csi-monitor-v3";
const APP_SHELL = ["./", "index.html", "csi_proto.js", "usb_serial.js", "transport.js", "manifest.json", "icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // GET のみ・同一 origin のみを面倒みる。他は素通し。
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // 200 のときだけキャッシュを更新する（次にオフラインで開いたとき用）。
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("index.html")))
  );
});
