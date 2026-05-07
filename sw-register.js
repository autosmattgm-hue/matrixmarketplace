(function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:" && location.hostname !== "localhost") return;

  function sendWarmHint(worker) {
    if (!worker || typeof worker.postMessage !== "function") return;
    worker.postMessage({
      type: "WARM_CACHE",
      urls: [
        "./index.html",
        "./shop.html",
        "./cart.html",
        "./checkout.html",
        "./buyers-orders.html",
      ],
    });
  }

  function boot() {
    navigator.serviceWorker.register("./service-worker.js").then(function (registration) {
      if (registration.active) sendWarmHint(registration.active);
      registration.addEventListener("updatefound", function () {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", function () {
          if (installing.state === "activated") {
            sendWarmHint(registration.active || installing);
          }
        });
      });
    }).catch(function () {
      // Ignore registration failures to avoid impacting page behavior.
    });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    boot();
    return;
  }
  window.addEventListener("DOMContentLoaded", boot, { once: true });
})();
