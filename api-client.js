(function () {
  function str(v) {
    return String(v == null ? "" : v).trim();
  }

  function storageRef() {
    if (typeof window === "undefined") return null;
    if (window.MMStorage && typeof window.MMStorage.getItem === "function") return window.MMStorage;
    try {
      if (window.localStorage && typeof window.localStorage.getItem === "function") return window.localStorage;
    } catch (_err) {}
    return null;
  }

  function storageValue(key) {
    var store = storageRef();
    if (!store) return "";
    try {
      return str(store.getItem(key));
    } catch (_err) {
      return "";
    }
  }

  function buildBaseUrl() {
    var fromStorage = storageValue("MM_API_BASE_URL");
    if (fromStorage) return fromStorage.replace(/\/+$/, "");
    if (typeof window.MM_API_BASE_URL === "string" && window.MM_API_BASE_URL) {
      return window.MM_API_BASE_URL.replace(/\/+$/, "");
    }
    if (typeof window !== "undefined" && window.location && window.location.protocol !== "file:") {
      return window.location.origin.replace(/\/+$/, "") + "/api";
    }
    return "http://localhost:4000/api";
  }

  function isEnabled() {
    var fromStorage = storageValue("MM_API_ENABLED");
    if (fromStorage) return fromStorage === "1";
    if (typeof window.MM_API_ENABLED === "boolean") return window.MM_API_ENABLED;
    if (typeof window.MM_API_ENABLED === "string") return window.MM_API_ENABLED === "1";
    return false;
  }

  async function request(path, options) {
    var url = buildBaseUrl() + path;
    var finalOptions = Object.assign(
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json"
        }
      },
      options || {}
    );

    if (finalOptions.body && typeof finalOptions.body !== "string") {
      finalOptions.body = JSON.stringify(finalOptions.body);
    }

    var response = await fetch(url, finalOptions);
    var text = await response.text();
    var compactText = String(text || "").replace(/\s+/g, " ").trim();
    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_err) {
      data = { ok: false, error: compactText || "Invalid JSON response" };
    }

    if (!response.ok) {
      var message = data && data.error ? data.error : ("HTTP " + response.status);
      if (typeof message === "string") {
        if (/<!doctype html/i.test(message) || /<html/i.test(message)) {
          message = "API endpoint not found. Check MM_API_BASE_URL or disable API mode.";
        } else if (message.length > 220) {
          message = message.slice(0, 220) + "...";
        }
      }
      var error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  async function createOrder(orderPayload) {
    return request("/orders", {
      method: "POST",
      body: orderPayload
    });
  }

  async function getOrders(filters) {
    var params = new URLSearchParams();
    var safe = filters || {};
    if (safe.buyerEmail) params.set("buyerEmail", safe.buyerEmail);
    if (safe.buyerPhone) params.set("buyerPhone", safe.buyerPhone);
    if (safe.limit) params.set("limit", String(safe.limit));
    return request("/orders?" + params.toString());
  }

  async function getOrder(orderNumber) {
    return request("/orders/" + encodeURIComponent(orderNumber));
  }

  async function cancelOrder(orderNumber) {
    return request("/orders/" + encodeURIComponent(orderNumber) + "/cancel", {
      method: "PATCH"
    });
  }

  async function updateOrderStatus(orderNumber, status) {
    return request("/orders/" + encodeURIComponent(orderNumber) + "/status", {
      method: "PATCH",
      body: { status: status }
    });
  }

  async function health() {
    return request("/health");
  }

  window.MMApi = {
    isEnabled: isEnabled,
    baseUrl: buildBaseUrl,
    request: request,
    createOrder: createOrder,
    getOrders: getOrders,
    getOrder: getOrder,
    cancelOrder: cancelOrder,
    updateOrderStatus: updateOrderStatus,
    health: health
  };
})();

