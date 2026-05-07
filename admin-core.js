(function () {
  const WITHDRAWAL_CHARGE_PER_10 = 2;
  const BUYER_SCOPE_PREFIX = "__mm_buyer__";

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

  function setPayments(payments) {
    writeJSON("pendingRequests", payments);
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

  function applyPaymentDecision(index, decision) {
    const payments = getPayments();
    if (!payments[index]) return false;

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
          adjustBalance(email, num(row.amount));
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
            adjustBalance(email, -amount);
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

  function renderAdminHeader(activePage) {
    const map = [
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
    ];

    return (
      '<header class="admin-header">' +
      '<div class="admin-header-inner">' +
      '<div class="admin-brand">MatrixMarket Admin</div>' +
      '<nav class="admin-nav">' +
      map.map(function (item) {
        const active = item[0] === activePage ? "active" : "";
        return '<a class="' + active + '" href="' + item[0] + '">' + item[1] + '</a>';
      }).join("") +
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
    exportCSV: exportCSV,
    exportJSON: exportJSON,
    createCode: createCode,
    renderAdminHeader: renderAdminHeader
  };
})();
