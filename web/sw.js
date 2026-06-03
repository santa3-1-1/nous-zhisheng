const CACHE_NAME = 'nous-v4';
const ASSETS = ['/TRTC.js', '/manifest.json'];
// 注意：不缓存 index.html — 它走 network first

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting(); // 新 SW 立即接管
});

self.addEventListener('activate', (e) => {
  // 清除所有旧版本缓存
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim()) // 立即控制所有页面
  );

  // 通知所有客户端刷新
  self.clients.matchAll().then(clients => {
    clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
  });
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API 请求：直接走网络，不缓存
  if (url.pathname.startsWith('/api/')) return;

  // HTML 页面：Network First（确保总是最新版）
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
    e.respondWith(
      fetch(e.request).then(res => {
        // 成功拿到网络版本 → 更新缓存 + 返回
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => {
        // 网络失败 → 用缓存兜底（离线模式）
        return caches.match(e.request);
      })
    );
    return;
  }

  // 静态资源（JS/CSS/图片）：Cache First + 后台更新
  e.respondWith(
    caches.match(e.request).then(cached => {
      // 后台发起网络请求更新缓存（stale-while-revalidate）
      const fetchPromise = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});

// ===== Web Push 处理 =====

self.addEventListener('push', (e) => {
  const data = e.data?.json() || {};

  const options = {
    body: data.body || '有人通过知音联系你',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [200, 100, 200, 100, 200],
    tag: data.type || 'zhiyin-notification',
    renotify: true,
    requireInteraction: true,
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
    targetUrl = data.url || '/index.html';
  } else if (e.action === 'decline') {
    return;
  } else {
    targetUrl = data.url || '/index.html';
  }

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin)) {
          client.navigate(self.location.origin + targetUrl);
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
