/* Cyanotype service worker — network-first with a guaranteed offline floor.

   Three rules this file exists to enforce:

   1. An online visit always gets current code.
   2. A partial or failed update never costs you the working copy you already
      had. The old cache is deleted only once the new one is proven complete.
   3. The swap happens when the page says so, not mid-call.
*/

const VERSION = 'v15';
const CACHE = 'cyanotype-' + VERSION;

/* CORE must land or the install fails outright, which leaves the previous
   worker in charge and the previous cache intact. EXTRA is cosmetic — a
   missing icon is not a reason to abandon a good update. */
const CORE = ['./index.html', './', './boot.js', './vendor.js', './app.js'];
const EXTRA = ['./manifest.webmanifest', './icon-192.png', './icon-512.png'];

/* Slow-but-alive networks are the dangerous case: captive portals and a hotspot
   with no uplink both accept the connection and then stall. Waiting on that is
   indistinguishable from being broken, so cut over to cache and let the network
   finish in the background. */
const NET_TIMEOUT = 2500;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // cache:'reload' bypasses the HTTP cache, so an update is never defeated by
    // a stale max-age on index.html.
    await Promise.all(CORE.map(u => c.add(new Request(u, { cache: 'reload' }))));
    await Promise.all(EXTRA.map(u =>
      c.add(new Request(u, { cache: 'reload' })).catch(() => null)));
    // No skipWaiting here on purpose — the page decides when to swap.
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    const ready = await c.match('./index.html');
    if (ready) {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'skip-waiting') return void self.skipWaiting();
  if (e.data === 'version') {
    e.source && e.source.postMessage({ type: 'version', version: VERSION });
    return;
  }
  if (e.data === 'reset') {
    caches.keys().then(k => Promise.all(k.map(x => caches.delete(x))))
      .then(() => self.registration.unregister());
  }
});

function fromNetwork(req, cache) {
  return fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fromNetwork(req, cache);
    // Keep the request alive past the race so a slow response still refreshes
    // the cache for next time.
    e.waitUntil(net.catch(() => {}));

    const hit = await cache.match(req);
    if (!hit) return net.catch(() => cache.match('./index.html'));

    const timeout = new Promise(res => setTimeout(() => res(null), NET_TIMEOUT));
    const winner = await Promise.race([net.catch(() => null), timeout]);
    return winner || hit;
  })());
});

/* A tap on a notification. Focus the open app if there is one and tell it
   which chat to show; otherwise open the app straight onto that chat. */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const convId = e.notification.data && e.notification.data.convId;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins[0];
    if (win) {
      try { await win.focus(); } catch (err) { /* focus can be refused; still hand over */ }
      if (convId) win.postMessage({ type: 'open', convId });
      return;
    }
    await self.clients.openWindow(convId ? './?open=' + encodeURIComponent(convId) : './');
  })());
});
