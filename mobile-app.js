(function mobileAppBootstrap() {
  var APP_NAME = "MatrixMarket User";
  var APP_ICON = "icons/apple-touch-icon.png";
  var MANIFEST_HREF = "app.webmanifest";
  var DISMISS_KEY = "mmInstallPromptDismissedAt";
  var DISMISS_MS = 3 * 24 * 60 * 60 * 1000;
  var PROMPT_ID = "mmInstallPrompt";
  var STYLE_ID = "mmInstallPromptStyles";
  var deferredPrompt = null;
  var promptDismissed = false;

  function isLocalHost() {
    return location.hostname === "localhost" || location.hostname === "127.0.0.1";
  }

  function canUseServiceWorker() {
    return "serviceWorker" in navigator && (location.protocol === "https:" || isLocalHost());
  }

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
  }

  function isSafari() {
    var ua = navigator.userAgent;
    return /safari/i.test(ua) && !/chrome|crios|fxios|edgios|android/i.test(ua);
  }

  function recentlyDismissed() {
    try {
      var stamp = Number(localStorage.getItem(DISMISS_KEY) || 0);
      return Boolean(stamp) && (Date.now() - stamp) < DISMISS_MS;
    } catch (_) {
      return false;
    }
  }

  function rememberDismissal() {
    promptDismissed = true;
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch (_) {}
  }

  function ensureHeadTags() {
    var head = document.head;
    if (!head) return;

    function ensureMeta(name, content) {
      var meta = head.querySelector('meta[name="' + name + '"]');
      if (!meta) {
        meta = document.createElement("meta");
        meta.name = name;
        head.appendChild(meta);
      }
      meta.content = content;
    }

    function ensureLink(rel, href) {
      var link = head.querySelector('link[rel="' + rel + '"]');
      if (!link) {
        link = document.createElement("link");
        link.rel = rel;
        head.appendChild(link);
      }
      link.href = href;
    }

    ensureLink("manifest", MANIFEST_HREF);
    ensureLink("apple-touch-icon", APP_ICON);
    ensureMeta("theme-color", "#0f172a");
    ensureMeta("apple-mobile-web-app-capable", "yes");
    ensureMeta("apple-mobile-web-app-status-bar-style", "default");
    ensureMeta("apple-mobile-web-app-title", APP_NAME);
    ensureMeta("mobile-web-app-capable", "yes");
    ensureMeta("application-name", APP_NAME);
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "#" + PROMPT_ID + "{" +
      "position:fixed;left:50%;bottom:1rem;transform:translateX(-50%);z-index:5000;" +
      "width:min(560px,calc(100% - 1rem));display:flex;align-items:center;gap:.85rem;" +
      "padding:.9rem 1rem;border-radius:20px;border:1px solid rgba(148,163,184,.22);" +
      "background:rgba(15,23,42,.96);color:#f8fafc;box-shadow:0 24px 60px rgba(2,6,23,.35);" +
      "backdrop-filter:blur(14px);font-family:Inter,system-ui,sans-serif}" +
      "#" + PROMPT_ID + ".hidden{display:none}" +
      "#" + PROMPT_ID + " img{width:56px;height:56px;border-radius:16px;object-fit:cover;flex:0 0 auto}" +
      "#" + PROMPT_ID + " .mm-install-copy{flex:1 1 auto;min-width:0}" +
      "#" + PROMPT_ID + " .mm-install-copy strong{display:block;font-size:1rem;margin-bottom:.18rem}" +
      "#" + PROMPT_ID + " .mm-install-copy span{display:block;color:#cbd5e1;font-size:.84rem;line-height:1.45}" +
      "#" + PROMPT_ID + " .mm-install-actions{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap}" +
      "#" + PROMPT_ID + " button{border:0;border-radius:999px;padding:.7rem 1rem;font-weight:800;cursor:pointer}" +
      "#" + PROMPT_ID + " .mm-install-primary{background:#0ea5e9;color:#fff}" +
      "#" + PROMPT_ID + " .mm-install-secondary{background:rgba(148,163,184,.16);color:#e2e8f0}" +
      "#" + PROMPT_ID + " .mm-install-close{background:transparent;color:#94a3b8;padding:.35rem .55rem;font-size:1.1rem;line-height:1}" +
      "@media (max-width:640px){" +
      "#" + PROMPT_ID + "{left:.5rem;right:.5rem;bottom:.5rem;transform:none;width:auto;align-items:flex-start}" +
      "#" + PROMPT_ID + "{padding:.85rem}" +
      "#" + PROMPT_ID + " img{width:50px;height:50px}" +
      "#" + PROMPT_ID + " .mm-install-actions{width:100%}" +
      "#" + PROMPT_ID + " .mm-install-primary,#" + PROMPT_ID + " .mm-install-secondary{flex:1 1 0}" +
      "}";
    document.head.appendChild(style);
  }

  function removePrompt() {
    var node = document.getElementById(PROMPT_ID);
    if (node) node.remove();
  }

  function shouldShowPrompt() {
    if (promptDismissed || isStandalone() || recentlyDismissed()) return false;
    if (deferredPrompt) return true;
    return isIos() && isSafari();
  }

  function promptMessage() {
    if (deferredPrompt) {
      return {
        title: "Install User App",
        body: "Download the user marketplace app for faster shopping, checkout, orders, and account access on your phone.",
        primary: "Install",
        secondary: "Later"
      };
    }
    return {
      title: "Add User App To Home Screen",
      body: "On iPhone, tap Share in Safari, then choose Add to Home Screen to install the user app with the MatrixMarket icon.",
      primary: "Got It",
      secondary: "Later"
    };
  }

  function showPrompt() {
    if (!document.body || !shouldShowPrompt()) return;
    ensureStyles();

    var existing = document.getElementById(PROMPT_ID);
    if (existing) existing.remove();

    var copy = promptMessage();
    var root = document.createElement("aside");
    root.id = PROMPT_ID;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-live", "polite");
    root.innerHTML =
      '<img src="' + APP_ICON + '" alt="' + APP_NAME + ' app icon" />' +
      '<div class="mm-install-copy">' +
      '<strong>' + copy.title + '</strong>' +
      '<span>' + copy.body + '</span>' +
      "</div>" +
      '<div class="mm-install-actions">' +
      '<button type="button" class="mm-install-secondary" data-action="secondary">' + copy.secondary + "</button>" +
      '<button type="button" class="mm-install-primary" data-action="primary">' + copy.primary + "</button>" +
      '<button type="button" class="mm-install-close" aria-label="Close install prompt" data-action="close">&times;</button>' +
      "</div>";

    root.addEventListener("click", function (event) {
      var action = event.target && event.target.getAttribute("data-action");
      if (!action) return;
      if (action === "close" || action === "secondary") {
        rememberDismissal();
        removePrompt();
        return;
      }
      if (!deferredPrompt) {
        rememberDismissal();
        removePrompt();
        return;
      }

      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(function () {
        deferredPrompt = null;
        rememberDismissal();
        removePrompt();
      });
    });

    document.body.appendChild(root);
  }

  function registerWorker() {
    if (!canUseServiceWorker()) return;
    navigator.serviceWorker.register("./service-worker.js").catch(function () {
      // Silent fail so app install UI still works.
    });
  }

  ensureHeadTags();
  registerWorker();

  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    deferredPrompt = event;
    showPrompt();
  });

  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    promptDismissed = true;
    removePrompt();
  });

  function bootPrompt() {
    window.setTimeout(showPrompt, 1200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootPrompt, { once: true });
  } else {
    bootPrompt();
  }
})();
