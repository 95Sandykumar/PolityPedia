/*
 * PolityPedia service worker (issue 78-installable-app).
 *
 * It does ONE job: when a page load fails because the phone has no network, show
 * a static offline page. Nothing else.
 *
 *  - The only thing ever stored is /offline.html, at install time.
 *  - A page load is answered by the network, untouched. It is never put in the
 *    cache, so signed-in HTML never leaves the network path.
 *  - /api, assets, form posts and every non-page request are not touched at all:
 *    no respondWith, so the browser handles them as if there were no worker.
 *    Auth cookies and redirects behave exactly as before.
 *
 * Bump CACHE when /offline.html changes. Old versions are deleted on activate.
 */
var CACHE = 'politypedia-offline-v1';
var CACHE_PREFIX = 'politypedia-offline-';
var OFFLINE_URL = '/offline.html';

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.add(OFFLINE_URL);
    }),
  );
  if (self.skipWaiting) self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) {
            return key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE;
          })
          .map(function (key) {
            return caches.delete(key);
          }),
      );
    }),
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.mode !== 'navigate' || request.method !== 'GET') return;
  if (new URL(request.url).pathname.indexOf('/api/') === 0) return;

  event.respondWith(
    fetch(request).catch(function () {
      return caches.match(OFFLINE_URL);
    }),
  );
});
