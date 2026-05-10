const SHELL_CACHE = 'vibrdrome-shell-v3';
const STATIC_CACHE = 'vibrdrome-static-v1';
const AUDIO_CACHE = 'vibrdrome-audio-v1';
const ART_CACHE = 'vibrdrome-art-v1';
const APP_SHELL_URL = '/index.html';
const SHELL_URLS = [APP_SHELL_URL, '/manifest.json', '/favicon.svg', '/icons/icon.svg'];
const MAX_AUDIO_CACHE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const STATIC_DESTINATIONS = new Set(['script', 'style', 'font', 'worker', 'image']);

function isCacheableStaticAsset(request, url) {
  if (request.method !== 'GET') return false;

  if (url.origin === self.location.origin) {
    return (
      STATIC_DESTINATIONS.has(request.destination) ||
      url.pathname.startsWith('/assets/') ||
      url.pathname.startsWith('/icons/') ||
      url.pathname === '/manifest.json' ||
      url.pathname === '/favicon.svg'
    );
  }

  return (
    url.origin === 'https://fonts.googleapis.com' ||
    url.origin === 'https://fonts.gstatic.com'
  );
}

async function cacheStaticResponse(request, response) {
  if (!response || !response.ok) return response;

  const cache = await caches.open(STATIC_CACHE);
  cache.put(request, response.clone());
  return response;
}

function buildAudioCacheKey(requestUrl) {
  const url = new URL(requestUrl);
  const songId = url.searchParams.get('id');
  const username = url.searchParams.get('u');
  if (!songId || !username) return null;

  const params = new URLSearchParams({
    server: url.origin,
    user: username,
    id: songId,
  });
  return `${self.location.origin}/__offline_audio__?${params.toString()}`;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(SHELL_URLS);
    })()
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  const keepCaches = [SHELL_CACHE, STATIC_CACHE, AUDIO_CACHE, ART_CACHE];
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !keepCaches.includes(k)).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // App shell — serve index.html for all SPA navigations to avoid redirect responses.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const shellRequest = new Request(APP_SHELL_URL, { cache: 'no-store' });
        const shellCache = await caches.open(SHELL_CACHE);
        const cachedShell = await shellCache.match(APP_SHELL_URL);

        try {
          const response = await fetch(shellRequest);
          if (response.ok && !response.redirected) {
            shellCache.put(APP_SHELL_URL, response.clone());
          }
          return response;
        } catch {
          if (cachedShell) return cachedShell;
          return Response.error();
        }
      })()
    );
    return;
  }

  // Built app assets and fonts — stale while revalidate for offline reload support.
  if (isCacheableStaticAsset(event.request, url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(event.request);
        const networkFetch = fetch(event.request)
          .then((response) => cacheStaticResponse(event.request, response))
          .catch(() => null);

        if (cached) {
          event.waitUntil(networkFetch);
          return cached;
        }

        const networkResponse = await networkFetch;
        return networkResponse || Response.error();
      })()
    );
    return;
  }

  // Audio streams — cache first if available (for offline playback)
  if (url.pathname.includes('/rest/stream')) {
    event.respondWith(
      (async () => {
        const cacheKey = buildAudioCacheKey(event.request.url);
        if (cacheKey) {
          const cache = await caches.open(AUDIO_CACHE);
          const cached = await cache.match(new Request(cacheKey));
          if (cached) return cached;
        }
        return fetch(event.request);
      })()
    );
    return;
  }

  // Cover art — cache first with network fallback
  if (url.pathname.includes('/rest/getCoverArt')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(ART_CACHE).then((cache) => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => new Response('', { status: 404 }));
      })
    );
    return;
  }
});

// Message handler for cache operations from the main thread
self.addEventListener('message', (event) => {
  const { type, url, requestInit } = event.data || {};

  if (type === 'CACHE_AUDIO') {
    // Download and cache an audio stream
    fetch(url, requestInit).then((response) => {
      if (response.ok) {
        caches.open(AUDIO_CACHE).then((cache) => {
          cache.put(new Request(url), response);
          // Notify client of completion
          event.source?.postMessage({ type: 'AUDIO_CACHED', url });
        });
      } else {
        event.source?.postMessage({ type: 'AUDIO_CACHE_ERROR', url, error: 'fetch failed' });
      }
    }).catch((err) => {
      event.source?.postMessage({ type: 'AUDIO_CACHE_ERROR', url, error: err.message });
    });
  }

  if (type === 'REMOVE_CACHED_AUDIO') {
    caches.open(AUDIO_CACHE).then((cache) => cache.delete(new Request(url)));
  }

  if (type === 'CLEAR_AUDIO_CACHE') {
    caches.delete(AUDIO_CACHE);
  }

  if (type === 'GET_CACHE_SIZE') {
    caches.open(AUDIO_CACHE).then(async (cache) => {
      const keys = await cache.keys();
      let totalSize = 0;
      for (const req of keys) {
        const resp = await cache.match(req);
        if (resp) {
          const blob = await resp.blob();
          totalSize += blob.size;
        }
      }
      event.source?.postMessage({ type: 'CACHE_SIZE', size: totalSize, count: keys.length });
    });
  }
});
