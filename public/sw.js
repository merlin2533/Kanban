const CACHE_NAME = 'kanban-v6';
const STATIC_ASSETS = [
  '/',
  '/board.html',
  '/card.html',
  '/login.html',
  '/settings.html',
  '/admin.html',
  '/style.css',
  '/app.js',
  '/card.js',
  '/pwa-install.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512-maskable.png',
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

  // API calls & uploads: always network with credentials
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
    e.respondWith(
      fetch(new Request(e.request, { credentials: 'include' })).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Navigation requests: network first, fallback to cached page for matching route
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => {
        if (/^\/board\/[^/]+\/card\//.test(url.pathname)) return caches.match('/card.html');
        if (url.pathname.startsWith('/board/')) return caches.match('/board.html');
        return caches.match(url.pathname) || caches.match('/');
      })
    );
    return;
  }

  // Only cache http/https requests (chrome-extension:// etc. are unsupported)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Static assets: network first, fallback to cache (avoids stale JS/HTML)
  e.respondWith(
    fetch(e.request).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      }
      return response;
    }).catch(() => caches.match(e.request))
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
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: data.data || {},
      vibrate: [200, 100, 200]
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  // Try to open the specific card if we have cardId info
  const url = data.cardId ? '/' : '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      // Focus existing window if available
      for (const client of clients) {
        if (client.url.includes('/board/') && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
