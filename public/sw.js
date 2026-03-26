const CACHE_NAME = 'kanban-v1';
const STATIC_ASSETS = [
  '/',
  '/board.html',
  '/login.html',
  '/settings.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg'
];

// Install: cache static assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.error('SW install failed:', err))
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network first for API, cache first for static
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API calls & uploads: always network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Navigation requests: fallback to board.html for /board/* routes
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/board.html'))
    );
    return;
  }

  // Static assets: cache first, fallback to network
  e.respondWith(
    caches.match(e.request).then(cached => {
      return cached || fetch(e.request).then(response => {
        // Cache new static responses
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      });
    })
  );
});

// Push notifications
self.addEventListener('push', (e) => {
  let data;
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: 'Kanban', body: e.data ? e.data.text() : 'Neue Aktivität' };
  }
  e.waitUntil(
    self.registration.showNotification(data.title || 'Kanban', {
      body: data.body || 'Neue Aktivität auf deinem Board',
      icon: '/icons/icon-192.svg',
      badge: '/icons/icon-192.svg'
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow('/'));
});
