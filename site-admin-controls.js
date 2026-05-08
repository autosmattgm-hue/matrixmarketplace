(function () {
  function readState() {
    try {
      const store = window.MMStorage && typeof window.MMStorage.getItem === "function" ? window.MMStorage : window.localStorage;
      const raw = store.getItem("siteControlState");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function currentPage() {
    const path = String(location.pathname || "").split("/").pop() || "index.html";
    return path.toLowerCase();
  }

  function isAdminLikePage(page) {
    return page === "owner-console.html" ||
      page.indexOf("admin-") === 0 ||
      page === "dashboard-admin.html";
  }

  function ensureBannerRoot() {
    let root = document.getElementById("mmSiteControlRoot");
    if (root) return root;
    root = document.createElement("div");
    root.id = "mmSiteControlRoot";
    document.body.appendChild(root);
    return root;
  }

  function injectStyles() {
    if (document.getElementById("mmSiteControlStyles")) return;
    const style = document.createElement("style");
    style.id = "mmSiteControlStyles";
    style.textContent = [
      "#mmSiteControlRoot{position:fixed;inset:0;pointer-events:none;z-index:5000;font-family:Segoe UI,Tahoma,Geneva,Verdana,sans-serif;}",
      ".mm-site-banner{position:fixed;left:12px;right:12px;top:12px;display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding:12px 14px;border-radius:16px;border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 50px rgba(2,6,23,.28);backdrop-filter:blur(10px);pointer-events:auto;}",
      ".mm-site-banner.info{background:rgba(15,23,42,.92);color:#e2e8f0;}",
      ".mm-site-banner.success{background:rgba(6,95,70,.92);color:#ecfdf5;}",
      ".mm-site-banner.warning{background:rgba(120,53,15,.94);color:#fff7ed;}",
      ".mm-site-banner.danger{background:rgba(127,29,29,.94);color:#fef2f2;}",
      ".mm-site-banner strong{display:block;font-size:14px;margin-bottom:2px;}",
      ".mm-site-banner span{display:block;font-size:13px;line-height:1.45;opacity:.95;}",
      ".mm-site-banner small{display:block;font-size:12px;opacity:.8;margin-top:4px;}",
      ".mm-site-banner button{border:0;border-radius:999px;padding:8px 12px;background:rgba(255,255,255,.12);color:inherit;cursor:pointer;font:inherit;font-weight:700;}",
      ".mm-site-overlay{position:fixed;inset:0;background:rgba(2,6,23,.78);display:grid;place-items:center;padding:18px;pointer-events:auto;}",
      ".mm-site-overlay-card{width:min(560px,100%);background:rgba(15,23,42,.96);border:1px solid rgba(148,163,184,.24);border-radius:22px;padding:22px;color:#e2e8f0;box-shadow:0 30px 80px rgba(2,6,23,.45);}",
      ".mm-site-overlay-card h2{margin:0 0 8px;font-size:24px;}",
      ".mm-site-overlay-card p{margin:0 0 12px;line-height:1.6;color:#cbd5e1;}",
      ".mm-site-overlay-card .mm-site-contact{color:#67e8f9;font-weight:700;}",
      ".mm-site-lock{opacity:.55;filter:grayscale(.12);}",
      "@media (max-width:720px){.mm-site-banner{left:8px;right:8px;top:8px;padding:10px 12px;}.mm-site-overlay-card{padding:18px;border-radius:18px;}}"
    ].join("");
    document.head.appendChild(style);
  }

  function clearRoot(root) {
    while (root.firstChild) root.removeChild(root.firstChild);
  }

  function applySiteControl() {
    const state = readState();
    if (!state) return;
    const page = currentPage();
    const adminLike = isAdminLikePage(page);
    const root = ensureBannerRoot();
    injectStyles();
    clearRoot(root);

    if (state.announcementEnabled && (state.announcementTitle || state.announcementMessage)) {
      const banner = document.createElement("section");
      banner.className = "mm-site-banner " + (state.announcementTone || "info");
      banner.innerHTML =
        '<div>' +
        '<strong>' + escapeHtml(state.announcementTitle || "MatrixMarket notice") + '</strong>' +
        '<span>' + escapeHtml(state.announcementMessage || "") + '</span>' +
        (state.supportContact ? '<small>Support: ' + escapeHtml(state.supportContact) + '</small>' : '') +
        '</div>' +
        '<button type="button" aria-label="Dismiss notice">Hide</button>';
      banner.querySelector("button").addEventListener("click", function () {
        banner.remove();
      });
      root.appendChild(banner);
    }

    if (!adminLike && state.maintenanceMode) {
      const overlay = document.createElement("div");
      overlay.className = "mm-site-overlay";
      overlay.innerHTML =
        '<div class="mm-site-overlay-card">' +
        '<h2>' + escapeHtml(state.announcementTitle || "Marketplace Maintenance") + '</h2>' +
        '<p>' + escapeHtml(state.announcementMessage || "The website is temporarily paused while the owner performs updates. Please check back shortly.") + '</p>' +
        (state.supportContact ? '<p class="mm-site-contact">Support: ' + escapeHtml(state.supportContact) + '</p>' : "") +
        '</div>';
      root.appendChild(overlay);
      document.documentElement.classList.add("mm-site-lock");
    } else {
      document.documentElement.classList.remove("mm-site-lock");
    }

    if (!adminLike && state.checkoutLocked && ["cart.html", "checkout.html", "payment-proceed.html", "payment-account.html", "payment-accept.html"].includes(page)) {
      const overlay = document.createElement("div");
      overlay.className = "mm-site-overlay";
      overlay.innerHTML =
        '<div class="mm-site-overlay-card">' +
        '<h2>Checkout Temporarily Locked</h2>' +
        '<p>' + escapeHtml(state.announcementMessage || "Checkout is temporarily locked by the owner team. Please return later or contact support.") + '</p>' +
        (state.supportContact ? '<p class="mm-site-contact">Support: ' + escapeHtml(state.supportContact) + '</p>' : "") +
        '</div>';
      root.appendChild(overlay);
    }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function start() {
    applySiteControl();
    window.addEventListener("storage", applySiteControl);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
