const CACHE_VERSION = "v20260510k";
const STATIC_CACHE = `matrixmarket-static-${CACHE_VERSION}`;
const PAGE_CACHE = `matrixmarket-pages-${CACHE_VERSION}`;
const DATA_CACHE = `matrixmarket-data-${CACHE_VERSION}`;
const OFFLINE_FALLBACK_URL = "./index.html";
const CACHE_LIMITS = {
  [STATIC_CACHE]: 80,
  [PAGE_CACHE]: 30,
  [DATA_CACHE]: 50,
};

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./shop.html",
  "./cart.html",
  "./checkout.html",
  "./buyers-orders.html",
  "./matrix-market-ai.html",
  "./style.css",
  "./upgrade.css",
  "./index-home.css?v=20260509m",
  "./index-home.js?v=20260510a",
  "./firebase-online-storage.js?v=20260224c",
  "./seller-core.js?v=20260510i",
  "./admin-core.js?v=20260509q",
  "./owner-console.html",
  "./site-admin-controls.js?v=20260510b",
  "./site-performance.js",
  "./site-performance.js?v=20260510b",
  "./sw-register.js",
  "./sw-register.js?v=20260228a",
  "./matrixx.png",
];

const STATIC_DESTINATIONS = new Set(["style", "script", "image", "font", "worker"]);
const DATA_HOST_HINTS = [
  "matrixmarket-f72e0-default-rtdb.firebaseio.com",
  "firebaseio.com"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(async (cache) => {
      await cache.addAll(PRECACHE_URLS);
      await self.skipWaiting();
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== STATIC_CACHE && name !== PAGE_CACHE && name !== DATA_CACHE).map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (!/^https?:$/.test(url.protocol)) return;

  const isDocument = request.mode === "navigate" || request.destination === "document";
  const isStatic = STATIC_DESTINATIONS.has(request.destination);
  const isDataRequest = isLikelyDataRequest(request, url);

  if (isDocument) {
    event.respondWith(networkFirst(request, PAGE_CACHE, { timeoutMs: 2500, offlineFallbackUrl: OFFLINE_FALLBACK_URL }));
    return;
  }

  if (isStatic) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE, { maxEntries: CACHE_LIMITS[STATIC_CACHE] }));
    return;
  }

  if (isDataRequest) {
    event.respondWith(networkFirst(request, DATA_CACHE, { timeoutMs: 2500, maxEntries: CACHE_LIMITS[DATA_CACHE] }));
    return;
  }
});

self.addEventListener("message", (event) => {
  const data = event && event.data;
  if (!data || data.type !== "WARM_CACHE" || !Array.isArray(data.urls)) return;
  event.waitUntil(warmCacheUrls(data.urls));
});

async function warmCacheUrls(urls) {
  const cache = await caches.open(PAGE_CACHE);
  const tasks = [];
  for (let i = 0; i < urls.length; i += 1) {
    const raw = String(urls[i] || "").trim();
    if (!raw) continue;
    tasks.push(
      fetch(new Request(raw, { method: "GET", credentials: "same-origin" }))
        .then((response) => {
          if (!response || !response.ok) return null;
          return cache.put(raw, response.clone());
        })
        .catch(() => null)
    );
  }
  await Promise.all(tasks);
  await trimCache(PAGE_CACHE, CACHE_LIMITS[PAGE_CACHE]);
}

async function networkFirst(request, cacheName, options) {
  const cache = await caches.open(cacheName);
  const timeoutMs = Math.max(0, Number(options && options.timeoutMs) || 0);
  const networkRequest = fetch(request);
  const networkPromise = timeoutMs > 0 ? withTimeout(networkRequest, timeoutMs) : networkRequest;
  try {
    const response = await networkPromise;
    if (response && response.ok) {
      cache.put(request, response.clone());
      if (options && options.maxEntries) await trimCache(cacheName, options.maxEntries);
    }
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;

    const fallback = options && options.offlineFallbackUrl ? await caches.match(options.offlineFallbackUrl, { ignoreSearch: true }) : null;
    if (fallback) return fallback;

    return new Response("Offline", {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

async function staleWhileRevalidate(request, cacheName, options) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: true });

  const networkPromise = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === "opaque")) {
        cache.put(request, response.clone());
        if (options && options.maxEntries) {
          trimCache(cacheName, options.maxEntries);
        }
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    return cached;
  }

  const networkResponse = await networkPromise;
  if (networkResponse) return networkResponse;

  return new Response("Offline", {
    status: 503,
    statusText: "Service Unavailable",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function isLikelyDataRequest(request, url) {
  if (request.destination === "document" || request.destination === "style" || request.destination === "script" || request.destination === "image") {
    return false;
  }
  const path = String(url && url.pathname || "").toLowerCase();
  if (path.endsWith(".json")) return true;
  const accept = String(request.headers.get("accept") || "").toLowerCase();
  if (accept.includes("application/json")) return true;
  return DATA_HOST_HINTS.some((hint) => String(url && url.hostname || "").toLowerCase().includes(hint));
}

async function trimCache(cacheName, maxEntries) {
  const limit = Math.max(0, Number(maxEntries) || 0);
  if (!limit) return;
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  const overflow = keys.length - limit;
  for (let i = 0; i < overflow; i += 1) {
    await cache.delete(keys[i]);
  }
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
