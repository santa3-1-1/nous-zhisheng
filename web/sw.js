const CACHE_NAME = 'nous-v3';
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

// ===== Web Push 处理 =====

self.addEventListener('push', (e) => {
  const data = e.data?.json() || {};
  
  const options = {
    body: data.body || '有人通过知音联系你',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [200, 100, 200, 100, 200], // 来电震动模式
    tag: data.type || 'zhiyin-notification', // 同类通知合并
    renotify: true, // 即使 tag 相同也重新提醒
    requireInteraction: true, // 不自动消失，等用户操作
    data: data.data || {},
    actions: data.type === 'incoming_call' 
      ? [{ action: 'answer', title: '接听' }, { action: 'decline', title: '拒绝' }]
      : [{ action: 'open', title: '查看' }],
  };

  e.waitUntil(
    self.registration.showNotification(data.title || '知音', options)
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  
  const data = e.notification.data || {};
  let targetUrl = '/index.html';
  
  if (e.action === 'answer' || e.action === 'open') {
    // 点击"接听"或"查看" → 打开对应页面
    targetUrl = data.url || '/index.html';
  } else if (e.action === 'decline') {
    // 点击"拒绝" → 不做任何事
    return;
  } else {
    // 点击通知本体 → 打开对应页面
    targetUrl = data.url || '/index.html';
  }

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // 如果已有窗口打开，聚焦并导航
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin)) {
          client.navigate(self.location.origin + targetUrl);
          return client.focus();
        }
      }
      // 否则打开新窗口
      return clients.openWindow(targetUrl);
    })
  );
});
