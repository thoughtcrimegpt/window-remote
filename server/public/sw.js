// Window Remote offline helper (used only on the secure https address). Keeps a copy of the app
// itself, so opening it while the Mac is unreachable shows the app's own "Mac offline" screen
// instead of a browser error. Nothing from the Mac (window pictures) is stored here.
// When the app's files change, add any new file to SHELL and rename CACHE.
const CACHE = 'wr-shell-v1';
const SHELL = ['/', '/app.js', '/style.css', '/icon.svg', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/macos.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !SHELL.includes(url.pathname)) return;
  // Fresh from the Mac when it answers within 3 seconds, otherwise the saved copy.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([fetch(e.request), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3000))]);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request)) || Response.error();
    }
  })());
});
