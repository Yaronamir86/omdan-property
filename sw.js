const CACHE = 'omdan-v1';
const PRECACHE = [
  '/',
  '/app/dashboard.html',
  '/app/case.html',
  '/app/settings.html',
  '/assets/omdan-logo.png',
  '/assets/omdan-favicon.png',
  '/assets/omdan-app-icon-192.png',
  '/assets/omdan-app-icon-512.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE).catch(()=>{})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // רק GET, לא Firebase/Functions
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.hostname.includes('firestore') ||
      url.hostname.includes('cloudfunctions') ||
      url.hostname.includes('googleapis') ||
      url.hostname.includes('gstatic')) {
    return; // תמיד מהרשת
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
