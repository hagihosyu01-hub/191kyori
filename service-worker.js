const CACHE_NAME = 'r191-kp-v4';
const ASSETS = [
  'index.html',
  'manifest.json',
  'icon-192.png'
];

// インストール時に基本ファイルをキャッシュ
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => {
      return self.skipWaiting(); // 新しいサービスワーカーをすぐに有効化
    })
  );
});

// アクティベート時に古いキャッシュを削除
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => {
      return self.clients.claim(); // 即座に制御を開始
    })
  );
});

// フェッチ処理
self.addEventListener('fetch', (e) => {
  const req = e.request;

  // 自サイト以外（chrome-extension等）は対象外
  if (!req.url.startsWith(self.location.origin)) {
    return;
  }

  // ページ本体(HTML)はネットワーク優先 ＝ オンライン時は常に最新を表示。
  // 取得できたら最新をキャッシュし、オフライン時はキャッシュを使う。
  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put('index.html', copy));
        return res;
      }).catch(() => caches.match('index.html'))
    );
    return;
  }

  // その他（manifest/icon等）はキャッシュ優先、無ければネットワーク。
  // 図面(map_*.webp)はキャッシュに含めないため通信時に取得します。
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
      .catch(() => caches.match('index.html'))
  );
});
