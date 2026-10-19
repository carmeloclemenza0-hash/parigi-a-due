/* Service worker: tiene una copia del sito sul telefono, così si apre anche senza rete.
 * Strategia "prima la rete": con connessione arriva sempre la versione aggiornata;
 * se la rete manca o è troppo lenta (metro, roaming) si usa la copia salvata.
 * Cambiare CACHE_VERSION quando si aggiunge o rinomina un file in PRECACHE. */
const CACHE_VERSION = 'parigi-v6';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './vendor/supabase.js',
  './memories-api.js',
  './memories.js',
  './icons/icon.svg',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './img/noi.jpg',
  './img/cartolina.jpg',
  './fonts/cormorant-garamond-500.woff2',
  './fonts/cormorant-garamond-500-italic.woff2',
  './fonts/caveat-500.woff2'
];
// Oltre questo tempo una rete "appesa" conta come assente.
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function fetchWithTimeout(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Rete troppo lenta')), NETWORK_TIMEOUT_MS);
    fetch(request).then(response => { clearTimeout(timer); resolve(response); }, error => { clearTimeout(timer); reject(error); });
  });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  // Solo i file di questo sito: mappe e siti ufficiali passano direttamente.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    try {
      const response = await fetchWithTimeout(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch (networkError) {
      // La pagina può essere chiesta come "./", "index.html" o con "#giorno-3": stessa copia.
      const cached = await cache.match(request, { ignoreSearch: true })
        || (request.mode === 'navigate' ? await cache.match('./index.html') : undefined);
      if (cached) return cached;
      throw networkError;
    }
  })());
});
