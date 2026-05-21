self.addEventListener("install", event => {
  event.waitUntil(
    caches.open("gmvmax-mobile-v1").then(cache => cache.addAll([
      "/mobile.html",
      "/mobile.webmanifest"
    ]))
  );
});

self.addEventListener("fetch", event => {
  if (event.request.url.includes("/api/latest")) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
