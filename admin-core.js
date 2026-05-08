(function () {
  const WITHDRAWAL_CHARGE_PER_10 = 2;
  const BUYER_SCOPE_PREFIX = "__mm_buyer__";
  const ADMIN_OPERATORS_KEY = "adminOperators";
  const ADMIN_LIVE_SESSIONS_KEY = "adminLiveSessions";
  const CURRENT_ADMIN_SESSION_KEY = "currentAdminSession";
  const OWNER_SESSION_KEY = "mmOwnerConsoleSession";
  const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
  const ADMIN_GUARD_STYLE_ID = "mm-admin-guard-style";
  let adminGuardBound = false;

  function storageRef() {
    if (window.MMStorage && typeof window.MMStorage.getItem === "function") return window.MMStorage;
    try {
      if (window.localStorage && typeof window.localStorage.getItem === "function") return window.localStorage;
    } catch (_) {}
    return null;
  }

  function parseDeepJSON(raw, fallback) {
    if (raw == null || raw === "") return fallback;
    let value = raw;
    for (let i = 0; i < 3; i += 1) {
      if (typeof value !== "string") break;
      const trimmed = value.trim();
      if (!trimmed) return fallback;
      try {
        value = JSON.parse(trimmed);
      } catch (_) {
        return i === 0 ? fallback : value;
      }
    }
    return value == null ? fallback : value;
  }

  function readRaw(key) {
    const store = storageRef();
    if (!store) return null;
    try {
      return store.getItem(String(key));
    } catch (_) {
      return null;
    }
  }

  function writeRaw(key, value) {
    const store = storageRef();
    if (!store) return false;
    try {
      store.setItem(String(key), String(value == null ? "" : value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function balanceMirrorKey(email) {
    return "userBalanceByEmail:" + cleanEmail(email);
  }

  function syncBalanceMirror(email, amount) {
    const target = cleanEmail(email);
    if (!target) return false;
    return writeRaw(balanceMirrorKey(target), String(num(amount)));
  }

  function listStorageKeys() {
    const store = storageRef();
    if (!store) return [];

    if (typeof store.keys === "function") {
      try {
        const rows = store.keys();
        if (Array.isArray(rows)) return rows.map(function (key) { return String(key); });
      } catch (_) {}
    }

    const out = [];
    const seen = new Set();
    const total = Number(store.length);
    if (!Number.isInteger(total) || total <= 0 || typeof store.key !== "function") return out;
    for (let i = 0; i < total; i += 1) {
      try {
        const key = store.key(i);
        if (key == null) continue;
        const next = String(key);
        if (!seen.has(next)) {
          seen.add(next);
          out.push(next);
        }
      } catch (_) {}
    }
    return out;
  }

  function sameOrderId(a, b) {
    const left = String(a == null ? "" : a).trim().toLowerCase();
    const right = String(b == null ? "" : b).trim().toLowerCase();
    return Boolean(left) && Boolean(right) && left === right;
  }

  function addUniqueKey(list, key) {
    const next = String(key == null ? "" : key).trim();
    if (!next) return;
    if (!list.includes(next)) list.push(next);
  }

  function isBuyerOrderStorageKey(key) {
    const target = String(key == null ? "" : key).trim();
    if (!target) return false;
    if (target === "buyerOrders") return true;
    if (target.indexOf("buyerOrdersByEmail:") === 0) return true;
    if (target.indexOf("buyerOrdersByPhone:") === 0) return true;
    return target.indexOf(BUYER_SCOPE_PREFIX) === 0 && target.indexOf("__buyerOrders") > 0;
  }

  function orderRowId(row) {
    return str(row && (row.id || row.orderId || row.orderNumber) || "");
  }

  function orderTs(row) {
    const a = new Date(row && (row.updatedAt || row.placedAt || row.createdAt || row.date) || "").getTime();
    return Number.isFinite(a) ? a : 0;
  }

  function findOrderStorageKeys(extra) {
    const keys = [];
    addUniqueKey(keys, "buyerOrders");
    (Array.isArray(extra) ? extra : []).forEach(function (key) { addUniqueKey(keys, key); });
    listStorageKeys().forEach(function (key) {
      if (isBuyerOrderStorageKey(key)) addUniqueKey(keys, key);
    });
    return keys;
  }

  function patchOrderRowsInKey(storageKey, orderId, nextStatus, updatedAt) {
    const rows = readJSON(storageKey, null);
    if (!Array.isArray(rows) || !rows.length) return false;
    let changed = false;
    const nextRows = rows.map(function (row) {
      if (!sameOrderId(orderRowId(row), orderId)) return row;
      changed = true;
      return { ...row, status: nextStatus, updatedAt: updatedAt };
    });
    if (!changed) return false;
    return writeJSON(storageKey, nextRows);
  }

  function patchSnapshotsByOrderId(orderId, nextStatus, updatedAt) {
    const mapKeys = ["orderLineSnapshots"];
    listStorageKeys().forEach(function (key) {
      if (key.indexOf(BUYER_SCOPE_PREFIX) === 0 && key.endsWith("__orderLineSnapshots")) addUniqueKey(mapKeys, key);
    });

    let changed = false;
    mapKeys.forEach(function (storageKey) {
      const map = readJSON(storageKey, null);
      if (!map || typeof map !== "object" || Array.isArray(map)) return;
      const hitKey = Object.keys(map).find(function (key) { return sameOrderId(key, orderId); });
      if (!hitKey || !map[hitKey] || typeof map[hitKey] !== "object") return;
      map[hitKey] = { ...map[hitKey], status: nextStatus, updatedAt: updatedAt };
      if (writeJSON(storageKey, map)) changed = true;
    });

    const directKeys = ["orderItemsById:" + orderId];
    listStorageKeys().forEach(function (key) {
      if (key.indexOf(BUYER_SCOPE_PREFIX) !== 0) return;
      const tail = key.split("__orderItemsById:")[1];
      if (sameOrderId(tail, orderId)) addUniqueKey(directKeys, key);
    });
    directKeys.forEach(function (storageKey) {
      const row = readJSON(storageKey, null);
      if (!row || typeof row !== "object" || Array.isArray(row)) return;
      const next = { ...row, status: nextStatus, updatedAt: updatedAt };
      if (writeJSON(storageKey, next)) changed = true;
    });

    return changed;
  }

  function patchQueueByOrderId(orderId, nextStatus, updatedAt) {
    const queues = readJSON("sellerOrderQueues", {});
    if (!queues || typeof queues !== "object") return false;
    let changed = false;
    Object.keys(queues).forEach(function (queueKey) {
      const rows = Array.isArray(queues[queueKey]) ? queues[queueKey] : [];
      queues[queueKey] = rows.map(function (row) {
        const id = str(row && (row.orderId || row.id || row.orderNumber) || "");
        if (!sameOrderId(id, orderId)) return row;
        changed = true;
        return { ...row, status: nextStatus, updatedAt: updatedAt };
      });
    });
    if (!changed) return false;
    return writeJSON("sellerOrderQueues", queues);
  }

  function patchPurchasesByOrderId(orderId, nextStatus, updatedAt) {
    const rows = readJSON("purchases", []);
    if (!Array.isArray(rows) || !rows.length) return false;
    let changed = false;
    const nextRows = rows.map(function (row) {
      const id = str(row && (row.orderId || row.id || row.orderNumber) || "");
      if (!sameOrderId(id, orderId)) return row;
      changed = true;
      return { ...row, status: nextStatus, updatedAt: updatedAt };
    });
    if (!changed) return false;
    return writeJSON("purchases", nextRows);
  }

  function findOrderById(orderId) {
    const all = getOrders();
    return all.find(function (row) { return sameOrderId(orderRowId(row), orderId); }) || null;
  }

  function readJSON(key, fallback) {
    return parseDeepJSON(readRaw(key), fallback);
  }

  function writeJSON(key, value) {
    writeRaw(key, JSON.stringify(value));
  }

  function toArray(value, opts) {
    if (Array.isArray(value)) return value.slice();
    if (!value || typeof value !== "object") return [];

    const options = opts || {};
    return Object.keys(value).map(function (key) {
      const row = value[key];
      if (row && typeof row === "object") {
        const next = { ...row };
        if (options.injectEmail && !next.email && !next.mail && key.indexOf("@") >= 0) next.email = key;
        if (options.injectName && !next.name && !next.fullName) next.name = key;
        if (options.injectId && !next.id) next.id = key;
        return next;
      }
      if (options.injectEmail && key.indexOf("@") >= 0) return { email: key, value: row };
      if (options.injectId) return { id: key, value: row };
      return { value: row };
    });
  }

  function normalizeRequestRows(raw) {
    let rows = raw;
    if (typeof rows === "string") {
      try { rows = JSON.parse(rows); } catch (_) { rows = []; }
    }
    if (Array.isArray(rows)) return rows.slice();
    if (rows && typeof rows === "object") {
      return Object.keys(rows).map(function (key) {
        const row = rows[key];
        if (row && typeof row === "object") {
          const next = { ...row };
          if (!next.id) next.id = key;
          return next;
        }
        return { id: key, value: row };
      });
    }
    return [];
  }

  function deepField(source, key, fallback) {
    let current = source;
    for (let i = 0; i < 8; i += 1) {
      if (!current || typeof current !== "object") break;
      if (Object.prototype.hasOwnProperty.call(current, key)) {
        const value = current[key];
        if (value != null && value !== "") return value;
      }
      current = current.raw;
    }
    return fallback;
  }

  function flattenRaw(source) {
    let current = source;
    let merged = {};
    for (let i = 0; i < 8; i += 1) {
      if (!current || typeof current !== "object") break;
      const layer = { ...current };
      delete layer.raw;
      merged = { ...layer, ...merged };
      current = current.raw;
    }
    return merged;
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function str(v) {
    return String(v == null ? "" : v).trim();
  }

  function fmtMoney(v) {
    return num(v).toFixed(2) + " GMD";
  }

  function fmtDate(v) {
    if (!v) return "-";
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
  }

  function cleanEmail(v) {
    return str(v).toLowerCase();
  }

  function roundMoney(v) {
    return Math.round(num(v) * 100) / 100;
  }

  function withdrawalCharge(amount) {
    return roundMoney((num(amount) / 10) * WITHDRAWAL_CHARGE_PER_10);
  }

  function withdrawalNet(amount) {
    return roundMoney(Math.max(0, num(amount) - withdrawalCharge(amount)));
  }

  function statusClass(status) {
    const s = str(status).toLowerCase();
    if (["approved", "paid", "active", "success"].includes(s)) return "approved";
    if (["declined", "rejected", "inactive", "suspended", "cancelled", "failed"].includes(s)) return "declined";
    if (["pending", "processing"].includes(s)) return "pending";
    return "info";
  }

  function badge(status) {
    const s = str(status) || "Unknown";
    return '<span class="badge ' + statusClass(s) + '">' + s + "</span>";
  }

  function log(action, details) {
    const logs = getAuditLogs();
    logs.unshift({
      id: "LOG-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      action: str(action),
      details: details || {},
      at: new Date().toISOString()
    });
    writeJSON("adminAuditLogs", logs.slice(0, 1500));
  }

  function normalizeEntity(raw, role, idx) {
    const source = raw && typeof raw === "object" ? raw : {};
    const base = flattenRaw(source);
    const email = cleanEmail(deepField(source, "email", deepField(source, "mail", "")));
    const accountType = str(deepField(source, "accountType", deepField(source, "role", role || "user"))) || role;
    const isSeller = Boolean(deepField(source, "isSeller", false)) || accountType === "seller" || role === "seller";
    return {
      id: deepField(source, "id", role.toUpperCase() + "-" + idx),
      role: role,
      accountType: accountType,
      isSeller: isSeller,
      fullName: str(deepField(source, "fullName", deepField(source, "name", email || role))),
      name: str(deepField(source, "name", deepField(source, "fullName", email || role))),
      email: email,
      password: str(deepField(source, "password", "")),
      phone: str(deepField(source, "phone", "")),
      address: str(deepField(source, "address", "")),
      country: str(deepField(source, "country", "Unknown")),
      category: str(deepField(source, "category", deepField(source, "shopCategory", "general"))),
      plan: str(deepField(source, "plan", role === "seller" ? "basic" : "n/a")),
      store: str(deepField(source, "store", deepField(source, "shopName", deepField(source, "storeName", "")))),
      balance: num(deepField(source, "balance", 0)),
      status: str(deepField(source, "status", "Pending")),
      paymentStatus: str(deepField(source, "paymentStatus", "Pending")),
      subscription: str(deepField(source, "subscription", "Inactive")),
      proof: str(deepField(source, "proof", "")),
      createdAt: deepField(source, "createdAt", deepField(source, "date", new Date().toISOString())),
      raw: base
    };
  }

  function denormalizeEntity(entity) {
    const raw = flattenRaw(entity.raw || {});
    raw.id = entity.id;
    raw.role = entity.role;
    raw.accountType = entity.accountType || entity.role;
    raw.isSeller = Boolean(entity.isSeller || entity.role === "seller");
    raw.fullName = entity.fullName;
    raw.name = entity.name;
    raw.email = entity.email;
    raw.password = entity.password;
    raw.phone = entity.phone;
    raw.address = entity.address;
    raw.country = entity.country;
    raw.category = entity.category;
    raw.plan = entity.plan;
    raw.store = entity.store;
    raw.balance = entity.balance;
    raw.status = entity.status;
    raw.paymentStatus = entity.paymentStatus;
    raw.subscription = entity.subscription;
    raw.proof = entity.proof;
    raw.createdAt = entity.createdAt;
    return raw;
  }

  function getUsers() {
    const users = readJSON("users", []);
    return toArray(users, { injectEmail: true, injectId: true }).map(function (u, i) {
      return normalizeEntity(u, "user", i);
    });
  }

  function getSellers() {
    const sellers = readJSON("sellers", []);
    return toArray(sellers, { injectEmail: true, injectName: true, injectId: true }).map(function (s, i) {
      return normalizeEntity(s, "seller", i);
    });
  }

  function setUsers(users) {
    const output = users.map(denormalizeEntity);
    writeJSON("users", output);
  }

  function setSellers(sellers) {
    const output = sellers.map(denormalizeEntity);
    writeJSON("sellers", output);
  }

  function getProducts() {
    const products = readJSON("products", []);
    return toArray(products, { injectId: true });
  }

  function setProducts(products) {
    writeJSON("products", products);
  }

  function getPayments() {
    const payments = readJSON("pendingRequests", []);
    return toArray(normalizeRequestRows(payments), { injectEmail: true, injectId: true });
  }

  function requestRowTs(row) {
    const direct = new Date(row && (row.updatedAt || row.createdAt || row.date || "")).getTime();
    if (Number.isFinite(direct) && direct > 0) return direct;
    const fallback = num(row && row.id);
    return fallback > 1000000000 ? fallback : 0;
  }

  function statusWeight(status) {
    const s = str(status).toLowerCase();
    if (s === "approved" || s === "paid" || s === "success") return 3;
    if (s === "declined" || s === "cancelled" || s === "canceled") return 2;
    if (s === "pending" || !s) return 1;
    return 0;
  }

  function mergePaymentRows(baseRows, nextRows) {
    const map = new Map();
    toArray(baseRows, { injectEmail: true, injectId: true }).forEach(function (row, idx) {
      const key = str(row && row.id) || ("row:" + idx);
      map.set(key, row && typeof row === "object" ? { ...row } : row);
    });

    toArray(nextRows, { injectEmail: true, injectId: true }).forEach(function (row, idx) {
      const key = str(row && row.id) || ("row:" + idx);
      const prev = map.get(key);
      if (!prev || typeof prev !== "object" || !row || typeof row !== "object") {
        map.set(key, row);
        return;
      }
      const prevWeight = statusWeight(prev.status || prev.paymentStatus || "");
      const nextWeight = statusWeight(row.status || row.paymentStatus || "");
      const prevTs = requestRowTs(prev);
      const nextTs = requestRowTs(row);
      const winner = nextWeight > prevWeight
        ? { ...prev, ...row }
        : (nextWeight < prevWeight
          ? { ...row, ...prev }
          : (nextTs >= prevTs ? { ...prev, ...row } : { ...row, ...prev }));
      map.set(key, winner);
    });

    return Array.from(map.values()).sort(function (a, b) {
      return requestRowTs(b) - requestRowTs(a);
    });
  }

  function setPayments(payments) {
    const current = readJSON("pendingRequests", []);
    writeJSON("pendingRequests", mergePaymentRows(current, payments));
  }

  function getOrders() {
    const keys = findOrderStorageKeys();
    const gathered = [];

    keys.forEach(function (storageKey) {
      const rows = readJSON(storageKey, null);
      if (!Array.isArray(rows)) return;
      rows.forEach(function (row, index) {
        if (!row || typeof row !== "object") return;
        const next = { ...row };
        if (!next.id) {
          const fallbackId = str(next.orderId || next.orderNumber || "");
          if (fallbackId) next.id = fallbackId;
        }
        next.__sourceKey = storageKey;
        next.__sourceIndex = index;
        gathered.push(next);
      });
    });

    if (!gathered.length) {
      const legacy = readJSON("buyerOrders", []);
      return toArray(legacy, { injectId: true });
    }

    const deduped = new Map();
    gathered.forEach(function (row, index) {
      const id = orderRowId(row);
      const emailKey = cleanEmail(row.email || row.buyerEmail || "");
      const phoneKey = str(row.phone || row.buyerPhone || "");
      const dateKey = str(row.placedAt || row.createdAt || row.date || row.updatedAt || "");
      const dedupeKey = id
        ? ("id:" + id.toLowerCase())
        : ("anon:" + emailKey + "|" + phoneKey + "|" + dateKey + "|" + index);

      const prev = deduped.get(dedupeKey);
      if (!prev) {
        deduped.set(dedupeKey, row);
        return;
      }
      const merged = orderTs(row) >= orderTs(prev)
        ? { ...prev, ...row }
        : { ...row, ...prev };
      deduped.set(dedupeKey, merged);
    });

    return Array.from(deduped.values()).sort(function (a, b) {
      return orderTs(b) - orderTs(a);
    });
  }

  function setOrders(orders) {
    writeJSON("buyerOrders", orders);
  }

  function getPurchases() {
    const purchases = readJSON("purchases", []);
    return toArray(purchases, { injectId: true });
  }

  function getCodes() {
    const codes = readJSON("assignedCodes", {});
    return codes && typeof codes === "object" ? codes : {};
  }

  function setCodes(codes) {
    writeJSON("assignedCodes", codes);
  }

  function getAuditLogs() {
    const logs = readJSON("adminAuditLogs", []);
    return toArray(logs, { injectId: true });
  }

  function getAllAccounts() {
    return getUsers().concat(getSellers());
  }

  function saveAccount(record) {
    const role = record.role === "seller" ? "seller" : "user";
    const email = cleanEmail(record.email);
    const users = getUsers();
    const sellers = getSellers();

    function upsert(list, roleName) {
      const idx = list.findIndex(function (item) { return cleanEmail(item.email) === email; });
      const normalized = normalizeEntity({ ...(record.raw || {}), ...record, email: email }, roleName, idx < 0 ? list.length : idx);
      if (idx >= 0) list[idx] = normalized;
      else list.push(normalized);
      return list;
    }

    if (role === "seller") {
      setUsers(users.filter(function (u) { return cleanEmail(u.email) !== email; }));
      setSellers(upsert(sellers.filter(function (s) { return cleanEmail(s.email) !== email; }), "seller"));
    } else {
      setSellers(sellers.filter(function (s) { return cleanEmail(s.email) !== email; }));
      setUsers(upsert(users.filter(function (u) { return cleanEmail(u.email) !== email; }), "user"));
    }
    syncBalanceMirror(email, record.balance);
  }

  function updateAccountByEmail(email, patch) {
    const target = cleanEmail(email);
    let changed = false;

    const users = getUsers().map(function (u) {
      if (cleanEmail(u.email) !== target) return u;
      changed = true;
      return normalizeEntity({ ...u, ...patch, email: target }, "user", 0);
    });

    const sellers = getSellers().map(function (s) {
      if (cleanEmail(s.email) !== target) return s;
      changed = true;
      return normalizeEntity({ ...s, ...patch, email: target }, "seller", 0);
    });

    if (changed) {
      setUsers(users);
      setSellers(sellers);
      const account = findAccount(target);
      if (account) syncBalanceMirror(account.email, account.balance);
      return true;
    }

    return false;
  }

  function deleteAccount(email) {
    const target = cleanEmail(email);
    const users = getUsers();
    const sellers = getSellers();
    const nextUsers = users.filter(function (u) { return cleanEmail(u.email) !== target; });
    const nextSellers = sellers.filter(function (s) { return cleanEmail(s.email) !== target; });
    const changed = nextUsers.length !== users.length || nextSellers.length !== sellers.length;
    if (changed) {
      setUsers(nextUsers);
      setSellers(nextSellers);
    }
    return changed;
  }

  function updateSessionAccount(email, patch) {
    const target = cleanEmail(email);
    if (!target || !patch || typeof patch !== "object") return false;
    let changed = false;
    ["currentUser", "currentSeller", "loggedInUser"].forEach(function (key) {
      const row = readJSON(key, null);
      if (!row || typeof row !== "object") return;
      if (cleanEmail(row.email || row.mail || "") !== target) return;
      writeJSON(key, { ...row, ...patch, email: target });
      changed = true;
    });
    return changed;
  }

  function resetAccountPassword(email, nextPassword) {
    const target = cleanEmail(email);
    const password = str(nextPassword);
    if (!target || !password) return false;
    const changed = updateAccountByEmail(target, {
      password: password,
      updatedAt: new Date().toISOString()
    });
    if (!changed) return false;
    updateSessionAccount(target, {
      password: password,
      updatedAt: new Date().toISOString()
    });
    log("account_password_reset", { email: target });
    return true;
  }

  function clearLiveSessions() {
    let changed = false;
    ["currentUser", "currentSeller", "loggedInUser", CURRENT_ADMIN_SESSION_KEY].forEach(function (key) {
      const existing = readRaw(key);
      if (existing == null) return;
      try {
        storageRef().removeItem(key);
        changed = true;
      } catch (_) {}
    });
    if (readRaw(ADMIN_LIVE_SESSIONS_KEY) != null) {
      try {
        storageRef().removeItem(ADMIN_LIVE_SESSIONS_KEY);
        changed = true;
      } catch (_) {}
    }
    if (changed) log("live_sessions_cleared", {});
    return changed;
  }

  function clearNonAdminVisitorSessions() {
    let changed = false;
    ["currentUser", "currentSeller", "loggedInUser"].forEach(function (key) {
      const existing = readRaw(key);
      if (existing == null) return;
      try {
        storageRef().removeItem(key);
        changed = true;
      } catch (_) {}
    });
    if (changed) {
      log("non_admin_session_cleared_for_admin_gate", { page: currentPageName() });
    }
    return changed;
  }

  function findAccount(email) {
    const target = cleanEmail(email);
    return getAllAccounts().find(function (a) { return cleanEmail(a.email) === target; }) || null;
  }

  function adjustBalance(email, amount) {
    const target = cleanEmail(email);
    if (!target || !Number.isFinite(num(amount))) return false;
    const account = findAccount(target);
    if (!account) return false;
    const next = Math.max(0, num(account.balance) + num(amount));
    account.balance = next;
    saveAccount(account);
    return true;
  }

  function paymentTimestamp(row) {
    const direct = new Date(row && (row.updatedAt || row.createdAt || row.date || "")).getTime();
    if (Number.isFinite(direct) && direct > 0) return direct;
    const fallback = num(row && row.id);
    return fallback > 1000000000 ? fallback : 0;
  }

  function approveLatestTopupRequest(email) {
    const target = cleanEmail(email);
    if (!target) return 0;
    const payments = getPayments();
    if (!Array.isArray(payments) || !payments.length) return 0;

    let matchIndex = -1;
    let bestStamp = -1;
    for (let i = 0; i < payments.length; i += 1) {
      const row = payments[i] || {};
      if (cleanEmail(row.email || "") !== target) continue;
      const type = str(row.type || row.requestType || row.plan || "").toLowerCase();
      if (type.indexOf("top") < 0) continue;
      if (row.walletCreditedAt) continue;
      const stamp = paymentTimestamp(row);
      if (stamp >= bestStamp) {
        bestStamp = stamp;
        matchIndex = i;
      }
    }

    if (matchIndex < 0) return 0;
    const row = { ...payments[matchIndex] };
    const amount = Math.max(0, num(row.amount));
    if (amount <= 0) return 0;
    if (!adjustBalance(target, amount)) return 0;

    row.status = "Approved";
    row.paymentStatus = "Paid";
    row.updatedAt = new Date().toISOString();
    row.walletCreditedAt = row.updatedAt;
    payments[matchIndex] = row;
    setPayments(payments);
    return amount;
  }

  function applyPaymentDecision(target, decision) {
    const payments = getPayments();
    const rawTarget = str(target);
    let index = -1;
    if (rawTarget && !/^\d+$/.test(rawTarget)) {
      index = payments.findIndex(function (row) { return str(row && row.id) === rawTarget; });
    }
    if (index < 0) {
      const fallbackIndex = Number(target);
      index = Number.isInteger(fallbackIndex) && fallbackIndex >= 0 ? fallbackIndex : -1;
    }
    if (index < 0 || !payments[index]) return false;

    const row = { ...payments[index] };
    const prevStatus = str(row.status || "Pending");
    const normalized = decision === "Approved" ? "Approved" : (decision === "Declined" ? "Declined" : "Pending");
    const typeLower = str(row.type || "").toLowerCase();
    const isSubscription = typeLower.includes("subscription");
    const isTopup = typeLower.includes("top");
    const isWithdrawal = typeLower.includes("withdraw");
    const email = cleanEmail(row.email || "");

    row.status = normalized;
    row.updatedAt = new Date().toISOString();

    if (email) {
      const patch = {};
      if (normalized === "Approved") {
        if (isSubscription) {
          patch.paymentStatus = "Paid";
          patch.status = "Approved";
          patch.subscription = "Active";
        } else {
          patch.paymentStatus = "Paid";
        }

        if (isTopup) {
          if (!row.walletCreditedAt) {
            adjustBalance(email, num(row.amount));
            row.walletCreditedAt = new Date().toISOString();
          }
        }

        if (isWithdrawal) {
          const account = findAccount(email);
          const amount = num(row.amount);
          if (!account || num(account.balance) < amount) {
            row.status = "Declined";
            row.adminNote = "Declined automatically: insufficient seller balance at approval time.";
            patch.paymentStatus = "Declined";
          } else {
            const charge = row.charge > 0 ? roundMoney(row.charge) : withdrawalCharge(amount);
            const netAmount = row.netAmount > 0 ? roundMoney(row.netAmount) : withdrawalNet(amount);
            row.charge = charge;
            row.netAmount = netAmount;
            row.approvedAt = new Date().toISOString();
            row.status = "Approved";
            if (!row.walletDebitedAt) {
              adjustBalance(email, -amount);
              row.walletDebitedAt = new Date().toISOString();
            }
          }
        }
      }

      if (normalized === "Declined") {
        patch.paymentStatus = "Declined";
        if (isSubscription) {
          patch.subscription = "Inactive";
        }
      }

      if (Object.keys(patch).length) {
        updateAccountByEmail(email, patch);
      }
    }

    payments[index] = row;
    setPayments(payments);

    log("payment_status_changed", {
      index: index,
      email: email,
      from: prevStatus,
      to: row.status,
      amount: num(row.amount),
      charge: num(row.charge || 0),
      netAmount: num(row.netAmount || 0),
      type: row.type || "n/a"
    });

    return true;
  }

  function resolveOrderIdTarget(target) {
    const raw = str(target);
    if (raw && !/^\d+$/.test(raw)) return raw;
    const index = Number(target);
    if (Number.isInteger(index) && index >= 0) {
      const rows = getOrders();
      if (rows[index]) {
        const fromRow = orderRowId(rows[index]);
        if (fromRow) return fromRow;
      }
    }
    return raw;
  }

  function updateOrderStatus(target, status) {
    const orderId = resolveOrderIdTarget(target);
    if (!orderId) return false;

    const nextStatus = str(status || "pending");
    const updatedAt = new Date().toISOString();
    const prevRow = findOrderById(orderId);
    const prevStatus = str(prevRow && prevRow.status || "pending");

    const extraKeys = [];
    const byEmail = cleanEmail(prevRow && (prevRow.email || prevRow.buyerEmail) || "");
    const byPhone = str(prevRow && (prevRow.phone || prevRow.buyerPhone) || "").replace(/\D+/g, "");
    if (byEmail) addUniqueKey(extraKeys, "buyerOrdersByEmail:" + byEmail);
    if (byPhone) addUniqueKey(extraKeys, "buyerOrdersByPhone:" + byPhone);

    let changed = false;
    findOrderStorageKeys(extraKeys).forEach(function (storageKey) {
      if (patchOrderRowsInKey(storageKey, orderId, nextStatus, updatedAt)) changed = true;
    });
    if (patchQueueByOrderId(orderId, nextStatus, updatedAt)) changed = true;
    if (patchPurchasesByOrderId(orderId, nextStatus, updatedAt)) changed = true;
    if (patchSnapshotsByOrderId(orderId, nextStatus, updatedAt)) changed = true;
    if (!changed) return false;

    log("order_status_changed", {
      target: target,
      id: orderId,
      from: prevStatus,
      to: nextStatus
    });

    return true;
  }

  function upsertCode(email, codeData) {
    const codes = getCodes();
    const target = cleanEmail(email);
    codes[target] = {
      value: str(codeData.value || codes[target]?.value || "").toUpperCase(),
      expiry: codeData.expiry || codes[target]?.expiry || new Date(Date.now() + 30 * 86400000).toISOString(),
      status: str(codeData.status || "active")
    };
    setCodes(codes);

    const seller = findAccount(target);
    if (seller && seller.role === "seller") {
      seller.subscription = "Active";
      seller.status = "Approved";
      seller.paymentStatus = "Paid";
      saveAccount(seller);
    }

    log("code_upserted", { email: target, code: codes[target].value, expiry: codes[target].expiry });
    return codes[target];
  }

  function removeCode(email) {
    const codes = getCodes();
    const target = cleanEmail(email);
    if (!codes[target]) return false;
    delete codes[target];
    setCodes(codes);

    const seller = findAccount(target);
    if (seller && seller.role === "seller") {
      seller.subscription = "Inactive";
      seller.paymentStatus = "Unpaid";
      saveAccount(seller);
    }

    log("code_removed", { email: target });
    return true;
  }

  function computeDashboard() {
    const users = getUsers();
    const sellers = getSellers();
    const payments = getPayments();
    const orders = getOrders();
    const products = getProducts();

    const pendingPayments = payments.filter(function (p) {
      return str(p.status || "pending").toLowerCase() === "pending";
    }).length;

    const approvedPayments = payments.filter(function (p) {
      return str(p.status || "").toLowerCase() === "approved";
    }).length;

    const totalBalance = users.concat(sellers).reduce(function (sum, acc) {
      return sum + num(acc.balance);
    }, 0);

    const orderPending = orders.filter(function (o) { return str(o.status || "pending").toLowerCase() === "pending"; }).length;
    const orderCompleted = orders.filter(function (o) { return ["completed", "approved", "delivered"].includes(str(o.status).toLowerCase()); }).length;

    const bySeller = {};
    products.forEach(function (p) {
      const key = str(p.seller || p.sellerName || p.sellerEmail || "Unknown");
      bySeller[key] = (bySeller[key] || 0) + 1;
    });

    const topSeller = Object.keys(bySeller).sort(function (a, b) { return bySeller[b] - bySeller[a]; })[0] || "N/A";

    return {
      users: users.length,
      sellers: sellers.length,
      products: products.length,
      payments: payments.length,
      pendingPayments: pendingPayments,
      approvedPayments: approvedPayments,
      orders: orders.length,
      orderPending: orderPending,
      orderCompleted: orderCompleted,
      totalBalance: totalBalance,
      topSeller: topSeller,
      auditLogs: getAuditLogs().length
    };
  }

  function getSiteSnapshot() {
    return {
      generatedAt: new Date().toISOString(),
      dashboard: computeDashboard(),
      users: getUsers(),
      sellers: getSellers(),
      adminOperators: getAdminOperators(),
      adminSessions: getAdminLiveSessions(),
      products: getProducts(),
      payments: getPayments(),
      orders: getOrders(),
      purchases: getPurchases(),
      codes: getCodes(),
      logs: getAuditLogs(),
      notifications: readJSON("adminNotifications", []),
      supportTickets: readJSON("supportTickets", []),
      sellerComplaints: readJSON("sellerComplaints", []),
      chatThreads: readJSON("chatThreads", {}),
      siteControl: readJSON("siteControlState", null),
      lastLoginMeta: readJSON("lastLoginMeta", null)
    };
  }

  function getSiteControl() {
    const state = readJSON("siteControlState", null);
    const source = state && typeof state === "object" ? state : {};
    return {
      maintenanceMode: Boolean(source.maintenanceMode),
      checkoutLocked: Boolean(source.checkoutLocked),
      announcementEnabled: Boolean(source.announcementEnabled),
      announcementTone: str(source.announcementTone || "info") || "info",
      announcementTitle: str(source.announcementTitle || ""),
      announcementMessage: str(source.announcementMessage || ""),
      supportContact: str(source.supportContact || ""),
      updatedAt: source.updatedAt || ""
    };
  }

  function setSiteControl(patch) {
    const prev = getSiteControl();
    const next = {
      ...prev,
      ...(patch && typeof patch === "object" ? patch : {}),
      maintenanceMode: Boolean(patch && patch.maintenanceMode),
      checkoutLocked: Boolean(patch && patch.checkoutLocked),
      announcementEnabled: Boolean(patch && patch.announcementEnabled),
      announcementTone: str(patch && patch.announcementTone || prev.announcementTone || "info") || "info",
      announcementTitle: str(patch && patch.announcementTitle || ""),
      announcementMessage: str(patch && patch.announcementMessage || ""),
      supportContact: str(patch && patch.supportContact || ""),
      updatedAt: new Date().toISOString()
    };
    writeJSON("siteControlState", next);
    log("site_control_updated", next);
    return next;
  }

  function restoreSiteSnapshot(snapshot) {
    const data = snapshot && typeof snapshot === "object" ? snapshot : null;
    if (!data) return false;

    if (Array.isArray(data.users)) setUsers(data.users.map(function (row, idx) {
      return normalizeEntity(row, "user", idx);
    }));
    if (Array.isArray(data.sellers)) setSellers(data.sellers.map(function (row, idx) {
      return normalizeEntity(row, "seller", idx);
    }));
    if (Array.isArray(data.adminOperators)) setAdminOperators(data.adminOperators);
    if (Array.isArray(data.adminSessions)) setAdminLiveSessions(data.adminSessions);
    if (Array.isArray(data.products)) setProducts(data.products);
    if (Array.isArray(data.payments)) setPayments(data.payments);
    if (Array.isArray(data.orders)) setOrders(data.orders);
    if (Array.isArray(data.purchases)) writeJSON("purchases", data.purchases);
    if (data.codes && typeof data.codes === "object") setCodes(data.codes);
    if (Array.isArray(data.logs)) writeJSON("adminAuditLogs", data.logs);
    if (Array.isArray(data.notifications)) writeJSON("adminNotifications", data.notifications);
    if (Array.isArray(data.supportTickets)) writeJSON("supportTickets", data.supportTickets);
    if (Array.isArray(data.sellerComplaints)) writeJSON("sellerComplaints", data.sellerComplaints);
    if (data.chatThreads && typeof data.chatThreads === "object") writeJSON("chatThreads", data.chatThreads);
    if (data.siteControl && typeof data.siteControl === "object") writeJSON("siteControlState", data.siteControl);
    if (data.lastLoginMeta && typeof data.lastLoginMeta === "object") writeJSON("lastLoginMeta", data.lastLoginMeta);

    log("site_snapshot_restored", {
      generatedAt: str(data.generatedAt || ""),
      restoredAt: new Date().toISOString()
    });
    return true;
  }

  function exportCSV(rows, filename) {
    const safeRows = Array.isArray(rows) ? rows : [];
    if (!safeRows.length) return false;
    const headers = Object.keys(safeRows[0]);
    const csv = [headers.join(",")].concat(
      safeRows.map(function (row) {
        return headers.map(function (h) {
          const cell = row[h] == null ? "" : String(row[h]).replace(/"/g, '""');
          return '"' + cell + '"';
        }).join(",");
      })
    ).join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename || "export.csv";
    link.click();
    URL.revokeObjectURL(url);
    return true;
  }

  function exportJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename || "export.json";
    link.click();
    URL.revokeObjectURL(url);
    return true;
  }

  function createCode(length) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let output = "";
    for (let i = 0; i < (length || 8); i += 1) {
      output += chars[Math.floor(Math.random() * chars.length)];
    }
    return output;
  }

  function currentPageName() {
    const path = String(location.pathname || "").split(/[\\/]/).pop();
    return path || "index.html";
  }

  function normalizeAdminOperator(raw, idx) {
    const source = raw && typeof raw === "object" ? raw : {};
    const email = cleanEmail(source.email || source.mail || "");
    const fallbackSeed = str(source.fullName || source.name || email || ("admin-" + idx))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return {
      id: str(source.id || ("ADM-" + (fallbackSeed || ("admin-" + idx)))).toUpperCase(),
      fullName: str(source.fullName || source.name || email || "Admin"),
      name: str(source.name || source.fullName || email || "Admin"),
      email: email,
      password: str(source.password || ""),
      status: str(source.status || "active") || "active",
      createdAt: source.createdAt || new Date().toISOString(),
      updatedAt: source.updatedAt || "",
      lastLoginAt: source.lastLoginAt || "",
      lastLoginPage: str(source.lastLoginPage || ""),
      lastSeenAt: source.lastSeenAt || "",
      notes: str(source.notes || "")
    };
  }

  function getAdminOperators() {
    const rows = readJSON(ADMIN_OPERATORS_KEY, []);
    let changed = false;
    const normalized = toArray(rows, { injectEmail: true, injectId: true }).map(function (row, idx) {
      const admin = normalizeAdminOperator(row, idx);
      if (!row || typeof row !== "object") {
        changed = true;
      } else if (
        str(row.id || "").toUpperCase() !== admin.id ||
        cleanEmail(row.email || row.mail || "") !== admin.email ||
        str(row.password || "") !== admin.password ||
        str(row.status || "active") !== admin.status
      ) {
        changed = true;
      }
      return admin;
    });
    if (changed) setAdminOperators(normalized);
    return normalized;
  }

  function setAdminOperators(rows) {
    const list = (Array.isArray(rows) ? rows : []).map(function (row, idx) {
      const admin = normalizeAdminOperator(row, idx);
      return {
        id: admin.id,
        fullName: admin.fullName,
        name: admin.name,
        email: admin.email,
        password: admin.password,
        status: admin.status,
        createdAt: admin.createdAt,
        updatedAt: admin.updatedAt,
        lastLoginAt: admin.lastLoginAt,
        lastLoginPage: admin.lastLoginPage,
        lastSeenAt: admin.lastSeenAt,
        notes: admin.notes
      };
    });
    writeJSON(ADMIN_OPERATORS_KEY, list);
    return list;
  }

  function findAdminOperator(target) {
    const needle = str(target);
    const emailNeedle = cleanEmail(target);
    return getAdminOperators().find(function (row) {
      return row.id === needle ||
        (emailNeedle && row.email === emailNeedle) ||
        str(row.fullName).toLowerCase() === needle.toLowerCase() ||
        str(row.name).toLowerCase() === needle.toLowerCase();
    }) || null;
  }

  function generateAdminPassword(length) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz";
    const total = Math.max(10, Math.floor(num(length || 12)));
    let output = "";
    for (let i = 0; i < total; i += 1) {
      output += chars[Math.floor(Math.random() * chars.length)];
    }
    return output;
  }

  function createAdminOperator(input) {
    const data = input && typeof input === "object" ? input : {};
    const email = cleanEmail(data.email || "");
    const fullName = str(data.fullName || data.name || email || "");
    if (!email || !fullName) return { ok: false, error: "Admin name and email are required." };
    const existing = getAdminOperators();
    if (existing.some(function (row) { return row.email === email; })) {
      return { ok: false, error: "That admin email already exists." };
    }
    const now = new Date().toISOString();
    const password = str(data.password || generateAdminPassword(12));
    const next = normalizeAdminOperator({
      id: "ADM-" + Date.now().toString(36).toUpperCase(),
      fullName: fullName,
      name: fullName,
      email: email,
      password: password,
      status: "active",
      createdAt: now,
      updatedAt: now,
      notes: str(data.notes || "")
    }, existing.length);
    existing.push(next);
    setAdminOperators(existing);
    log("admin_operator_created", { email: email, adminId: next.id });
    return { ok: true, admin: next };
  }

  function updateAdminOperator(target, patch) {
    const list = getAdminOperators();
    const needle = str(target);
    const emailNeedle = cleanEmail(target);
    const idx = list.findIndex(function (row) {
      return row.id === needle || (emailNeedle && row.email === emailNeedle);
    });
    if (idx < 0) return false;
    const current = list[idx];
    const nextEmail = cleanEmail((patch && patch.email) || current.email);
    if (nextEmail && list.some(function (row, rowIdx) { return rowIdx !== idx && row.email === nextEmail; })) {
      return false;
    }
    list[idx] = normalizeAdminOperator({
      ...current,
      ...(patch && typeof patch === "object" ? patch : {}),
      email: nextEmail || current.email,
      updatedAt: new Date().toISOString()
    }, idx);
    setAdminOperators(list);
    return list[idx];
  }

  function deleteAdminOperator(target) {
    const needle = str(target);
    const emailNeedle = cleanEmail(target);
    const list = getAdminOperators();
    const next = list.filter(function (row) {
      return !(row.id === needle || (emailNeedle && row.email === emailNeedle));
    });
    if (next.length === list.length) return false;
    setAdminOperators(next);
    revokeAdminSessionsForAdmin(target, "admin_deleted");
    log("admin_operator_deleted", { target: target });
    return true;
  }

  function normalizeAdminSession(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      token: str(source.token || ""),
      adminId: str(source.adminId || ""),
      email: cleanEmail(source.email || ""),
      fullName: str(source.fullName || source.name || source.email || "Admin"),
      loginSource: str(source.loginSource || source.source || ""),
      loginAt: source.loginAt || source.createdAt || new Date().toISOString(),
      lastSeenAt: source.lastSeenAt || source.loginAt || new Date().toISOString(),
      lastPage: str(source.lastPage || source.page || ""),
      expiresAt: source.expiresAt || new Date(Date.now() + ADMIN_SESSION_MS).toISOString(),
      status: str(source.status || "active") || "active"
    };
  }

  function isOwnerSessionActive() {
    const session = readJSON(OWNER_SESSION_KEY, null);
    if (!session || !session.active) return false;
    const expiresAt = new Date(session.expiresAt || "").getTime();
    return !Number.isFinite(expiresAt) || expiresAt <= 0 || expiresAt > Date.now();
  }

  function setAdminLiveSessions(rows) {
    writeJSON(ADMIN_LIVE_SESSIONS_KEY, (Array.isArray(rows) ? rows : []).map(normalizeAdminSession));
  }

  function getAdminLiveSessions() {
    const source = readJSON(ADMIN_LIVE_SESSIONS_KEY, []);
    const sessions = toArray(source, { injectId: false }).map(normalizeAdminSession);
    const admins = getAdminOperators();
    const validIds = new Set(admins.filter(function (row) {
      return str(row.status).toLowerCase() === "active";
    }).map(function (row) { return row.id; }));
    const validEmails = new Set(admins.filter(function (row) {
      return str(row.status).toLowerCase() === "active";
    }).map(function (row) { return cleanEmail(row.email); }).filter(Boolean));
    const now = Date.now();
    let changed = false;
    const filtered = sessions.filter(function (session) {
      const expiresAt = new Date(session.expiresAt || "").getTime();
      const active = session.token &&
        session.loginSource === "admin-login.html" &&
        session.status === "active" &&
        (validIds.has(session.adminId) || validEmails.has(cleanEmail(session.email))) &&
        (!Number.isFinite(expiresAt) || expiresAt > now);
      if (!active) changed = true;
      return active;
    });
    if (changed) setAdminLiveSessions(filtered);
    return filtered.sort(function (a, b) {
      return String(b.lastSeenAt || b.loginAt || "").localeCompare(String(a.lastSeenAt || a.loginAt || ""));
    });
  }

  function recordCurrentAdminToken(token) {
    if (!token) {
      writeJSON(CURRENT_ADMIN_SESSION_KEY, null);
      try { storageRef().removeItem(CURRENT_ADMIN_SESSION_KEY); } catch (_) {}
      return;
    }
    writeJSON(CURRENT_ADMIN_SESSION_KEY, { token: token });
  }

  function getCurrentAdminSession() {
    const current = readJSON(CURRENT_ADMIN_SESSION_KEY, null);
    const token = str(current && current.token || "");
    if (!token) return null;
    const session = getAdminLiveSessions().find(function (row) { return row.token === token; }) || null;
    if (!session) {
      recordCurrentAdminToken("");
      return null;
    }
    const admin = findAdminOperator(session.adminId) || findAdminOperator(session.email);
    if (!admin || str(admin.status).toLowerCase() !== "active") {
      recordCurrentAdminToken("");
      return null;
    }
    return { ...session, admin: admin };
  }

  function touchCurrentAdminSession(page) {
    const current = getCurrentAdminSession();
    if (!current) return null;
    const sessions = getAdminLiveSessions();
    const idx = sessions.findIndex(function (row) { return row.token === current.token; });
    if (idx < 0) return current;
    const nowIso = new Date().toISOString();
    sessions[idx] = normalizeAdminSession({
      ...sessions[idx],
      lastSeenAt: nowIso,
      lastPage: str(page || sessions[idx].lastPage || ""),
      expiresAt: new Date(Date.now() + ADMIN_SESSION_MS).toISOString()
    });
    setAdminLiveSessions(sessions);
    updateAdminOperator(current.admin.id, {
      lastSeenAt: nowIso,
      lastLoginPage: sessions[idx].lastPage
    });
    return { ...sessions[idx], admin: findAdminOperator(current.admin.id) };
  }

  function authenticateAdmin(identifier, password, page) {
    const needle = str(identifier).trim().toLowerCase();
    const pass = str(password).trim();
    if (!needle || !pass) return { ok: false, error: "Admin email and password are required." };
    const admin = getAdminOperators().find(function (row) {
      return row.email === cleanEmail(needle) ||
        str(row.fullName).toLowerCase() === needle ||
        str(row.name).toLowerCase() === needle;
    }) || null;
    if (!admin) return { ok: false, error: "Admin account not found." };
    if (str(admin.status).toLowerCase() !== "active") return { ok: false, error: "This admin account is disabled." };
    if (admin.password !== pass) return { ok: false, error: "Wrong admin password." };

    const nowIso = new Date().toISOString();
    const session = normalizeAdminSession({
      token: "ADMSESS-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
      adminId: admin.id,
      email: admin.email,
      fullName: admin.fullName || admin.name || admin.email,
      loginSource: "admin-login.html",
      loginAt: nowIso,
      lastSeenAt: nowIso,
      lastPage: str(page || ""),
      expiresAt: new Date(Date.now() + ADMIN_SESSION_MS).toISOString(),
      status: "active"
    });
    const sessions = getAdminLiveSessions().filter(function (row) {
      return row.adminId !== admin.id;
    });
    sessions.unshift(session);
    setAdminLiveSessions(sessions);
    recordCurrentAdminToken(session.token);
    writeJSON(OWNER_SESSION_KEY, null);
    try { storageRef().removeItem(OWNER_SESSION_KEY); } catch (_) {}
    updateAdminOperator(admin.id, {
      lastLoginAt: nowIso,
      lastSeenAt: nowIso,
      lastLoginPage: str(page || "")
    });
    const confirmedSession = getCurrentAdminSession();
    if (!confirmedSession) {
      return { ok: false, error: "Admin session could not be started. Please try again." };
    }
    log("admin_login", { adminId: admin.id, email: admin.email, page: str(page || "") });
    return { ok: true, admin: findAdminOperator(admin.id), session: confirmedSession };
  }

  function revokeAdminSession(token, reason, options) {
    const target = str(token);
    if (!target) return false;
    const opts = options || {};
    const sessions = getAdminLiveSessions();
    const hit = sessions.find(function (row) { return row.token === target; }) || null;
    if (!hit) return false;
    setAdminLiveSessions(sessions.filter(function (row) { return row.token !== target; }));
    const current = readJSON(CURRENT_ADMIN_SESSION_KEY, null);
    if (str(current && current.token || "") === target) recordCurrentAdminToken("");
    if (!opts.silent) {
      log("admin_session_revoked", {
        adminId: hit.adminId,
        email: hit.email,
        reason: str(reason || "manual") || "manual"
      });
    }
    return true;
  }

  function revokeAdminSessionsForAdmin(target, reason) {
    const admin = findAdminOperator(target);
    const adminId = str(admin && admin.id || target);
    const email = cleanEmail(admin && admin.email || target);
    const sessions = getAdminLiveSessions();
    const hits = sessions.filter(function (row) {
      return row.adminId === adminId || (email && row.email === email);
    });
    if (!hits.length) return false;
    setAdminLiveSessions(sessions.filter(function (row) {
      return !(row.adminId === adminId || (email && row.email === email));
    }));
    const current = readJSON(CURRENT_ADMIN_SESSION_KEY, null);
    if (hits.some(function (row) { return row.token === str(current && current.token || ""); })) {
      recordCurrentAdminToken("");
    }
    log("admin_sessions_revoked", {
      adminId: adminId,
      email: email,
      count: hits.length,
      reason: str(reason || "manual") || "manual"
    });
    return true;
  }

  function logoutCurrentAdmin(reason) {
    const current = readJSON(CURRENT_ADMIN_SESSION_KEY, null);
    const token = str(current && current.token || "");
    if (!token) return false;
    const session = getCurrentAdminSession();
    revokeAdminSession(token, reason || "logout", { silent: true });
    recordCurrentAdminToken("");
    log("admin_logout", {
      adminId: session && session.adminId || "",
      email: session && session.email || "",
      reason: str(reason || "logout") || "logout"
    });
    return true;
  }

  function logoutAdminAndGo() {
    logoutCurrentAdmin("manual");
    window.location.href = "admin-login.html";
  }

  function ensureAdminSession(redirectPath) {
    const session = touchCurrentAdminSession(currentPageName()) || getCurrentAdminSession();
    if (session) return session;
    if (redirectPath && str(redirectPath) !== currentPageName()) {
      clearNonAdminVisitorSessions();
      const next = encodeURIComponent(currentPageName() + location.search + location.hash);
      window.location.replace(redirectPath + "?next=" + next);
    }
    return null;
  }

  function isProtectedAdminPage(page) {
    const target = str(page || currentPageName());
    return [
      "dashboard-admin.html",
      "admin-users.html",
      "admin-sellers.html",
      "admin-accept-payment.html",
      "admin-edit-user-seller.html",
      "admin-code.html",
      "admin-orders.html",
      "admin-products.html",
      "admin-logs.html",
      "admin-communications.html"
    ].includes(target);
  }

  function ensureAdminGuardStyles() {
    if (!document || !document.head) return;
    if (document.getElementById(ADMIN_GUARD_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = ADMIN_GUARD_STYLE_ID;
    style.textContent = ".mm-admin-auth-pending body.admin-page{visibility:hidden}.mm-admin-auth-ready body.admin-page{visibility:visible}";
    document.head.appendChild(style);
  }

  function setAdminPageVisibility(ready) {
    if (!document || !document.documentElement) return;
    document.documentElement.classList.toggle("mm-admin-auth-pending", !ready);
    document.documentElement.classList.toggle("mm-admin-auth-ready", !!ready);
  }

  function startAdminPageGuard() {
    if (!isProtectedAdminPage()) return;
    ensureAdminGuardStyles();
    setAdminPageVisibility(false);

    function bindGuard() {
      if (!ensureAdminSession("admin-login.html")) return;
      setAdminPageVisibility(true);
      if (adminGuardBound) return;
      adminGuardBound = true;
      window.addEventListener("storage", function () {
        if (!getCurrentAdminSession()) {
          setAdminPageVisibility(false);
          window.location.replace("admin-login.html?next=" + encodeURIComponent(currentPageName()));
        }
      });
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) {
          if (ensureAdminSession("admin-login.html")) setAdminPageVisibility(true);
        }
      });
    }

    const ready = window.MMStorage && window.MMStorage.ready;
    if (ready && typeof ready.then === "function") {
      ready.finally(bindGuard);
      return;
    }
    bindGuard();
  }

  function renderAdminHeader(activePage) {
    const currentAdmin = getCurrentAdminSession();
    const ownerActive = isOwnerSessionActive() && !currentAdmin;
    const adminName = currentAdmin
      ? (currentAdmin.admin && (currentAdmin.admin.fullName || currentAdmin.admin.name)) ||
        currentAdmin.fullName ||
        currentAdmin.email ||
        "Admin"
      : "";
    const actor = ownerActive
      ? { label: "Owner", email: "owner-console" }
      : (currentAdmin
          ? {
              label: "Admin: " + adminName,
              email: currentAdmin.email || (currentAdmin.admin && currentAdmin.admin.email) || ""
            }
          : null);
    const map = (ownerActive ? [["owner-console.html", "Owner"]] : []).concat([
      ["dashboard-admin.html", "Dashboard"],
      ["admin-users.html", "Users"],
      ["admin-sellers.html", "Sellers"],
      ["admin-accept-payment.html", "Payments"],
      ["admin-edit-user-seller.html", "Accounts"],
      ["admin-code.html", "Codes"],
      ["admin-orders.html", "Orders"],
      ["admin-products.html", "Products"],
      ["admin-logs.html", "Logs"],
      ["admin-communications.html", "Comms"]
    ]);

    return (
      '<header class="admin-header">' +
      '<div class="admin-header-inner">' +
      '<div class="admin-brand">MatrixMarket Admin</div>' +
      '<nav class="admin-nav">' +
      map.map(function (item) {
        const active = item[0] === activePage ? "active" : "";
        return '<a class="' + active + '" href="' + item[0] + '">' + item[1] + '</a>';
      }).join("") +
      (actor ? '<span class="admin-session-chip" title="' + str(actor.email) + '">' + str(actor.label) + '</span>' : "") +
      (activePage !== "owner-console.html" ? '<button type="button" onclick="AdminCore.logoutAdminAndGo()">Logout</button>' : "") +
      '<a href="index.html">Exit</a>' +
      '</nav>' +
      '</div>' +
      '</header>'
    );
  }

  window.AdminCore = {
    WITHDRAWAL_CHARGE_PER_10: WITHDRAWAL_CHARGE_PER_10,
    readJSON: readJSON,
    writeJSON: writeJSON,
    num: num,
    str: str,
    fmtMoney: fmtMoney,
    fmtDate: fmtDate,
    statusClass: statusClass,
    badge: badge,
    withdrawalCharge: withdrawalCharge,
    withdrawalNet: withdrawalNet,
    log: log,
    getUsers: getUsers,
    setUsers: setUsers,
    getSellers: getSellers,
    setSellers: setSellers,
    getAllAccounts: getAllAccounts,
    saveAccount: saveAccount,
    updateAccountByEmail: updateAccountByEmail,
    deleteAccount: deleteAccount,
    findAccount: findAccount,
    adjustBalance: adjustBalance,
    resetAccountPassword: resetAccountPassword,
    clearLiveSessions: clearLiveSessions,
    approveLatestTopupRequest: approveLatestTopupRequest,
    getAdminOperators: getAdminOperators,
    setAdminOperators: setAdminOperators,
    findAdminOperator: findAdminOperator,
    generateAdminPassword: generateAdminPassword,
    createAdminOperator: createAdminOperator,
    updateAdminOperator: updateAdminOperator,
    deleteAdminOperator: deleteAdminOperator,
    getAdminLiveSessions: getAdminLiveSessions,
    setAdminLiveSessions: setAdminLiveSessions,
    getCurrentAdminSession: getCurrentAdminSession,
    touchCurrentAdminSession: touchCurrentAdminSession,
    authenticateAdmin: authenticateAdmin,
    revokeAdminSession: revokeAdminSession,
    revokeAdminSessionsForAdmin: revokeAdminSessionsForAdmin,
    logoutCurrentAdmin: logoutCurrentAdmin,
    logoutAdminAndGo: logoutAdminAndGo,
    ensureAdminSession: ensureAdminSession,
    isOwnerSessionActive: isOwnerSessionActive,
    getProducts: getProducts,
    setProducts: setProducts,
    getPayments: getPayments,
    setPayments: setPayments,
    applyPaymentDecision: applyPaymentDecision,
    getOrders: getOrders,
    setOrders: setOrders,
    updateOrderStatus: updateOrderStatus,
    getPurchases: getPurchases,
    getCodes: getCodes,
    setCodes: setCodes,
    upsertCode: upsertCode,
    removeCode: removeCode,
    getAuditLogs: getAuditLogs,
    computeDashboard: computeDashboard,
    getSiteSnapshot: getSiteSnapshot,
    getSiteControl: getSiteControl,
    setSiteControl: setSiteControl,
    restoreSiteSnapshot: restoreSiteSnapshot,
    exportCSV: exportCSV,
    exportJSON: exportJSON,
    createCode: createCode,
    renderAdminHeader: renderAdminHeader
  };

  startAdminPageGuard();
})();
