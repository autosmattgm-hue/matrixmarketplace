(function sitePerformanceBootstrap() {
  if (window.__mmSitePerformanceLoaded) return;
  window.__mmSitePerformanceLoaded = true;

  const prefetched = new Set();
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const saveData = Boolean(connection && connection.saveData);
  const slowNetwork = Boolean(connection && /(^|-)2g$/.test(String(connection.effectiveType || "").toLowerCase()));
  const canPrefetch = !saveData && !slowNetwork;

  function normalizeHref(href) {
    if (!href) return "";
    try {
      return new URL(href, location.href).href;
    } catch (_) {
      return "";
    }
  }

  function isSameOriginDocument(href) {
    const normalized = normalizeHref(href);
    if (!normalized) return false;
    try {
      const url = new URL(normalized);
      if (url.origin !== location.origin) return false;
      if (url.hash && url.pathname === location.pathname && !url.search) return false;
      const path = String(url.pathname || "").toLowerCase();
      if (!path || path.endsWith("/")) return true;
      return path.endsWith(".html");
    } catch (_) {
      return false;
    }
  }

  function getImageFetchPriority(img) {
    try {
      const rect = img.getBoundingClientRect();
      const fold = (window.innerHeight || 800) * 1.2;
      return rect.top >= 0 && rect.top <= fold ? "high" : "low";
    } catch (_) {
      return "low";
    }
  }

  function tuneImage(img) {
    if (!(img instanceof HTMLImageElement)) return;
    if (!img.hasAttribute("decoding")) img.decoding = "async";
    if (!img.hasAttribute("loading")) {
      img.loading = getImageFetchPriority(img) === "high" ? "eager" : "lazy";
    }
    if (!img.hasAttribute("fetchpriority")) {
      img.fetchPriority = img.loading === "eager" ? "high" : "low";
    }
  }

  function tuneImages(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    if (root instanceof HTMLImageElement) tuneImage(root);
    const imgs = root.querySelectorAll("img");
    for (let i = 0; i < imgs.length; i += 1) tuneImage(imgs[i]);
  }

  function prefetchDocument(href) {
    if (!canPrefetch) return;
    const normalized = normalizeHref(href);
    if (!normalized || prefetched.has(normalized)) return;
    if (!isSameOriginDocument(normalized)) return;

    prefetched.add(normalized);
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.as = "document";
    link.href = normalized;
    document.head.appendChild(link);
  }

  function warmLikelyLinks() {
    if (!canPrefetch) return;
    const anchors = document.querySelectorAll("a[href]");
    let count = 0;
    for (let i = 0; i < anchors.length && count < 8; i += 1) {
      const href = anchors[i].getAttribute("href");
      if (!isSameOriginDocument(href)) continue;
      prefetchDocument(href);
      count += 1;
    }
  }

  function onLinkIntent(event) {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    const anchor = target.closest("a[href]");
    if (!anchor) return;
    prefetchDocument(anchor.getAttribute("href"));
  }

  function bindImageObserver() {
    if (!("MutationObserver" in window)) return;
    const observer = new MutationObserver(function (entries) {
      for (let i = 0; i < entries.length; i += 1) {
        const added = entries[i].addedNodes;
        for (let j = 0; j < added.length; j += 1) {
          const node = added[j];
          if (!node || node.nodeType !== 1) continue;
          tuneImages(node);
        }
      }
    });

    function start() {
      if (!document.body) {
        setTimeout(start, 60);
        return;
      }
      observer.observe(document.body, { childList: true, subtree: true });
    }

    start();
  }

  function init() {
    tuneImages(document);
    bindImageObserver();
    document.addEventListener("pointerover", onLinkIntent, { capture: true, passive: true });
    document.addEventListener("focusin", onLinkIntent, true);
    if ("requestIdleCallback" in window) {
      requestIdleCallback(warmLikelyLinks, { timeout: 1600 });
    } else {
      setTimeout(warmLikelyLinks, 900);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
