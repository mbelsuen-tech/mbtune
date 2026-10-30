/* MBMix: guarda la app en el iPad para que abra sin internet (y se actualice sola cuando lo haya) */
const CACHE = "mbmix-v3";
const FILES = ["./", "index.html", "style.css", "app.js", "engine.js", "logo.png", "icon-180.png", "icon-192.png", "icon-512.png", "manifest.webmanifest"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  // primero la red (versión nueva); si no hay conexión, la copia guardada
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
