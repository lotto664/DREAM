// 오프라인에서도 앱이 열리도록 파일을 기기에 저장해두는 서비스 워커.
// 인터넷이 되면 항상 최신 파일을 먼저 받고(업데이트 자동 반영), 안 되면 저장본을 쓴다.
const CACHE_NAME = 'dream-app-v3';
const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './parser.js',
  './xlsx.js',
  './pdf-extract.js',
  './ocr.js',
  './lib/pdf.min.js',
  './lib/pdf.worker.min.js',
  './lib/tesseract/tesseract.min.js',
  './lib/tesseract/worker.min.js',
  './lib/tesseract/tesseract-core-simd-lstm.wasm.js',
  './lib/tesseract/tesseract-core-lstm.wasm.js',
  './lib/tesseract/kor.traineddata.gz',
  './lib/tesseract/eng.traineddata.gz',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
