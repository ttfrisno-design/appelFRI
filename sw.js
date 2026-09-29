// Service worker : l'application s'ouvre même sans réseau.
// Les échanges avec le serveur Apps Script (autre domaine) ne passent
// pas par ici : ils sont gérés par js/api.js (cache + file d'attente).
const VERSION = 'fri-appel-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/appel.css',
  './js/config.js',
  './js/api.js',
  './js/app.js',
  './icons/logo.jpg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('fri-appel-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Réseau d'abord (pour recevoir les mises à jour), cache si hors connexion.
// cache: 'no-cache' : on redemande toujours au serveur si le fichier a changé,
// sans se contenter de la copie que le navigateur garde 10 minutes.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
  );
});
