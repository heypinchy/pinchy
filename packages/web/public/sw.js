// Pinchy PWA service worker (install stub).
// Intentionally minimal: no caching, no fetch interception.
// Exists so Chrome/Edge classify Pinchy as installable.

const VERSION = "1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // No-op. Required for installability check, but does not intercept.
});
