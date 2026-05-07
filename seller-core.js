(function () {
  const SELLER_PAYMENT_ACCOUNT = "6785316";
  const SELLER_PAYMENT_METHODS = ["Wave", "Comcash"];
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

  function readJSON(key, fallback) {
    return parseDeepJSON(readRaw(key), fallback);
  }

  function writeJSON(key, value) {
    writeRaw(key, JSON.stringify(value));
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

  function paymentMethod(v) {
    const s = str(v).toLowerCase();
    if (s.includes("comcash")) return "Comcash";
    return "Wave";
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

  function hasActiveSubscription(seller) {
    const s = seller || {};
    const status = str(s.status || "").toLowerCase();
    const payment = str(s.paymentStatus || "").toLowerCase();
    const subscription = str(s.subscription || "").toLowerCase();
    return status === "approved" && (payment === "paid" || payment === "approved") && subscription === "active";
  }

  function isSellerSuspended(seller) {
    return str((seller && seller.status) || "").toLowerCase() === "suspended";
  }

  function canSellerPost(seller) {
    return !isSellerSuspended(seller) && hasActiveSubscription(seller);
  }

  function statusClass(status) {
    const s = str(status).toLowerCase();
    if (["approved", "paid", "active", "success", "delivered", "completed"].includes(s)) return "approved";
    if (["declined", "rejected", "inactive", "suspended", "cancelled", "failed"].includes(s)) return "declined";
    if (["pending", "processing", "in-transit", "shipped", "out-for-delivery"].includes(s)) return "pending";
    return "info";
  }

  function badge(status) {
    const s = str(status) || "Unknown";
    return '<span class="sel-badge ' + statusClass(s) + '">' + s + "</span>";
  }

  function normalizeSeller(raw, idx) {
    const source = raw && typeof raw === "object" ? raw : {};
    const base = flattenRaw(source);
    const email = cleanEmail(deepField(source, "email", deepField(source, "mail", "")));
    return {
      id: deepField(source, "id", "SELL-" + idx),
      fullName: str(deepField(source, "fullName", deepField(source, "name", email || "Seller"))),
      name: str(deepField(source, "name", deepField(source, "fullName", email || "Seller"))),
      email: email,
      phone: str(deepField(source, "phone", "")),
      store: str(deepField(source, "store", deepField(source, "shopName", deepField(source, "storeName", "")))),
      category: str(deepField(source, "category", deepField(source, "shopCategory", "general"))),
      plan: str(deepField(source, "plan", "basic")),
      amount: num(deepField(source, "amount", 0)),
      password: str(deepField(source, "password", deepField(source, "pass", deepField(source, "pwd", "")))),
      country: str(deepField(source, "country", "Unknown")),
      address: str(deepField(source, "address", "")),
      balance: num(deepField(source, "balance", 0)),
      status: str(deepField(source, "status", "Pending")),
      paymentStatus: str(deepField(source, "paymentStatus", "Pending")),
      subscription: str(deepField(source, "subscription", "Inactive")),
      proof: str(deepField(source, "proof", "")),
      isSeller: true,
      createdAt: deepField(source, "createdAt", deepField(source, "date", new Date().toISOString())),
      raw: base
    };
  }

  function denormalizeSeller(seller) {
    const raw = flattenRaw(seller.raw || {});
    raw.id = seller.id;
    raw.fullName = seller.fullName;
    raw.name = seller.name;
    raw.email = seller.email;
    raw.phone = seller.phone;
    raw.store = seller.store;
    raw.category = seller.category;
    raw.plan = seller.plan;
    raw.amount = seller.amount;
    raw.password = seller.password;
    raw.country = seller.country;
    raw.address = seller.address;
    raw.balance = seller.balance;
    raw.status = seller.status;
    raw.paymentStatus = seller.paymentStatus;
    raw.subscription = seller.subscription;
    raw.proof = seller.proof;
    raw.isSeller = true;
    raw.createdAt = seller.createdAt;
    return raw;
  }

  function getSellers() {
    const sellers = readJSON("sellers", []);
    if (Array.isArray(sellers)) {
      return sellers.map(function (s, i) { return normalizeSeller(s, i); });
    }

    if (sellers && typeof sellers === "object") {
      return Object.keys(sellers).map(function (key, i) {
        const row = sellers[key] || {};
        if (row && typeof row === "object") {
          const next = { ...row };
          if (!next.email && !next.mail && String(key).indexOf("@") >= 0) next.email = key;
          if (!next.name && !next.fullName) next.name = key;
          return normalizeSeller(next, i);
        }
        const next = String(key).indexOf("@") >= 0 ? { email: key } : { name: key };
        return normalizeSeller(next, i);
      });
    }

    return [];
  }

  function setSellers(list) {
    writeJSON("sellers", list.map(denormalizeSeller));
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

  function findSeller(email) {
    const target = cleanEmail(email);
    return getSellers().find(function (s) { return cleanEmail(s.email) === target; }) || null;
  }

  function upsertSeller(seller) {
    const target = cleanEmail(seller.email);
    const all = getSellers();
    const idx = all.findIndex(function (s) { return cleanEmail(s.email) === target; });
    const normalized = normalizeSeller({ ...(seller.raw || {}), ...seller, email: target }, idx < 0 ? all.length : idx);
    if (idx >= 0) all[idx] = normalized;
    else all.push(normalized);
    setSellers(all);
    return normalized;
  }

  function getCurrentSeller() {
    const direct = readJSON("currentSeller", null);
    if (direct && (direct.isSeller || direct.email)) {
      const fromStore = direct.email ? findSeller(direct.email) : null;
      return normalizeSeller({ ...direct, ...(fromStore || {}), isSeller: true }, 0);
    }

    const currentUser = readJSON("currentUser", null);
    if (currentUser && (currentUser.isSeller || findSeller(currentUser.email))) {
      const fromStore = currentUser.email ? findSeller(currentUser.email) : null;
      return normalizeSeller({ ...currentUser, ...(fromStore || {}), isSeller: true }, 0);
    }

    return null;
  }

  function setCurrentSeller(seller) {
    const normalized = normalizeSeller({ ...(seller || {}), isSeller: true }, 0);
    writeJSON("currentSeller", normalized);
    writeJSON("currentUser", normalized);
    return normalized;
  }

  function logoutSeller() {
    MMStorage.removeItem("currentSeller");
    const currentUser = readJSON("currentUser", null);
    if (currentUser && currentUser.isSeller) {
      MMStorage.removeItem("currentUser");
    }
  }

  function planAmount(plan) {
    const p = str(plan).toLowerCase();
    if (p.includes("week")) return 1000;
    if (p.includes("month")) return 3000;
    if (p.includes("year")) return 20500;
    return 3000;
  }

  function registerSeller(input) {
    const sellers = getSellers();
    const email = cleanEmail(input.email);
    const store = str(input.store).toLowerCase();

    if (!email || !str(input.password) || !str(input.fullName || input.name) || !store) {
      return { ok: false, error: "Missing required fields." };
    }

    if (sellers.some(function (s) { return cleanEmail(s.email) === email; })) {
      return { ok: false, error: "Email already registered." };
    }

    if (sellers.some(function (s) { return str(s.store).toLowerCase() === store; })) {
      return { ok: false, error: "Store name already taken." };
    }

    const seller = normalizeSeller({
      ...input,
      email: email,
      fullName: str(input.fullName || input.name),
      name: str(input.fullName || input.name),
      amount: planAmount(input.plan),
      status: "Pending",
      paymentStatus: "Pending",
      subscription: "Inactive",
      isSeller: true,
      createdAt: new Date().toISOString()
    }, sellers.length);

    sellers.push(seller);
    setSellers(sellers);
    setCurrentSeller(seller);
    return { ok: true, seller: seller };
  }

  function ensurePendingRequest(seller, extra) {
    const requests = normalizeRequestRows(readJSON("pendingRequests", []));
    const existing = requests.find(function (row) {
      return cleanEmail(row.email) === cleanEmail(seller.email) &&
        str(row.type || "Subscription").toLowerCase() === str((extra && extra.type) || "Subscription").toLowerCase() &&
        str(row.status || "Pending").toLowerCase() === "pending";
    });
    if (existing) {
      existing.amount = (extra && Number.isFinite(num(extra.amount))) ? num(extra.amount) : num(existing.amount || planAmount(seller.plan));
      existing.plan = str(extra && extra.plan ? extra.plan : (existing.plan || seller.plan));
      existing.method = paymentMethod((extra && extra.method) || existing.method || "Wave");
      existing.receiverAccount = SELLER_PAYMENT_ACCOUNT;
      existing.payerNumber = str(extra && extra.payerNumber ? extra.payerNumber : (existing.payerNumber || ""));
      existing.transactionId = str(extra && extra.transactionId ? extra.transactionId : (existing.transactionId || ""));
      existing.proof = str(extra && extra.proof ? extra.proof : (existing.proof || ""));
      existing.updatedAt = new Date().toISOString();
      writeJSON("pendingRequests", requests);
      return existing;
    }

    const row = {
      id: "REQ-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      name: seller.fullName,
      email: seller.email,
      store: seller.store,
      type: (extra && extra.type) || "Subscription",
      amount: (extra && Number.isFinite(num(extra.amount))) ? num(extra.amount) : planAmount(seller.plan),
      plan: seller.plan,
      method: paymentMethod((extra && extra.method) || "Wave"),
      receiverAccount: SELLER_PAYMENT_ACCOUNT,
      payerNumber: str(extra && extra.payerNumber ? extra.payerNumber : ""),
      transactionId: str(extra && extra.transactionId ? extra.transactionId : ""),
      proof: str(extra && extra.proof ? extra.proof : ""),
      status: "Pending",
      date: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };
    requests.push(row);
    writeJSON("pendingRequests", requests);
    return row;
  }

  function codeMap() {
    const codes = readJSON("assignedCodes", {});
    return codes && typeof codes === "object" ? codes : {};
  }

  function setCodeMap(codes) {
    writeJSON("assignedCodes", codes);
  }

  function createCode(length) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let output = "";
    for (let i = 0; i < (length || 8); i += 1) {
      output += chars[Math.floor(Math.random() * chars.length)];
    }
    return output;
  }

  function assignCode(email, code, expiryIso) {
    const target = cleanEmail(email);
    const codes = codeMap();
    codes[target] = {
      value: str(code || createCode(10)).toUpperCase(),
      expiry: expiryIso || new Date(Date.now() + 30 * 86400000).toISOString(),
      status: "active"
    };
    setCodeMap(codes);

    const seller = findSeller(target);
    if (seller) {
      seller.subscription = "Active";
      seller.status = "Approved";
      seller.paymentStatus = "Paid";
      upsertSeller(seller);
      if (getCurrentSeller() && cleanEmail(getCurrentSeller().email) === target) {
        setCurrentSeller(seller);
      }
    }

    return codes[target];
  }

  function getUsers() {
    const users = readJSON("users", []);
    if (Array.isArray(users)) return users;
    if (users && typeof users === "object") {
      return Object.keys(users).map(function (key) {
        const row = users[key];
        if (row && typeof row === "object") {
          const next = { ...row };
          if (!next.email && !next.mail && String(key).indexOf("@") >= 0) next.email = key;
          return next;
        }
        return { email: key, value: row };
      });
    }
    return [];
  }

  function resolveSellerPassword(seller) {
    const direct = str(seller && seller.password);
    if (direct) return direct;

    const target = cleanEmail(seller && seller.email);
    if (!target) return "";

    const userRow = getUsers().find(function (row) {
      const rowEmail = cleanEmail(deepField(row, "email", deepField(row, "mail", "")));
      return rowEmail === target;
    }) || null;

    return str(deepField(userRow, "password", deepField(userRow, "pass", deepField(userRow, "pwd", ""))));
  }

  function findSellerFromUsers(email) {
    const target = cleanEmail(email);
    if (!target) return null;

    const userRow = getUsers().find(function (row) {
      const rowEmail = cleanEmail(deepField(row, "email", deepField(row, "mail", "")));
      const role = str(deepField(row, "role", deepField(row, "accountType", ""))).toLowerCase();
      const isSeller = Boolean(deepField(row, "isSeller", false)) || role === "seller";
      return rowEmail === target && isSeller;
    }) || null;

    if (!userRow) return null;

    return normalizeSeller({ ...(userRow || {}), email: target, isSeller: true }, 0);
  }

  function pickPreferredSeller(matches) {
    const list = Array.isArray(matches) ? matches.filter(Boolean) : [];
    if (!list.length) return null;
    const active = list.find(function (row) { return hasActiveSubscription(row); });
    if (active) return active;
    const approved = list.find(function (row) {
      const status = str(row && row.status).toLowerCase();
      const payment = str(row && row.paymentStatus).toLowerCase();
      const sub = str(row && row.subscription).toLowerCase();
      return status === "approved" || payment === "paid" || sub === "active";
    });
    return approved || list[0];
  }

  function authenticateSeller(identifier, password) {
    const input = str(identifier);
    const byEmail = cleanEmail(input);
    const pass = str(password);
    const sellers = getSellers();
    let codeRecord = null;
    let loginByCode = false;
    let sellerMatches = sellers.filter(function (s) { return cleanEmail(s.email) === byEmail; });
    let seller = pickPreferredSeller(sellerMatches);

    if (!seller) {
      const codeInput = input.toUpperCase();
      const codes = codeMap();
      const matchedEmail = Object.keys(codes).find(function (email) {
        return str(codes[email] && codes[email].value).toUpperCase() === codeInput;
      });
      if (matchedEmail) {
        loginByCode = true;
        codeRecord = codes[matchedEmail] || {};
        if (codeRecord.expiry && new Date(codeRecord.expiry).getTime() < Date.now()) {
          return { ok: false, reason: "This subscription code has expired." };
        }
        if (str(codeRecord.status || "active").toLowerCase() !== "active") {
          return { ok: false, reason: "This subscription code is inactive." };
        }
        sellerMatches = sellers.filter(function (s) {
          return cleanEmail(s.email) === cleanEmail(matchedEmail);
        });
        seller = pickPreferredSeller(sellerMatches);
        if (!seller) {
          seller = findSellerFromUsers(matchedEmail);
          sellerMatches = seller ? [seller] : [];
        }
      }
    }

    if (!seller && input.indexOf("@") >= 0) {
      seller = findSellerFromUsers(byEmail);
      sellerMatches = seller ? [seller] : [];
    }

    if (!seller) {
      return { ok: false, reason: "Seller not found." };
    }

    if (!loginByCode && cleanEmail(input) === cleanEmail(seller.email)) {
      if (!pass) {
        return { ok: false, reason: "Password is required for email login." };
      }
      const passwordMatches = sellerMatches.filter(function (row) {
        return pass === resolveSellerPassword(row);
      });
      const matchedSeller = pickPreferredSeller(passwordMatches);
      if (matchedSeller) seller = matchedSeller;
      const sellerPassword = resolveSellerPassword(seller);
      if (pass !== sellerPassword) {
        return { ok: false, reason: "Incorrect password." };
      }
    }

    if (!hasActiveSubscription(seller)) {
      const paymentStatus = str(seller.paymentStatus).toLowerCase();
      if (paymentStatus === "declined") {
        return {
          ok: false,
          reason: "Payment was declined. Pay via Wave or Comcash to 6785316 and wait for admin approval."
        };
      }
      return {
        ok: false,
        reason: "Subscription pending. Pay via Wave or Comcash to 6785316 and wait for admin approval."
      };
    }

    if (loginByCode && !codeRecord) {
      return { ok: false, reason: "Could not validate subscription code." };
    }

    if (!str(seller.password)) {
      const resolvedPassword = resolveSellerPassword(seller);
      if (resolvedPassword) seller.password = resolvedPassword;
    }

    const latest = upsertSeller(seller);
    setCurrentSeller(latest);

    return { ok: true, seller: latest };
  }

  function ensureSellerSession(redirectPath) {
    const seller = getCurrentSeller();
    if (!seller) {
      if (redirectPath) window.location.href = redirectPath;
      return null;
    }
    return seller;
  }

  function getProducts() {
    const products = readJSON("products", []);
    let rows = products;
    for (let i = 0; i < 3 && typeof rows === "string"; i += 1) {
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
        if (typeof row === "string") {
          try {
            const parsed = JSON.parse(row);
            if (parsed && typeof parsed === "object") {
              const next = { ...parsed };
              if (!next.id) next.id = key;
              return next;
            }
          } catch (_) {}
        }
        return { id: key, value: row };
      });
    }
    return [];
  }

  function setProducts(products) {
    writeJSON("products", products);
  }

  function generateProductKey(name, category) {
    const cat = str(category || "GEN").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 4) || "GEN";
    const item = str(name || "ITEM").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 5) || "ITEM";
    const stamp = Date.now().toString(36).toUpperCase().slice(-4);
    return cat + "-" + item + "-" + stamp;
  }

  function normalizeProduct(raw, idx) {
    const source = raw && typeof raw === "object" ? raw : {};
    const nested = source.value;
    let base = source;
    if (nested && typeof nested === "object") {
      base = { ...nested, ...source };
    } else if (typeof nested === "string") {
      try {
        const parsed = JSON.parse(nested);
        if (parsed && typeof parsed === "object") {
          base = { ...parsed, ...source };
        }
      } catch (_) {}
    }

    const stock = Math.max(0, Math.floor(num(base.stock || base.qty || base.quantity || base.units || 0)));
    const explicitVisibility = (typeof base.isVisible === "boolean") ? base.isVisible : null;
    const statusRaw = str(base.status || "");
    const baseStatus = statusRaw ? statusRaw.toLowerCase() : (stock > 0 ? "active" : "soldout");
    const status = stock <= 0 ? "soldout" : (baseStatus === "hidden" ? "hidden" : "active");
    const needsRestock = Boolean(base.needsRestock) || status === "soldout";
    const soldOutAt = status === "soldout"
      ? (base.soldOutAt || base.updatedAt || base.createdAt || new Date().toISOString())
      : "";
    const isVisible = explicitVisibility == null ? status !== "hidden" : explicitVisibility;
    const key = str(base.productKey || base.sku || "");

    return {
      id: base.id || source.id || ("PRD-" + Date.now() + "-" + idx),
      name: str(base.name || base.title || "Product"),
      description: str(base.description || base.desc || ""),
      price: num(base.price || 0),
      image: str(base.image || "matrixx.png"),
      category: str(base.category || "general"),
      stock: stock,
      location: str(base.location || ""),
      seller: str(base.seller || base.sellerName || ""),
      sellerEmail: cleanEmail(base.sellerEmail || ""),
      productKey: key || generateProductKey(base.name || base.title || "Product", base.category || "general"),
      status: status,
      needsRestock: needsRestock,
      soldOutAt: soldOutAt,
      isVisible: isVisible,
      createdAt: base.createdAt || base.date || new Date().toISOString(),
      updatedAt: base.updatedAt || "",
      raw: base
    };
  }

  function getSellerProducts(seller) {
    const s = seller || getCurrentSeller();
    if (!s) return [];
    const products = getProducts();
    return products.map(function (p, i) { return normalizeProduct(p, i); }).filter(function (p) {
      const byEmail = p.sellerEmail && cleanEmail(p.sellerEmail) === cleanEmail(s.email);
      const byName = p.seller && str(p.seller).toLowerCase() === str(s.store || s.fullName || s.name).toLowerCase();
      const byAltName = p.seller && str(p.seller).toLowerCase() === str(s.fullName || s.name).toLowerCase();
      return byEmail || byName || byAltName;
    });
  }

  function getSellerSoldOutProducts(seller) {
    return getSellerProducts(seller).filter(function (product) {
      return product.stock <= 0 || product.needsRestock || product.status === "soldout";
    });
  }

  function getMarketplaceProducts(options) {
    const safe = options || {};
    const includeOutOfStock = Boolean(safe.includeOutOfStock);
    const includeHidden = Boolean(safe.includeHidden);
    return getProducts().map(function (row, index) {
      return normalizeProduct(row, index);
    }).filter(function (product) {
      if (!includeHidden && product.isVisible === false) return false;
      if (!includeOutOfStock && product.stock <= 0) return false;
      return true;
    });
  }

  function productBelongsToCartLine(product, line) {
    const lineId = str(line.id || line.productId || "");
    const lineName = str(line.name || line.productName || "").toLowerCase();
    const lineSeller = str(line.seller || line.sellerName || "").toLowerCase();
    const lineSellerEmail = cleanEmail(line.sellerEmail || "");

    if (lineId && str(product.id) === lineId) return true;
    if (lineSellerEmail && cleanEmail(product.sellerEmail) === lineSellerEmail && lineName && str(product.name).toLowerCase() === lineName) {
      return true;
    }
    if (lineName && lineSeller && str(product.name).toLowerCase() === lineName && str(product.seller).toLowerCase() === lineSeller) {
      return true;
    }
    return false;
  }

  function findProductIndexForCartLine(products, line) {
    for (let i = 0; i < products.length; i += 1) {
      if (productBelongsToCartLine(products[i], line)) return i;
    }
    return -1;
  }

  function compactProduct(product) {
    return {
      id: product.id,
      name: product.name,
      description: product.description,
      price: product.price,
      image: product.image,
      category: product.category,
      stock: product.stock,
      location: product.location,
      seller: product.seller,
      sellerName: product.sellerName || product.seller,
      sellerEmail: cleanEmail(product.sellerEmail || ""),
      productKey: product.productKey || generateProductKey(product.name, product.category),
      status: product.status || (product.stock > 0 ? "active" : "soldout"),
      needsRestock: Boolean(product.needsRestock),
      soldOutAt: product.soldOutAt || "",
      isVisible: typeof product.isVisible === "boolean" ? product.isVisible : true,
      createdAt: product.createdAt || new Date().toISOString(),
      updatedAt: product.updatedAt || ""
    };
  }

  function validateCartStock(cartRows) {
    const cart = Array.isArray(cartRows) ? cartRows : [];
    const products = getProducts().map(function (row, index) { return normalizeProduct(row, index); });
    const issues = [];

    cart.forEach(function (line) {
      const qty = Math.max(1, Math.floor(num(line.quantity || 1)));
      const idx = findProductIndexForCartLine(products, line);
      if (idx < 0) {
        issues.push({
          code: "missing",
          message: str(line.name || "Product") + " is no longer available.",
          line: line
        });
        return;
      }

      const product = products[idx];
      if (product.stock < qty) {
        issues.push({
          code: "insufficient",
          message: str(product.name) + " has only " + product.stock + " left in stock.",
          line: line,
          product: product
        });
      }
    });

    return { ok: issues.length === 0, issues: issues };
  }

  function applyStockDeduction(cartRows) {
    const cart = Array.isArray(cartRows) ? cartRows : [];
    if (!cart.length) return { ok: true, updates: [] };

    const products = getProducts().map(function (row, index) { return normalizeProduct(row, index); });
    const neededByIndex = {};
    const issues = [];

    cart.forEach(function (line) {
      const qty = Math.max(1, Math.floor(num(line.quantity || 1)));
      const idx = findProductIndexForCartLine(products, line);
      if (idx < 0) {
        issues.push({
          code: "missing",
          message: str(line.name || "Product") + " is no longer available.",
          line: line
        });
        return;
      }
      neededByIndex[idx] = (neededByIndex[idx] || 0) + qty;
    });

    Object.keys(neededByIndex).forEach(function (key) {
      const idx = Number(key);
      const required = neededByIndex[key];
      if (!Number.isInteger(idx) || !products[idx]) return;
      if (products[idx].stock < required) {
        issues.push({
          code: "insufficient",
          message: products[idx].name + " has only " + products[idx].stock + " left in stock.",
          product: products[idx]
        });
      }
    });

    if (issues.length) return { ok: false, issues: issues };

    const now = new Date().toISOString();
    const updates = [];
    Object.keys(neededByIndex).forEach(function (key) {
      const idx = Number(key);
      const product = products[idx];
      const nextStock = Math.max(0, product.stock - neededByIndex[key]);
      product.stock = nextStock;
      product.updatedAt = now;

      if (nextStock <= 0) {
        product.status = "soldout";
        product.needsRestock = true;
        if (!product.soldOutAt) product.soldOutAt = now;
      } else {
        product.status = "active";
        product.needsRestock = false;
        product.soldOutAt = "";
      }

      updates.push({
        id: product.id,
        name: product.name,
        seller: product.seller,
        stock: product.stock,
        soldOut: product.stock <= 0
      });
    });

    setProducts(products.map(compactProduct));
    return { ok: true, updates: updates };
  }

  function renewProductStockForSeller(seller, id, addUnits) {
    const s = seller || getCurrentSeller();
    if (!s) return { ok: false, error: "Seller session not found." };
    if (!canSellerPost(s)) return { ok: false, error: "Posting actions are disabled for this account." };

    const amount = Math.max(1, Math.floor(num(addUnits || 0)));
    const targetId = str(id);
    if (!targetId || amount <= 0) return { ok: false, error: "Invalid restock request." };

    const products = getProducts();
    let changed = null;

    const next = products.map(function (row, index) {
      const product = normalizeProduct(row, index);
      if (str(product.id) !== targetId) return row;

      const owned = cleanEmail(product.sellerEmail) === cleanEmail(s.email) ||
        str(product.seller).toLowerCase() === str(s.store || s.fullName || s.name).toLowerCase() ||
        str(product.seller).toLowerCase() === str(s.fullName || s.name).toLowerCase();

      if (!owned) return row;

      product.stock = Math.max(0, product.stock + amount);
      product.status = product.stock > 0 ? "active" : "soldout";
      product.needsRestock = product.stock <= 0;
      if (product.stock > 0) product.soldOutAt = "";
      product.updatedAt = new Date().toISOString();
      changed = product;
      return compactProduct(product);
    });

    if (!changed) return { ok: false, error: "Product not found for this seller." };
    setProducts(next);
    return { ok: true, product: changed };
  }

  function saveProductForSeller(seller, productInput) {
    const s = seller || getCurrentSeller();
    if (!s) return { ok: false, error: "Seller session not found." };
    if (isSellerSuspended(s)) return { ok: false, error: "Seller account is suspended and cannot post products." };
    if (!hasActiveSubscription(s)) return { ok: false, error: "Active subscription is required to post products." };

    const product = normalizeProduct({
      ...productInput,
      id: "PRD-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      seller: str(s.store || s.fullName || s.name),
      sellerName: str(s.fullName || s.name),
      sellerEmail: cleanEmail(s.email),
      createdAt: new Date().toISOString()
    }, 0);

    if (!product.name || product.price <= 0) {
      return { ok: false, error: "Product name and valid price are required." };
    }

    const products = getProducts();
    products.push(compactProduct(product));
    setProducts(products);
    return { ok: true, product: product };
  }

  function updateProductForSeller(seller, id, patch) {
    const s = seller || getCurrentSeller();
    if (!s) return false;
    if (isSellerSuspended(s)) return false;
    if (!hasActiveSubscription(s)) return false;
    const targetId = str(id);
    const products = getProducts();
    let changed = false;

    const next = products.map(function (p, idx) {
      const row = normalizeProduct(p, idx);
      if (str(row.id) !== targetId) return p;

      const owned = cleanEmail(row.sellerEmail) === cleanEmail(s.email) ||
        str(row.seller).toLowerCase() === str(s.store || s.fullName || s.name).toLowerCase() ||
        str(row.seller).toLowerCase() === str(s.fullName || s.name).toLowerCase();

      if (!owned) return p;
      changed = true;

      const merged = normalizeProduct({ ...row, ...patch, id: targetId, sellerEmail: s.email, seller: row.seller }, idx);
      return compactProduct({
        ...p,
        ...merged,
        seller: merged.seller,
        sellerEmail: merged.sellerEmail,
        sellerName: str(s.fullName || s.name),
        createdAt: row.createdAt
      });
    });

    if (changed) setProducts(next);
    return changed;
  }

  function deleteProductForSeller(seller, id) {
    const s = seller || getCurrentSeller();
    if (!s) return false;
    if (isSellerSuspended(s)) return false;
    const targetId = str(id);
    const products = getProducts();
    let removed = false;

    const filtered = products.filter(function (p, idx) {
      const row = normalizeProduct(p, idx);
      if (str(row.id) !== targetId) return true;
      const owned = cleanEmail(row.sellerEmail) === cleanEmail(s.email) ||
        str(row.seller).toLowerCase() === str(s.store || s.fullName || s.name).toLowerCase() ||
        str(row.seller).toLowerCase() === str(s.fullName || s.name).toLowerCase();
      if (owned) removed = true;
      return !owned;
    });

    if (removed) setProducts(filtered);
    return removed;
  }

  function getPurchasesForSeller(seller) {
    const s = seller || getCurrentSeller();
    if (!s) return [];
    const purchases = readJSON("purchases", []);
    if (!Array.isArray(purchases)) return [];

    const keys = [
      cleanEmail(s.email),
      str(s.store || "").toLowerCase(),
      str(s.fullName || s.name || "").toLowerCase()
    ];

    return purchases.filter(function (p) {
      const byEmail = Boolean(keys[0]) && cleanEmail(p.sellerEmail || "") === keys[0];
      const byName = str(p.seller || p.sellerName || "").toLowerCase();
      return byEmail || (keys[1] && byName === keys[1]) || (keys[2] && byName === keys[2]);
    }).map(function (p) {
      return {
        orderId: str(p.orderId || "-"),
        productName: str(p.productName || p.name || "Product"),
        buyerEmail: str(p.buyerEmail || "-"),
        buyerName: str(p.buyerName || "-"),
        quantity: Math.max(1, Math.floor(num(p.quantity || 1))),
        price: num(p.price || 0),
        total: num(p.total || (num(p.price) * Math.max(1, Math.floor(num(p.quantity || 1))))),
        date: p.date || p.createdAt || new Date().toISOString(),
        status: str(p.status || "pending")
      };
    });
  }

  function getSellerQueueRows(seller) {
    const s = seller || getCurrentSeller();
    if (!s) return [];
    const queues = readJSON("sellerOrderQueues", {});
    if (!queues || typeof queues !== "object") return [];

    const keys = [
      str(s.store || ""),
      str(s.fullName || s.name || ""),
      cleanEmail(s.email)
    ].filter(Boolean).map(function (k) { return k.toLowerCase(); });

    const rows = [];
    Object.keys(queues).forEach(function (queueKey) {
      if (!keys.includes(str(queueKey).toLowerCase())) return;
      const items = Array.isArray(queues[queueKey]) ? queues[queueKey] : [];
      items.forEach(function (it, idx) {
        rows.push({
          queueKey: queueKey,
          index: idx,
          orderId: str(it.orderId || "-"),
          buyer: str(it.buyer || it.name || "-"),
          email: str(it.email || it.buyerEmail || "-"),
          phone: str(it.phone || "-"),
          address: str(it.address || "-"),
          item: str(it.item || it.productName || "-"),
          quantity: Math.max(1, Math.floor(num(it.quantity || 1))),
          amount: num(it.amount || it.total || 0),
          status: str(it.status || "pending"),
          date: it.date || it.createdAt || new Date().toISOString(),
          raw: it
        });
      });
    });
    return rows;
  }

  function sameOrderId(a, b) {
    const left = str(a).toLowerCase();
    const right = str(b).toLowerCase();
    return Boolean(left) && Boolean(right) && left === right;
  }

  function sellerIdentityKeys(seller) {
    const s = seller || {};
    return {
      email: cleanEmail(s.email),
      store: str(s.store || "").toLowerCase(),
      name: str(s.fullName || s.name || "").toLowerCase()
    };
  }

  function purchaseBelongsToSeller(row, keys) {
    if (!row || typeof row !== "object") return false;
    const byEmail = Boolean(keys.email) && cleanEmail(row.sellerEmail || "") === keys.email;
    const byName = str(row.seller || row.sellerName || "").toLowerCase();
    return byEmail || (keys.store && byName === keys.store) || (keys.name && byName === keys.name);
  }

  function isBuyerOrderStorageKey(key) {
    const target = str(key);
    if (!target) return false;
    if (target === "buyerOrders") return true;
    if (target.indexOf("buyerOrdersByEmail:") === 0) return true;
    if (target.indexOf("buyerOrdersByPhone:") === 0) return true;
    return target.indexOf(BUYER_SCOPE_PREFIX) === 0 && target.indexOf("__buyerOrders") > 0;
  }

  function addKeyUnique(list, key) {
    const target = str(key);
    if (!target) return;
    if (!list.includes(target)) list.push(target);
  }

  function findOrderStorageKeys(extraKeys) {
    const keys = [];
    addKeyUnique(keys, "buyerOrders");
    (Array.isArray(extraKeys) ? extraKeys : []).forEach(function (key) { addKeyUnique(keys, key); });
    listStorageKeys().forEach(function (key) {
      if (isBuyerOrderStorageKey(key)) addKeyUnique(keys, key);
    });
    return keys;
  }

  function patchOrderRowsInKey(storageKey, orderId, nextStatus, updatedAt) {
    const rows = readJSON(storageKey, null);
    if (!Array.isArray(rows) || !rows.length) return false;
    let changed = false;
    const nextRows = rows.map(function (row) {
      const id = str(row && (row.id || row.orderId || row.orderNumber) || "");
      if (!sameOrderId(id, orderId)) return row;
      changed = true;
      return { ...row, status: nextStatus, updatedAt: updatedAt };
    });
    if (!changed) return false;
    return writeJSON(storageKey, nextRows);
  }

  function patchSnapshotsByOrderId(orderId, nextStatus, updatedAt) {
    const mapKeys = ["orderLineSnapshots"];
    listStorageKeys().forEach(function (key) {
      if (key.indexOf(BUYER_SCOPE_PREFIX) === 0 && key.endsWith("__orderLineSnapshots")) addKeyUnique(mapKeys, key);
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
      if (sameOrderId(key.split("__orderItemsById:")[1], orderId)) addKeyUnique(directKeys, key);
    });
    directKeys.forEach(function (storageKey) {
      const row = readJSON(storageKey, null);
      if (!row || typeof row !== "object" || Array.isArray(row)) return;
      const patched = { ...row, status: nextStatus, updatedAt: updatedAt };
      if (writeJSON(storageKey, patched)) changed = true;
    });

    return changed;
  }

  function patchBuyerOrdersEverywhere(orderId, nextStatus, updatedAt, details) {
    const info = details || {};
    const extraKeys = [];
    const byEmail = cleanEmail(info.email || "");
    const byPhone = str(info.phone || "").replace(/\D+/g, "");
    if (byEmail) addKeyUnique(extraKeys, "buyerOrdersByEmail:" + byEmail);
    if (byPhone) addKeyUnique(extraKeys, "buyerOrdersByPhone:" + byPhone);

    let changed = false;
    findOrderStorageKeys(extraKeys).forEach(function (storageKey) {
      if (patchOrderRowsInKey(storageKey, orderId, nextStatus, updatedAt)) changed = true;
    });
    if (patchSnapshotsByOrderId(orderId, nextStatus, updatedAt)) changed = true;
    return changed;
  }

  function patchPurchasesStatusForSeller(seller, orderId, nextStatus, updatedAt) {
    const rows = readJSON("purchases", []);
    if (!Array.isArray(rows) || !rows.length) return false;
    const keys = sellerIdentityKeys(seller);
    let changed = false;
    const nextRows = rows.map(function (row) {
      const rowOrderId = str(row && (row.orderId || row.id || row.orderNumber) || "");
      if (!sameOrderId(rowOrderId, orderId) || !purchaseBelongsToSeller(row, keys)) return row;
      changed = true;
      return { ...row, status: nextStatus, updatedAt: updatedAt };
    });
    if (!changed) return false;
    return writeJSON("purchases", nextRows);
  }

  function updateQueueStatus(seller, queueKey, index, nextStatus) {
    const s = seller || getCurrentSeller();
    if (!s) return false;

    const queues = readJSON("sellerOrderQueues", {});
    if (!queues[queueKey] || !Array.isArray(queues[queueKey])) return false;
    if (!queues[queueKey][index]) return false;

    const row = queues[queueKey][index] || {};
    const orderId = str(row.orderId || row.id || row.orderNumber || "");
    const updatedAt = new Date().toISOString();
    const normalizedStatus = str(nextStatus || "pending");

    if (orderId) {
      queues[queueKey] = queues[queueKey].map(function (entry, idx) {
        if (idx === index) return { ...entry, status: normalizedStatus, updatedAt: updatedAt };
        const entryOrderId = str(entry && (entry.orderId || entry.id || entry.orderNumber) || "");
        if (!sameOrderId(entryOrderId, orderId)) return entry;
        return { ...entry, status: normalizedStatus, updatedAt: updatedAt };
      });
    } else {
      queues[queueKey][index] = { ...row, status: normalizedStatus, updatedAt: updatedAt };
    }
    writeJSON("sellerOrderQueues", queues);

    if (orderId) {
      patchBuyerOrdersEverywhere(orderId, normalizedStatus, updatedAt, {
        email: row.email || row.buyerEmail || "",
        phone: row.phone || row.buyerPhone || ""
      });
      patchPurchasesStatusForSeller(s, orderId, normalizedStatus, updatedAt);
    }

    return true;
  }

  function computeMetrics(seller) {
    const s = seller || getCurrentSeller();
    if (!s) {
      return {
        products: 0,
        sales: 0,
        earnings: 0,
        pendingDeliveries: 0,
        delivered: 0,
        conversionRate: 0
      };
    }

    const products = getSellerProducts(s);
    const purchases = getPurchasesForSeller(s);
    const queue = getSellerQueueRows(s);

    const earnings = purchases.reduce(function (sum, p) { return sum + num(p.total); }, 0);
    const pendingDeliveries = queue.filter(function (q) { return str(q.status).toLowerCase() === "pending"; }).length;
    const delivered = queue.filter(function (q) {
      const st = str(q.status).toLowerCase();
      return st === "delivered" || st === "completed";
    }).length;

    const conversionRate = products.length ? Math.min(100, (purchases.length / products.length) * 100) : 0;

    return {
      products: products.length,
      sales: purchases.length,
      earnings: earnings,
      pendingDeliveries: pendingDeliveries,
      delivered: delivered,
      conversionRate: conversionRate
    };
  }

  function renderSellerHeader(activePage) {
    const links = [
      ["seller-dashboard.html", "Dashboard"],
      ["seller-products.html", "Products"],
      ["seller-orders.html", "Orders"],
      ["seller-chat.html", "Chat"],
      ["delivery.html", "Delivery"],
      ["seller-withdrawal.html", "Withdraw"],
      ["sellers-shop.html", "Seller Shop"],
      ["payment-status-sellers.html", "Payment"],
      ["subscription-code.html", "Code"],
      ["settings.html", "Settings"]
    ];

    return (
      '<header class="seller-header">' +
      '<div class="seller-header-inner">' +
      '<div class="seller-brand">MatrixMarket Seller</div>' +
      '<nav class="seller-nav">' +
      links.map(function (l) {
        const active = l[0] === activePage ? "active" : "";
        return '<a class="' + active + '" href="' + l[0] + '">' + l[1] + '</a>';
      }).join("") +
      '<a href="sellers.html">Directory</a>' +
      '<a href="index.html">Home</a>' +
      '<button type="button" onclick="SellerCore.logoutAndGo()">Logout</button>' +
      '</nav>' +
      '</div>' +
      '</header>'
    );
  }

  function logoutAndGo() {
    logoutSeller();
    window.location.href = "seller-login.html";
  }

  window.SellerCore = {
    SELLER_PAYMENT_ACCOUNT: SELLER_PAYMENT_ACCOUNT,
    SELLER_PAYMENT_METHODS: SELLER_PAYMENT_METHODS.slice(),
    WITHDRAWAL_CHARGE_PER_10: WITHDRAWAL_CHARGE_PER_10,
    readJSON: readJSON,
    writeJSON: writeJSON,
    num: num,
    str: str,
    fmtMoney: fmtMoney,
    fmtDate: fmtDate,
    statusClass: statusClass,
    badge: badge,
    cleanEmail: cleanEmail,
    paymentMethod: paymentMethod,
    withdrawalCharge: withdrawalCharge,
    withdrawalNet: withdrawalNet,
    hasActiveSubscription: hasActiveSubscription,
    isSellerSuspended: isSellerSuspended,
    canSellerPost: canSellerPost,
    getSellers: getSellers,
    setSellers: setSellers,
    findSeller: findSeller,
    upsertSeller: upsertSeller,
    getCurrentSeller: getCurrentSeller,
    setCurrentSeller: setCurrentSeller,
    logoutSeller: logoutSeller,
    logoutAndGo: logoutAndGo,
    planAmount: planAmount,
    registerSeller: registerSeller,
    ensurePendingRequest: ensurePendingRequest,
    codeMap: codeMap,
    setCodeMap: setCodeMap,
    createCode: createCode,
    assignCode: assignCode,
    authenticateSeller: authenticateSeller,
    ensureSellerSession: ensureSellerSession,
    getProducts: getProducts,
    setProducts: setProducts,
    generateProductKey: generateProductKey,
    normalizeProduct: normalizeProduct,
    getMarketplaceProducts: getMarketplaceProducts,
    getSellerProducts: getSellerProducts,
    getSellerSoldOutProducts: getSellerSoldOutProducts,
    saveProductForSeller: saveProductForSeller,
    updateProductForSeller: updateProductForSeller,
    renewProductStockForSeller: renewProductStockForSeller,
    deleteProductForSeller: deleteProductForSeller,
    validateCartStock: validateCartStock,
    applyStockDeduction: applyStockDeduction,
    getPurchasesForSeller: getPurchasesForSeller,
    getSellerQueueRows: getSellerQueueRows,
    updateQueueStatus: updateQueueStatus,
    computeMetrics: computeMetrics,
    renderSellerHeader: renderSellerHeader
  };
})();
