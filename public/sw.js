// ═══════════════════════════════════════════════════════════════════════
// Service Worker — Network-first, cache as offline fallback
// Primary cache-busting is handled by no-store HTTP headers.
// ═══════════════════════════════════════════════════════════════════════

const CACHE = 'jidelnicek-v3';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// Network-first with cache fallback for offline use
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).then(response => {
      // Cache static assets for offline use
      if (response.ok && event.request.url.startsWith(location.origin)) {
        const clone = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request).then(cached => cached || new Response('Offline', { status: 503 })))
  );
});
