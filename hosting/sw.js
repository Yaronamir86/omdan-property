const CACHE = "omdan-assets-v1";

// רק assets סטטיים — לא HTML
const PRECACHE = [
  "/assets/img/omdan-logo.png",
  "/assets/img/omdan-favicon.png",
  "/assets/img/omdan-app-icon-192.png",
  "/assets/img/omdan-app-icon-512.png",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE).catch(() => {})),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);

  // Firebase / Functions / Google — תמיד מהרשת
  if (
    url.hostname.includes("firestore") ||
    url.hostname.includes("cloudfunctions") ||
    url.hostname.includes("googleapis") ||
    url.hostname.includes("gstatic") ||
    url.hostname.includes("fonts")
  )
    return;

  // HTML — תמיד מהרשת, לא מ-cache
  if (
    e.request.destination === "document" ||
    url.pathname.endsWith(".html") ||
    url.pathname === "/"
  ) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Assets (images, icons) — cache first
  if (
    url.pathname.startsWith("/assets/") ||
    e.request.destination === "image"
  ) {
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request)),
    );
    return;
  }

  // כל השאר — מהרשת
  e.respondWith(fetch(e.request));
});
