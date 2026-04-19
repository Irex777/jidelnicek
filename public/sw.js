// ═══════════════════════════════════════════════════════════════════════
// Service Worker — Force-clear all caches, network-first strategy
// This is the nuclear option for iPad Safari cache busting.
// ═══════════════════════════════════════════════════════════════════════

const SW_VERSION = Date.now();

// On install: delete ALL caches, then skip waiting to activate immediately
self.addEventListener('install', (event) => {
  console.log('[SW] Install — clearing all caches, version:', SW_VERSION);
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(name => {
          console.log('[SW] Deleting cache:', name);
          return caches.delete(name);
        })
      );
    }).then(() => {
      console.log('[SW] All caches cleared, skipping waiting');
      return self.skipWaiting();
    })
  );
});

// On activate: claim all clients immediately so the SW takes control
self.addEventListener('activate', (event) => {
  console.log('[SW] Activate — claiming all clients');
  event.waitUntil(
    self.clients.claim().then(() => {
      console.log('[SW] All clients claimed');
    })
  );
});

// Network-first strategy for all requests
// Tries network first, falls back to cache only if offline
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then(response => {
        // Clone and cache for offline use
        if (response.ok) {
          const clone = response.clone();
          caches.open('jidelnicek-v1').then(cache => {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(() => {
        // Network failed — try cache
        return caches.match(event.request).then(cached => {
          return cached || new Response('Offline', { status: 503 });
        });
      })
  );
});
