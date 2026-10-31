// Team Time Clock service worker.
// Goal: the app SHELL loads instantly and works offline — but LIVE DATA and
// PUNCHES always go to the network (never cached, never faked). A punch only
// counts when the server confirms it.

const CACHE = 'brand-otc-v4';
const CORE = [
  '/', '/index.html', '/manifest.webmanifest',
  '/favicon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;                    // never touch punches / POSTs
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;         // Supabase / Resend etc. -> straight to network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) return; // functions -> network only

  // App navigation: network-first (fresh app when online), fall back to the
  // cached shell so it still opens with no signal.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/index.html', copy)); return res; })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  // Static assets (hashed JS/CSS, icons): serve cached fast, refresh in background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy)); } return res; })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
