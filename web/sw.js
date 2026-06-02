const CACHE_NAME = 'nous-v1';
const ASSETS = ['/', '/index.html', '/TRTC.js', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Network first for API, cache first for assets
  if (e.request.url.includes('/api/')) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      return res;
    }))
  );
});

// Push notification handler
self.addEventListener('push', (e) => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || '知声来电', {
      body: data.body || '有人给你打电话',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: data,
      actions: [{ action: 'join', title: '接入通话' }],
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.joinUrl || '/index.html#calls';
  e.waitUntil(clients.openWindow(url));
});
