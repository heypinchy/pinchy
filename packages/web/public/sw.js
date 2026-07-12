// Pinchy PWA service worker.
// Minimal: only intercepts the Web Share Target POST; everything else
// passes through untouched.

importScripts("/sw-share-target.js");

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      try {
        const cache = await caches.open("share-target");
        const keys = await cache.keys();
        await Promise.all(keys.map((k) => cache.delete(k)));
      } catch {
        // Best-effort sweep of orphaned share-target cache entries; failures
        // here must not block activation.
      }
    })()
  );
});

// MUST NOT call event.respondWith() outside the guarded branch below; doing
// so would intercept all requests and break the "no caching" contract of
// this SW for everything except the share target.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(handleShareTarget(event.request));
  }
  // all other requests: pass through (no respondWith)
});
