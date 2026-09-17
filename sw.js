/* 聲播日曆 Service Worker：只負責 Web Push 通知（開播／下播打卡提醒），不做任何快取。 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch (err) { data = { title: '🎙️ 聲播日曆提醒', body: e.data ? e.data.text() : '' }; }
  const title = data.title || '🎙️ 聲播日曆提醒';
  const opts = {
    body: data.body || '',
    icon: data.icon || './icon.png',
    badge: data.badge || './icon.png',
    tag: data.tag || 'en-calendar-remind',
    renotify: true,
    data: { url: data.url || './index.html' }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
