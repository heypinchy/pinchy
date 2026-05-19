// Pinchy PWA service worker (install stub).
// Intentionally minimal: no caching, no fetch interception.
// Exists so Chrome/Edge classify Pinchy as installable.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// MUST NOT call event.respondWith(); doing so would intercept all requests
// and break the explicit "no caching" contract of this stub SW.
self.addEventListener("fetch", () => {
  // No-op. Required for installability check, but does not intercept.
});
