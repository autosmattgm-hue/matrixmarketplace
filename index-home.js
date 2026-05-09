(function () {
  'use strict';

  const KEYS = {
    CART: 'cart',
    CART_ITEMS: 'cartItems',
    CHECKOUT_CART: 'checkoutCart',
    CHECKOUT_META: 'checkoutMeta',
    USER: 'currentUser',
    USER_BALANCE: 'userBalance',
    BALANCE: 'balance',
    WISHLIST: 'marketplaceWishlist',
    RECENT: 'marketplaceRecent',
    COMPARE: 'indexCompare',
    PREFS: 'marketplaceDisplayPrefs',
    LATEST: 'latestProductsCache'
  };

  const BUYER_SCOPE_PREFIX = '__mm_buyer__';
  const SCOPED_KEYS = new Set([
    KEYS.CART,
    KEYS.CART_ITEMS,
    KEYS.CHECKOUT_CART,
    KEYS.CHECKOUT_META,
    KEYS.WISHLIST,
    KEYS.RECENT,
    KEYS.COMPARE,
    KEYS.PREFS
  ]);
  const LEGACY_READ_THROUGH_KEYS = new Set([
    KEYS.CART,
    KEYS.CART_ITEMS,
    KEYS.CHECKOUT_CART,
    KEYS.CHECKOUT_META
  ]);

  const REMOTE = {
    apiKey: 'AIzaSyAUtHIWT6yZ8lHVShZNdQpDEXi_M8Zuo7I',
    dbUrl: 'https://matrixmarket-f72e0-default-rtdb.firebaseio.com',
    rootPath: 'worldwideStorage'
  };
  const REMOTE_TOKEN_KEY = 'mmRemoteProductsToken';
  const REMOTE_TOKEN_EXPIRY_KEY = 'mmRemoteProductsTokenExpiry';

  const state = {
    products: [],
    filtered: [],
    latest: [],
    hero: {
      newestKey: '',
      topSoldKey: '',
      topSoldUnits: 0,
      topSoldOrders: 0,
      topSoldRevenue: 0,
      freshCount: 0,
      topSellerName: '',
      topSellerCount: 0
    },
    wishlist: new Set(),
    recent: [],
    page: 1,
    pageSize: 12,
    view: 'grid',
    maxPriceCap: 2000,
    maxPriceTouched: false,
    autoSync: true,
    onlyWishlist: false,
    quickMode: '',
    compare: new Set(),
    chip: '',
    selected: '',
    lastSync: '--'
  };

  const HOME_AUTO_SYNC_MS = 90000;
  const HEADER_REFRESH_MS = 30000;
  let searchTimer = null;
  let pendingFilterFrame = 0;
  let pendingFilterArgs = { pushUrl: true, skipRecover: false };
  let refreshTimer = 0;
  let refreshInFlight = false;
  let queuedRefresh = false;
  let queuedRefreshSilent = true;
  let reconcileTimer = 0;
  let lastProductsSignature = '';
  let booted = false;
  let remoteFallbackBusy = false;
  let cachedUserScope = null;

  function byId(id) { return document.getElementById(id); }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function str(v) { return String(v == null ? '' : v); }
  function money(v) { return num(v).toFixed(2) + ' GMD'; }
  function formatLabel(v) {
    return str(v)
      .trim()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\b[a-z]/g, function (m) { return m.toUpperCase(); });
  }

  function esc(v) {
    return str(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getStorageAdapter() {
    if (window.MMStorage && typeof window.MMStorage.getItem === 'function') return window.MMStorage;
    try {
      if (window.localStorage && typeof window.localStorage.getItem === 'function') return window.localStorage;
    } catch (_) {}
    return {
      getItem: function () { return null; },
      setItem: function () {},
      removeItem: function () {}
    };
  }

  function parseStoredJson(raw, fallback) {
    try {
      if (raw == null || raw === '') return fallback;
      const parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (_) {
      return fallback;
    }
  }

  function normalizeScopeToken(raw) {
    const token = str(raw).trim().toLowerCase();
    if (!token) return '';
    return token.replace(/[^a-z0-9._:@-]+/g, '_');
  }

  function isGuestSessionUser(user) {
    if (!user || typeof user !== 'object') return true;
    if (user.isGuest) return true;
    const email = normalizeScopeToken(user.email);
    return !email || email === 'guest@matrixmarket.local';
  }

  function isSellerUser(user) {
    return !!(user && (user.isSeller || str(user.accountType || user.role).toLowerCase() === 'seller'));
  }

  function cleanEmail(value) {
    return str(value).trim().toLowerCase();
  }

  function balanceMirrorKey(email) {
    const target = cleanEmail(email);
    return target ? ('userBalanceByEmail:' + target) : '';
  }

  function isBalanceStorageEvent(key) {
    const target = str(key);
    if (!target) return false;
    if (target === KEYS.USER || target === 'loggedInUser' || target === 'currentSeller' || target === KEYS.USER_BALANCE || target === KEYS.BALANCE) return true;
    if (target === 'users' || target === 'sellers') return true;
    if (target.indexOf('userBalanceByEmail:') === 0) return true;
    const activeUser = readActiveUser() || {};
    const mirrorKey = balanceMirrorKey(activeUser.email);
    return !!(mirrorKey && target === mirrorKey);
  }

  function readActiveUser() {
    const adapter = getStorageAdapter();
    const keys = [KEYS.USER, 'loggedInUser', 'currentSeller'];
    let fallback = null;

    for (let i = 0; i < keys.length; i += 1) {
      const parsed = parseStoredJson(adapter.getItem(keys[i]), null);
      if (!parsed || typeof parsed !== 'object') continue;
      if (!fallback) fallback = parsed;
      if (!isGuestSessionUser(parsed)) return parsed;
    }

    return fallback;
  }

  function resolveUserScopeToken() {
    const current = readActiveUser() || {};
    const email = normalizeScopeToken(current && current.email);
    if (email && email !== 'guest@matrixmarket.local') return email;
    const uid = normalizeScopeToken(current && (current.id || current.uid || current.userId));
    if (uid) return 'id_' + uid;
    const phone = normalizeScopeToken(current && current.phone);
    if (phone) return 'phone_' + phone;
    const name = normalizeScopeToken(current && (current.username || current.name || current.fullName));
    if (name) return 'name_' + name;
    return 'guest';
  }

  function userScopeToken() {
    if (cachedUserScope) return cachedUserScope;
    cachedUserScope = resolveUserScopeToken();
    return cachedUserScope;
  }
  function isGuestScope() {
    return userScopeToken() === 'guest';
  }

  function invalidateUserScopeToken() {
    cachedUserScope = null;
  }

  function shouldUseScopedKey(key) {
    return SCOPED_KEYS.has(str(key));
  }

  function scopedStorageKey(key) {
    return BUYER_SCOPE_PREFIX + userScopeToken() + '__' + str(key);
  }

  function guestScopedStorageKey(key) {
    return BUYER_SCOPE_PREFIX + 'guest__' + str(key);
  }

  function readParsedValue(storageKey, fallback) {
    return parseStoredJson(getStorageAdapter().getItem(storageKey), fallback);
  }

  function keyMatchesStorageEvent(actualKey, logicalKey) {
    const key = str(actualKey);
    const logical = str(logicalKey);
    if (!key || !logical) return false;
    if (key === logical) return true;
    if (key === scopedStorageKey(logical)) return true;
    return key.indexOf(BUYER_SCOPE_PREFIX) === 0 && key.endsWith('__' + logical);
  }

  function read(key, fallback) {
    try {
      if (shouldUseScopedKey(key)) {
        const scoped = readParsedValue(scopedStorageKey(key), null);
        if (scoped != null) return scoped;
        if (LEGACY_READ_THROUGH_KEYS.has(str(key)) && isGuestScope()) {
          const guestScoped = readParsedValue(guestScopedStorageKey(key), null);
          if (guestScoped != null) return guestScoped;
          return readParsedValue(key, fallback);
        }
        if (!isGuestScope()) return fallback;
      }
      return readParsedValue(key, fallback);
    } catch (_) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      const storageKey = shouldUseScopedKey(key) ? scopedStorageKey(key) : key;
      getStorageAdapter().setItem(storageKey, JSON.stringify(value));
    } catch (_) {}
  }

  function writeCartBridge(rows) {
    try {
      const cartRows = Array.isArray(rows) ? rows.slice(0, 120) : [];
      let payload = {};
      try {
        const parsed = JSON.parse(String(window.name || '').trim() || '{}');
        if (parsed && typeof parsed === 'object') payload = parsed;
      } catch (_) {}
      payload.mmCartBridge = {
        savedAt: new Date().toISOString(),
        cart: cartRows
      };
      window.name = JSON.stringify(payload);
    } catch (_) {}
  }

  function writeCheckoutBridge(rows, meta) {
    try {
      const checkoutRows = Array.isArray(rows) ? rows.slice(0, 120) : [];
      let payload = {};
      try {
        const parsed = JSON.parse(String(window.name || '').trim() || '{}');
        if (parsed && typeof parsed === 'object') payload = parsed;
      } catch (_) {}
      payload.mmCheckoutBridge = {
        savedAt: new Date().toISOString(),
        cart: checkoutRows,
        meta: meta && typeof meta === 'object' ? meta : null
      };
      window.name = JSON.stringify(payload);
    } catch (_) {}
  }

  function stamp(v) {
    const d = new Date(v || '');
    const t = d.getTime();
    return Number.isFinite(t) ? t : 0;
  }

  function ago(v) {
    const diff = Date.now() - stamp(v);
    if (diff <= 0) return 'now';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }

  function isFreshListing(product, days) {
    const age = Date.now() - num(product && product.createdStamp);
    const maxAge = Math.max(1, num(days || 7)) * 86400000;
    return age >= 0 && age <= maxAge;
  }

  function priceSignal(product) {
    const price = num(product && product.price);
    if (price <= 5000) return 'Budget pick';
    if (price >= 50000) return 'Premium';
    return 'Hot value';
  }

  function toast(message) {
    const wrap = byId('toastWrap');
    if (!wrap || !message) return;
    const el = document.createElement('div');
    el.className = 'mm-toast';
    el.textContent = str(message);
    wrap.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 250);
    }, 2400);
  }

  function setSyncNote(message) {
    const note = byId('syncNote');
    if (note) note.textContent = str(message || '');
  }

  function requestIdleTask(callback, timeoutMs) {
    if (typeof callback !== 'function') return;
    if ('requestIdleCallback' in window) {
      requestIdleCallback(callback, { timeout: Math.max(250, num(timeoutMs) || 1000) });
      return;
    }
    setTimeout(callback, 0);
  }

  function productSignature(rows) {
    return (Array.isArray(rows) ? rows : []).map(function (row) {
      return [
        row && row._key,
        num(row && row.price).toFixed(2),
        Math.max(0, Math.floor(num(row && row.stock))),
        row && row.isVisible === false ? 0 : 1,
        str(row && (row.createdAt || row.updatedAt || ''))
      ].join('~');
    }).join('|');
  }

  function requestApplyFilters(pushUrl, skipRecover) {
    pendingFilterArgs = {
      pushUrl: pushUrl !== false,
      skipRecover: Boolean(skipRecover)
    };
    if (pendingFilterFrame) return;
    const runner = function () {
      pendingFilterFrame = 0;
      applyFilters(pendingFilterArgs.pushUrl, pendingFilterArgs.skipRecover);
    };
    if ('requestAnimationFrame' in window) {
      pendingFilterFrame = requestAnimationFrame(runner);
      return;
    }
    pendingFilterFrame = setTimeout(runner, 16);
  }

  function flushRefreshProducts() {
    const silent = queuedRefreshSilent;
    queuedRefreshSilent = true;
    refreshInFlight = true;
    requestIdleTask(function () {
      try {
        refreshProducts(silent);
      } finally {
        refreshInFlight = false;
        if (queuedRefresh) {
          queuedRefresh = false;
          requestRefreshProducts(queuedRefreshSilent, 0);
        }
      }
    }, 1200);
  }

  function requestRefreshProducts(silent, delayMs) {
    if (silent === false) queuedRefreshSilent = false;
    if (refreshInFlight) {
      queuedRefresh = true;
      return;
    }
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      refreshTimer = 0;
      flushRefreshProducts();
    }, Math.max(0, Math.floor(num(delayMs || 0))));
  }

  function requestReconcile() {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(function () {
      reconcileTimer = 0;
      try { reconcileHydratedState(); } catch (_) {}
    }, 120);
  }

  function updateOnline() {
    const badge = byId('onlineBadge');
    if (!badge) return;
    const on = navigator.onLine;
    badge.textContent = on ? 'Online' : 'Offline';
    badge.classList.toggle('online', on);
    badge.classList.toggle('offline', !on);
  }

  function tickClock() {
    const box = byId('clockBox');
    if (!box) return;
    box.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function normalizeProduct(raw, index) {
    const row = (window.SellerCore && typeof window.SellerCore.normalizeProduct === 'function')
      ? window.SellerCore.normalizeProduct(raw, index)
      : (raw || {});

    const id = str(row.id || row.productKey || ('PRD-' + index));
    const seller = str(row.seller || row.sellerName || 'Unknown Seller');
    const sellerEmail = str(row.sellerEmail || '').toLowerCase();
    const key = [id, sellerEmail || seller.toLowerCase(), str(row.name).toLowerCase()].join('::');
    const image = str(row.image || 'matrixx.png');

    return {
      id: id,
      _key: key,
      name: str(row.name || row.title || 'Product'),
      category: str(row.category || 'general'),
      seller: seller,
      sellerEmail: sellerEmail,
      location: str(row.location || ''),
      description: str(row.description || row.desc || ''),
      price: num(row.price),
      stock: Math.max(0, Math.floor(num(row.stock || row.quantity || row.qty || 0))),
      image: image.includes('via.placeholder.com') ? 'matrixx.png' : image,
      createdAt: row.createdAt || row.updatedAt || row.date || new Date().toISOString(),
      createdStamp: stamp(row.createdAt || row.updatedAt || row.date),
      isVisible: row.isVisible !== false
    };
  }

  function normalizeRows(raw) {
    let rows = raw;
    for (let i = 0; i < 3 && typeof rows === 'string'; i += 1) {
      try { rows = JSON.parse(rows); } catch (_) { rows = []; }
    }
    if (Array.isArray(rows)) return rows.slice();
    if (rows && typeof rows === 'object') {
      return Object.keys(rows).map(function (key) {
        const row = rows[key];
        if (row && typeof row === 'object') return { ...row, id: row.id || key };
        return { id: key, value: row };
      });
    }
    return [];
  }

  function readLatestRows() {
    const cached = read(KEYS.LATEST, []);
    if (Array.isArray(cached)) return cached.slice();
    if (cached && Array.isArray(cached.items)) return cached.items.slice();
    return [];
  }

  function readSessionText(key) {
    try {
      return String((window.sessionStorage && window.sessionStorage.getItem(key)) || '');
    } catch (_) {
      return '';
    }
  }

  function writeSessionText(key, value) {
    try {
      if (window.sessionStorage) window.sessionStorage.setItem(key, String(value == null ? '' : value));
    } catch (_) {}
  }

  function getRemoteToken() {
    const token = readSessionText(REMOTE_TOKEN_KEY);
    const expiry = Number(readSessionText(REMOTE_TOKEN_EXPIRY_KEY) || 0);
    if (!token || !expiry || (Date.now() + 30000) >= expiry) return '';
    return token;
  }

  function storeRemoteToken(token, expiresInSeconds) {
    if (!token) return;
    const ttlMs = Math.max(60000, num(expiresInSeconds) * 1000 || 3300000);
    writeSessionText(REMOTE_TOKEN_KEY, token);
    writeSessionText(REMOTE_TOKEN_EXPIRY_KEY, Date.now() + ttlMs);
  }

  function fetchRemoteProductsWithToken(token) {
    const productsUrl = REMOTE.dbUrl + '/' + REMOTE.rootPath + '/products.json';
    return fetch(productsUrl + '?auth=' + encodeURIComponent(token), { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('products_fetch_failed');
      return res.json();
    }).then(function (payload) {
      const rows = normalizeRows(payload);
      if (rows.length) write('products', rows);
      return rows;
    });
  }

  function loadMarketplaceRows() {
    let rows = [];
    try {
      if (window.SellerCore && typeof window.SellerCore.getMarketplaceProducts === 'function') {
        rows = normalizeRows(window.SellerCore.getMarketplaceProducts({ includeOutOfStock: true, includeHidden: true }));
      }
      if (!rows.length && window.SellerCore && typeof window.SellerCore.getProducts === 'function') {
        rows = normalizeRows(window.SellerCore.getProducts());
      }
    } catch (_) {
      rows = [];
    }

    if (!rows.length) rows = normalizeRows(read('products', []));
    if (rows.length) return rows;

    return readLatestRows().map(function (row, index) {
      return {
        id: row.id || ('LATE-' + index),
        name: row.name || 'Product',
        category: row.category || 'general',
        seller: row.seller || row.sellerName || 'Unknown Seller',
        sellerEmail: row.sellerEmail || '',
        location: row.location || '',
        description: row.description || '',
        price: num(row.price),
        stock: Math.max(1, Math.floor(num(row.stock || 1))),
        image: row.image || 'matrixx.png',
        createdAt: row.createdAt || new Date().toISOString(),
        isVisible: true
      };
    });
  }

  function fetchRemoteProductsDirect() {
    if (remoteFallbackBusy || !window.fetch) return Promise.resolve([]);
    remoteFallbackBusy = true;

    const signupUrl = 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + encodeURIComponent(REMOTE.apiKey);
    const cachedToken = getRemoteToken();

    return Promise.resolve().then(function () {
      if (cachedToken) return fetchRemoteProductsWithToken(cachedToken);
      return fetch(signupUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      }).then(function (res) {
        if (!res.ok) throw new Error('signup_failed');
        return res.json();
      }).then(function (auth) {
        const token = str(auth && auth.idToken);
        if (!token) throw new Error('missing_token');
        storeRemoteToken(token, auth && auth.expiresIn);
        return fetchRemoteProductsWithToken(token);
      });
    }).catch(function () {
      return [];
    }).finally(function () {
      remoteFallbackBusy = false;
    });
  }

  function loadPrefs() {
    const prefs = read(KEYS.PREFS, {});
    const size = num(prefs.pageSize);
    if ([8, 12, 16, 24].includes(size)) state.pageSize = size;
    if (prefs.view === 'list' || prefs.view === 'grid') state.view = prefs.view;
    if (typeof prefs.autoSync === 'boolean') state.autoSync = prefs.autoSync;
    if (typeof prefs.onlyWishlist === 'boolean') state.onlyWishlist = prefs.onlyWishlist;
    if (prefs.quickMode === 'today' || prefs.quickMode === 'budget' || prefs.quickMode === 'highStock') state.quickMode = prefs.quickMode;
    state.wishlist = new Set((read(KEYS.WISHLIST, []) || []).map(String));
    state.recent = (read(KEYS.RECENT, []) || []).map(String).slice(0, 10);
    state.compare = new Set((read(KEYS.COMPARE, []) || []).map(String).slice(0, 3));
  }

  function savePrefs() {
    write(KEYS.PREFS, {
      pageSize: state.pageSize,
      view: state.view,
      autoSync: state.autoSync,
      onlyWishlist: state.onlyWishlist,
      quickMode: state.quickMode
    });
  }

  function readWalletBalance() {
    const user = readActiveUser();
    if (user && typeof user === 'object' && !isGuestSessionUser(user)) {
      const email = cleanEmail(user && user.email);
      const canonical = resolveCanonicalAccount(user);
      const mirrorKey = balanceMirrorKey(email);
      const mirrorRaw = mirrorKey ? getStorageAdapter().getItem(mirrorKey) : null;
      const rawFallback = getStorageAdapter().getItem(KEYS.USER_BALANCE) || getStorageAdapter().getItem(KEYS.BALANCE) || 0;
      const seedBalance = canonical && canonical.balance != null
        ? num(canonical.balance)
        : (user.balance != null ? num(user.balance) : num(mirrorRaw || rawFallback));
      const recovered = reconcileApprovedWalletTopups(canonical || user, seedBalance);
      if (recovered != null) return recovered;
      if (mirrorRaw != null && mirrorRaw !== '') {
        const mirrored = num(mirrorRaw);
        syncWalletMirrors(mirrored, email);
        return mirrored;
      }
      if (canonical && canonical.balance != null) {
        syncSessionAccount(canonical);
        return num(canonical.balance);
      }
      if (user.balance != null) {
        syncWalletMirrors(user.balance, email);
        return num(user.balance);
      }
      return num(rawFallback);
    }
    return 0;
  }

  function normalizeAccountRows(raw) {
    if (Array.isArray(raw)) return raw.slice();
    if (raw && typeof raw === 'object') {
      return Object.keys(raw).map(function (key) {
        const row = raw[key];
        if (row && typeof row === 'object') return { id: row.id || key, ...row };
        return { id: key, value: row };
      });
    }
    return [];
  }

  function readAccountRows(key) {
    return normalizeAccountRows(readParsedValue(getStorageAdapter().getItem(key), []));
  }

  function resolveCanonicalAccount(user) {
    const email = cleanEmail(user && user.email);
    if (!email) return null;
    const preferred = isSellerUser(user) ? ['sellers', 'users'] : ['users', 'sellers'];
    for (let i = 0; i < preferred.length; i += 1) {
      const rows = readAccountRows(preferred[i]);
      const match = rows.find(function (row) {
        return cleanEmail(row && row.email) === email;
      });
      if (match) return match;
    }
    return null;
  }

  function readPaymentRows() {
    return normalizeAccountRows(readParsedValue(getStorageAdapter().getItem('pendingRequests'), []));
  }

  function writePaymentRows(rows) {
    try {
      getStorageAdapter().setItem('pendingRequests', JSON.stringify(Array.isArray(rows) ? rows : []));
      return true;
    } catch (_) {
      return false;
    }
  }

  function persistResolvedBalance(user, nextBalance) {
    const email = cleanEmail(user && user.email);
    if (!email) return null;
    const adapter = getStorageAdapter();
    ['users', 'sellers'].forEach(function (key) {
      const rows = readAccountRows(key);
      let changed = false;
      const nextRows = rows.map(function (row) {
        if (cleanEmail(row && row.email) !== email) return row;
        changed = true;
        return { ...row, balance: nextBalance, paymentStatus: 'Paid', status: row.status || 'Approved' };
      });
      if (!changed) return;
      try { adapter.setItem(key, JSON.stringify(nextRows)); } catch (_) {}
    });
    syncSessionAccount({ ...user, balance: nextBalance, paymentStatus: 'Paid' });
    return nextBalance;
  }

  function reconcileApprovedWalletTopups(user, baselineBalance) {
    const email = cleanEmail(user && user.email);
    if (!email) return null;

    const currentBalance = Math.max(0, num(baselineBalance));
    if (currentBalance > 0) return null;

    const rows = readPaymentRows();
    if (!rows.length) return null;

    let nextBalance = currentBalance;
    let changed = false;

    rows.forEach(function (row, idx) {
      if (cleanEmail(row && row.email) !== email) return;
      const type = str(row && (row.type || row.requestType || row.plan || '')).toLowerCase();
      if (type.indexOf('top') < 0) return;
      const status = str(row && (row.status || row.paymentStatus || '')).toLowerCase();
      if (status === 'approved' || status === 'paid' || status === 'success') {
        if (row && !row.walletCreditedAt) {
          const amount = Math.max(0, num(row.amount));
          if (amount > 0) {
            nextBalance += amount;
            rows[idx] = { ...row, status: 'Approved', paymentStatus: 'Paid', walletCreditedAt: new Date().toISOString() };
            changed = true;
          }
        }
      }
    });

    if (!changed || nextBalance <= 0) return null;
    writePaymentRows(rows);
    persistResolvedBalance(user, nextBalance);
    return nextBalance;
  }

  function syncWalletMirrors(amount, email) {
    try {
      const adapter = getStorageAdapter();
      const next = String(num(amount));
      adapter.setItem(KEYS.USER_BALANCE, next);
      adapter.setItem(KEYS.BALANCE, next);
      const mirrorKey = balanceMirrorKey(email || (readActiveUser() && readActiveUser().email));
      if (mirrorKey) adapter.setItem(mirrorKey, next);
    } catch (_) {}
  }

  function syncSessionAccount(account) {
    if (!account || typeof account !== 'object') return null;
    const email = cleanEmail(account.email);
    if (!email) return null;
    const adapter = getStorageAdapter();
    const keys = [KEYS.USER, 'loggedInUser', 'currentSeller'];
    let mergedUser = null;

    keys.forEach(function (key) {
      const existing = parseStoredJson(adapter.getItem(key), null);
      if (!existing || typeof existing !== 'object') return;
      if (cleanEmail(existing.email) !== email) return;
      const nextUser = { ...existing, ...account };
      if (key === 'currentSeller' && !isSellerUser(nextUser)) {
        try { adapter.removeItem(key); } catch (_) {}
        return;
      }
      try { adapter.setItem(key, JSON.stringify(nextUser)); } catch (_) {}
      if (!mergedUser) mergedUser = nextUser;
    });

    syncWalletMirrors(account.balance, email);
    return mergedUser || { ...account };
  }

  function updateHeaderUser() {
    const activeUser = readActiveUser() || {};
    const canonical = (!isGuestSessionUser(activeUser) && resolveCanonicalAccount(activeUser)) || null;
    const user = canonical ? (syncSessionAccount(canonical) || { ...activeUser, ...canonical }) : activeUser;
    const loggedIn = !isGuestSessionUser(user);
    byId('userChip').textContent = 'Hi, ' + str(loggedIn ? (user.fullName || user.name || user.email) : 'Guest');
    const accountLink = byId('accountLink');
    if (accountLink) {
      accountLink.href = loggedIn ? 'settings.html' : 'login.html?next=index.html';
      accountLink.setAttribute('aria-label', loggedIn ? 'Open account' : 'Open login');
      accountLink.title = loggedIn ? 'Open account settings' : 'Login to your account';
    }
    const wallet = byId('walletBalanceChip');
    if (wallet) wallet.textContent = money(readWalletBalance());
    const topup = byId('walletTopupLink');
    if (topup) topup.href = loggedIn ? 'confirm-payment.html' : 'login.html?next=confirm-payment.html';
  }

  function readCart() {
    const rows = read(KEYS.CART, []);
    if (!Array.isArray(rows)) return [];
    return rows.map(function (r) {
      return {
        id: str(r.id || r.productId || ''),
        name: str(r.name || 'Product'),
        price: num(r.price),
        image: str(r.image || 'matrixx.png'),
        seller: str(r.seller || r.sellerName || ''),
        sellerEmail: str(r.sellerEmail || '').toLowerCase(),
        category: str(r.category || 'general'),
        quantity: Math.max(1, Math.floor(num(r.quantity || 1)))
      };
    });
  }

  function writeCart(rows) {
    write(KEYS.CART, rows);
    write(KEYS.CART_ITEMS, rows);
    writeCartBridge(rows);
  }

  function updateCartCount() {
    const total = readCart().reduce(function (sum, row) { return sum + Math.max(1, Math.floor(num(row.quantity))); }, 0);
    byId('cartLink').textContent = 'Cart (' + total + ')';
  }

  function normText(v) {
    return str(v).trim().toLowerCase();
  }

  function findProduct(key) {
    return state.products.find(function (p) { return p._key === key; }) || null;
  }

  function productForHeroSlot(slot) {
    if (slot === 'newest') return findProduct(state.hero.newestKey);
    if (slot === 'topSold') return findProduct(state.hero.topSoldKey);
    return null;
  }

  function readPurchases() {
    const rows = read('purchases', []);
    return Array.isArray(rows) ? rows.slice() : [];
  }

  function matchPurchaseProduct(row) {
    const name = normText(row && (row.productName || row.name));
    const sellerEmail = normText(row && row.sellerEmail);
    const sellerName = normText(row && (row.seller || row.sellerName));
    if (!name) return null;

    return state.products.find(function (product) {
      if (normText(product.name) !== name) return false;
      if (sellerEmail && normText(product.sellerEmail) === sellerEmail) return true;
      if (sellerName && normText(product.seller) === sellerName) return true;
      return !sellerEmail && !sellerName;
    }) || null;
  }

  function qtyFor(key, max) {
    const target = encodeURIComponent(key);
    const nodes = document.querySelectorAll('input[data-qty]');
    for (let i = 0; i < nodes.length; i += 1) {
      if (str(nodes[i].getAttribute('data-qty')) === target) {
        const q = Math.floor(num(nodes[i].value));
        return Math.max(1, Math.min(max, q));
      }
    }
    return 1;
  }

  function toCartItem(product, qty) {
    return {
      id: product.id,
      name: product.name,
      price: product.price,
      image: product.image,
      seller: product.seller,
      sellerEmail: product.sellerEmail,
      category: product.category,
      quantity: Math.max(1, Math.floor(num(qty || 1)))
    };
  }

  function addToCart(product, qty, silent) {
    if (!product || product.stock <= 0) return;
    const cart = readCart();
    const wanted = Math.max(1, Math.floor(num(qty || 1)));
    const existing = cart.find(function (item) {
      return str(item.id) === str(product.id) ||
        (str(item.name).toLowerCase() === str(product.name).toLowerCase() && str(item.sellerEmail).toLowerCase() === str(product.sellerEmail).toLowerCase());
    });

    if (existing) {
      existing.quantity = Math.min(product.stock, Math.max(1, Math.floor(num(existing.quantity))) + wanted);
    } else {
      cart.push(toCartItem(product, Math.min(product.stock, wanted)));
    }

    writeCart(cart);
    updateCartCount();
    if (!silent) toast(product.name + ' added to cart.');
  }

  function buyNow(product, qty) {
    if (!product) return;
    const q = Math.max(1, Math.min(product.stock, Math.floor(num(qty || 1))));
    addToCart(product, q, true);
    const line = toCartItem(product, q);
    const subtotal = line.price * line.quantity;
    const shipping = subtotal >= 500 ? 0 : 25;
    const meta = {
      coupon: null,
      subtotal: subtotal,
      discount: 0,
      shipping: shipping,
      total: subtotal + shipping
    };
    write(KEYS.CHECKOUT_CART, [line]);
    write(KEYS.CHECKOUT_META, meta);
    writeCheckoutBridge([line], meta);
    window.location.href = 'checkout.html';
  }

  function renderFiltersOptions() {
    const cat = byId('categoryFilter');
    const seller = byId('sellerFilter');
    const keepCat = cat.value;
    const keepSeller = seller.value;

    const categories = Array.from(new Set(state.products.map(function (p) { return p.category; }))).sort(function (a, b) { return a.localeCompare(b); });
    const sellers = Array.from(new Set(state.products.map(function (p) { return p.seller; }))).sort(function (a, b) { return a.localeCompare(b); });

    cat.innerHTML = '<option value="">All Categories</option>' + categories.map(function (name) {
      return '<option value="' + esc(name) + '">' + esc(name) + '</option>';
    }).join('');

    seller.innerHTML = '<option value="">All Sellers</option>' + sellers.map(function (name) {
      return '<option value="' + esc(name) + '">' + esc(name) + '</option>';
    }).join('');

    if (categories.includes(keepCat)) cat.value = keepCat;
    if (sellers.includes(keepSeller)) seller.value = keepSeller;
  }

  function renderStats() {
    const rows = state.filtered.length ? state.filtered : state.products;
    const sellers = new Set(rows.map(function (p) { return p.seller; })).size;
    const categories = new Set(rows.map(function (p) { return p.category; })).size;
    const avg = rows.length ? rows.reduce(function (sum, p) { return sum + p.price; }, 0) / rows.length : 0;

    const counts = {};
    state.products.forEach(function (p) { counts[p.seller] = (counts[p.seller] || 0) + 1; });
    const topSeller = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0] || 'N/A';

    const cards = [
      ['Visible', state.filtered.length],
      ['All Products', state.products.length],
      ['Sellers', sellers],
      ['Categories', categories],
      ['Avg Price', money(avg)],
      ['Top Seller', topSeller],
      ['Wishlist', state.wishlist.size],
      ['Last Sync', state.lastSync]
    ];

    byId('statsGrid').innerHTML = cards.map(function (row) {
      return '<article class="mm-stat"><div class="label">' + esc(row[0]) + '</div><div class="value">' + esc(row[1]) + '</div></article>';
    }).join('');
  }

  function computeHeroHighlights() {
    state.hero.newestKey = state.products.length ? state.products[0]._key : '';

    const sellerCounts = {};
    state.products.forEach(function (product) {
      sellerCounts[product.seller] = (sellerCounts[product.seller] || 0) + 1;
    });

    const topSeller = Object.keys(sellerCounts).sort(function (a, b) {
      return sellerCounts[b] - sellerCounts[a];
    })[0] || '';

    state.hero.topSellerName = topSeller;
    state.hero.topSellerCount = topSeller ? sellerCounts[topSeller] : 0;
    state.hero.freshCount = state.products.filter(function (product) {
      const age = Date.now() - product.createdStamp;
      return age >= 0 && age <= 86400000;
    }).length;

    const salesMap = new Map();
    readPurchases().forEach(function (row) {
      const product = matchPurchaseProduct(row);
      if (!product) return;

      const qty = Math.max(1, Math.floor(num(row.quantity || 1)));
      const total = num(row.total || (num(row.price) * qty));
      const prev = salesMap.get(product._key) || {
        product: product,
        units: 0,
        orders: 0,
        revenue: 0
      };

      prev.units += qty;
      prev.orders += 1;
      prev.revenue += total;
      salesMap.set(product._key, prev);
    });

    let winner = null;
    salesMap.forEach(function (entry) {
      if (!winner) {
        winner = entry;
        return;
      }
      if (entry.units > winner.units) {
        winner = entry;
        return;
      }
      if (entry.units === winner.units && entry.revenue > winner.revenue) {
        winner = entry;
        return;
      }
      if (entry.units === winner.units && entry.revenue === winner.revenue && entry.product.createdStamp > winner.product.createdStamp) {
        winner = entry;
      }
    });

    state.hero.topSoldKey = winner ? winner.product._key : '';
    state.hero.topSoldUnits = winner ? winner.units : 0;
    state.hero.topSoldOrders = winner ? winner.orders : 0;
    state.hero.topSoldRevenue = winner ? winner.revenue : 0;
  }

  function renderHeroHighlights() {
    const newest = productForHeroSlot('newest');
    const topSold = productForHeroSlot('topSold');

    const newestImage = byId('heroNewestImage');
    const newestName = byId('heroNewestName');
    const newestMeta = byId('heroNewestMeta');
    const newestPrice = byId('heroNewestPrice');
    const newestSeller = byId('heroNewestSeller');
    const newestTime = byId('heroNewestTime');
    const newestOpen = byId('heroNewestOpenBtn');
    const newestCart = byId('heroNewestCartBtn');

    if (newest) {
      newestImage.src = newest.image || 'matrixx.png';
      newestName.textContent = newest.name;
      newestMeta.textContent = (newest.category || 'General') + ' now live from ' + newest.seller + (newest.location ? ' in ' + newest.location : '') + '.';
      newestPrice.textContent = money(newest.price);
      newestSeller.textContent = 'Seller: ' + newest.seller;
      newestTime.textContent = 'Posted ' + ago(newest.createdAt);
      newestOpen.disabled = false;
      newestCart.disabled = newest.stock <= 0;
    } else {
      newestImage.src = 'matrixx.png';
      newestName.textContent = 'Waiting for fresh listings';
      newestMeta.textContent = 'MatrixMarket will feature the newest active seller listing here after sync.';
      newestPrice.textContent = '0.00 GMD';
      newestSeller.textContent = 'Seller: Marketplace';
      newestTime.textContent = 'Just synced';
      newestOpen.disabled = true;
      newestCart.disabled = true;
    }

    const topSoldName = byId('heroTopSoldName');
    const topSoldMeta = byId('heroTopSoldMeta');
    const topSoldPrice = byId('heroTopSoldPrice');
    const topSoldUnits = byId('heroTopSoldUnits');
    const topSoldOpen = byId('heroTopSoldOpenBtn');
    const topSoldBuy = byId('heroTopSoldBuyBtn');

    if (topSold) {
      const orderLabel = state.hero.topSoldOrders === 1 ? 'order' : 'orders';
      topSoldName.textContent = topSold.name;
      topSoldMeta.textContent = topSold.seller + ' is leading sales with ' + state.hero.topSoldOrders + ' ' + orderLabel + ' and ' + money(state.hero.topSoldRevenue) + ' in revenue.';
      topSoldPrice.textContent = money(topSold.price);
      topSoldUnits.textContent = state.hero.topSoldUnits + ' sold';
      topSoldOpen.disabled = false;
      topSoldBuy.disabled = topSold.stock <= 0;
    } else {
      topSoldName.textContent = 'Sales data will appear here';
      topSoldMeta.textContent = 'Once customers start ordering, this card will show the strongest moving product.';
      topSoldPrice.textContent = '0.00 GMD';
      topSoldUnits.textContent = '0 sold';
      topSoldOpen.disabled = true;
      topSoldBuy.disabled = true;
    }

    const freshCount = byId('heroFreshCount');
    const freshMeta = byId('heroFreshMeta');
    if (freshCount) {
      freshCount.textContent = state.hero.freshCount + (state.hero.freshCount === 1 ? ' product posted in the last 24 hours' : ' products posted in the last 24 hours');
    }
    if (freshMeta) {
      freshMeta.textContent = state.hero.freshCount
        ? 'Fresh inventory keeps the homepage active for repeat buyers and stronger conversion.'
        : 'New active seller uploads show up here after every sync.';
    }

    const sellerName = byId('heroSellerName');
    const sellerMeta = byId('heroSellerMeta');
    if (state.hero.topSellerName) {
      sellerName.textContent = state.hero.topSellerName;
      sellerMeta.textContent = state.hero.topSellerCount + (state.hero.topSellerCount === 1 ? ' live product is' : ' live products are') + ' available from this seller right now.';
    } else {
      sellerName.textContent = 'No seller highlights yet';
      sellerMeta.textContent = 'The seller with the deepest live catalog will appear here.';
    }
  }

  function renderLatest() {
    const box = byId('latestGrid');
    if (!state.latest.length) {
      box.innerHTML = '<div class="mm-empty">No latest products yet.</div>';
      return;
    }

    box.innerHTML = state.latest.map(function (p) {
      const id = encodeURIComponent(p._key);
      return '<article class="mm-latest-item">' +
        '<img loading="lazy" decoding="async" fetchpriority="low" src="' + esc(p.image) + '" alt="' + esc(p.name) + '">' +
        '<div class="body">' +
        '<strong>' + esc(p.name) + '</strong>' +
        '<div class="mm-meta">' + esc(p.category) + ' | ' + esc(p.seller) + '</div>' +
        '<div class="mm-price">' + money(p.price) + '</div>' +
        '<div class="mm-actions"><button class="mm-btn" type="button" data-latest="open" data-key="' + id + '">Open</button><button class="mm-btn" type="button" data-latest="cart" data-key="' + id + '">Add</button></div>' +
        '</div></article>';
    }).join('');
  }

  function renderCategoryChips() {
    const map = {};
    state.products.forEach(function (p) { map[p.category] = (map[p.category] || 0) + 1; });
    const rows = Object.keys(map).sort(function (a, b) { return map[b] - map[a]; }).slice(0, 10);
    const chips = ['<button type="button" data-chip="" class="mm-chip mm-chip-filter ' + (state.chip ? '' : 'active') + '">All</button>'];
    rows.forEach(function (cat) {
      chips.push('<button type="button" data-chip="' + esc(cat) + '" class="mm-chip mm-chip-filter ' + (state.chip === cat ? 'active' : '') + '">' + esc(formatLabel(cat)) + ' (' + map[cat] + ')</button>');
    });
    byId('categoryChips').innerHTML = chips.join('');
  }

  function renderCategoryTiles() {
    const box = byId('categoryGrid');
    if (!box) return;

    function categoryMonogram(name) {
      const words = str(name).trim().split(/\s+/).filter(Boolean);
      if (!words.length) return 'MM';
      if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
      return (words[0][0] + words[1][0]).toUpperCase();
    }

    function countLabel(count) {
      return count + ' live product' + (count === 1 ? '' : 's');
    }

    const grouped = {};
    state.products.forEach(function (p) {
      const key = str(p.category || 'General').trim() || 'General';
      if (!grouped[key]) {
        grouped[key] = {
          count: 0,
          image: p.image || 'matrixx.png'
        };
      }
      grouped[key].count += 1;
      if (!grouped[key].image && p.image) grouped[key].image = p.image;
    });

    const rows = Object.keys(grouped).sort(function (a, b) {
      return grouped[b].count - grouped[a].count;
    }).slice(0, 8);

    if (!rows.length) {
      box.innerHTML = '<div class="mm-empty">Categories will appear once products are available.</div>';
      return;
    }

    box.innerHTML = rows.map(function (name) {
      const row = grouped[name];
      const mono = categoryMonogram(name);
      const countText = countLabel(row.count);
      return '<button class="mm-category-card" type="button" data-category-card="' + esc(name) + '">' +
        '<div class="mm-category-card-top">' +
        '<span class="mm-category-badge">' + (row.count > 1 ? 'Top live' : 'Live now') + '</span>' +
        '<span class="mm-category-count">' + countText + '</span>' +
        '</div>' +
        '<div class="mm-category-image-shell">' +
        (row.image ? '<img loading="lazy" decoding="async" fetchpriority="low" src="' + esc(row.image) + '" alt="' + esc(name) + '">' : '<span class="mm-category-monogram" aria-hidden="true">' + esc(mono) + '</span>') +
        '</div>' +
        '<div class="mm-category-copy">' +
        '<strong>' + esc(formatLabel(name)) + '</strong>' +
        '<span>Fast access to active listings in this category.</span>' +
        '</div>' +
        '<div class="mm-category-card-foot">' +
        '<span>Open category</span>' +
        '<span aria-hidden="true">→</span>' +
        '</div>' +
        '</button>';
    }).join('');
  }

  function renderSellerList() {
    const map = {};
    state.products.forEach(function (p) {
      map[p.seller] = map[p.seller] || { products: 0, units: 0 };
      map[p.seller].products += 1;
      map[p.seller].units += p.stock;
    });
    const rows = Object.keys(map).sort(function (a, b) { return map[b].products - map[a].products; }).slice(0, 8);
    if (!rows.length) {
      byId('sellerList').innerHTML = '<div class="mm-empty">No seller data.</div>';
      return;
    }
    byId('sellerList').innerHTML = rows.map(function (name) {
      return '<div class="mm-item"><div>' + esc(name) + '</div><div class="mm-meta">Products: ' + map[name].products + ' | Units: ' + map[name].units + '</div><div class="row"><button class="mm-btn" type="button" data-seller="' + esc(name) + '">Filter</button></div></div>';
    }).join('');
  }

  function renderQuickModes() {
    const map = {
      today: byId('todayFilterBtn'),
      budget: byId('budgetFilterBtn'),
      highStock: byId('highStockFilterBtn')
    };
    Object.keys(map).forEach(function (mode) {
      const node = map[mode];
      if (!node) return;
      node.classList.toggle('active', state.quickMode === mode);
    });
  }

  function renderCompare() {
    const box = byId('compareList');
    const clearBtn = byId('compareClearBtn');
    const compareTitle = byId('compareInsightTitle');
    const compareMeta = byId('compareInsightMeta');
    const keys = Array.from(state.compare).slice(0, 3);
    const rows = keys.map(findProduct).filter(Boolean);
    byId('compareCount').textContent = rows.length + ' selected';

    if (!rows.length) {
      if (clearBtn) clearBtn.disabled = true;
      if (compareTitle) compareTitle.textContent = 'Ready to compare smartly';
      if (compareMeta) compareMeta.textContent = 'Add up to 3 products to compare price, stock, category, and seller strength side by side.';
      box.innerHTML = '<div class="mm-empty">Add up to 3 products to compare price, stock and seller.</div>';
      return;
    }

    if (clearBtn) clearBtn.disabled = false;
    const cheapest = rows.reduce(function (best, row) { return !best || row.price < best.price ? row : best; }, null);
    const strongestStock = rows.reduce(function (best, row) { return !best || row.stock > best.stock ? row : best; }, null);

    if (compareTitle) compareTitle.textContent = cheapest ? ('Lowest price: ' + cheapest.name) : 'Compare products';
    if (compareMeta) {
      compareMeta.textContent = cheapest && strongestStock
        ? (cheapest.name + ' is currently the lowest price, while ' + strongestStock.name + ' carries the deepest stock.')
        : 'Compare price, stock, category, and seller strength side by side.';
    }

    box.innerHTML = rows.map(function (p) {
      const id = encodeURIComponent(p._key);
      const ribbon = cheapest && p._key === cheapest._key ? 'Best price' : (strongestStock && p._key === strongestStock._key ? 'Deepest stock' : 'Compare pick');
      const gap = cheapest ? num(p.price) - num(cheapest.price) : 0;
      const priceDelta = gap <= 0 ? 'Lowest in compare' : ('+' + money(gap) + ' vs lowest');
      return '<article class="mm-compare-item">' +
        '<img loading="lazy" decoding="async" fetchpriority="low" src="' + esc(p.image) + '" alt="' + esc(p.name) + '">' +
        '<div class="mm-compare-item-body">' +
        '<span class="mm-compare-ribbon">' + esc(ribbon) + '</span>' +
        '<h4>' + esc(p.name) + '</h4>' +
        '<div class="mm-price">' + money(p.price) + '</div>' +
        '<div class="mm-compare-stats">' +
        '<div class="mm-compare-stat"><small>Seller</small><strong>' + esc(p.seller) + '</strong></div>' +
        '<div class="mm-compare-stat"><small>Category</small><strong>' + esc(formatLabel(p.category)) + '</strong></div>' +
        '<div class="mm-compare-stat"><small>Stock</small><strong>' + p.stock + ' units</strong></div>' +
        '<div class="mm-compare-stat"><small>Price signal</small><strong>' + esc(priceDelta) + '</strong></div>' +
        '</div>' +
        '<div class="mm-meta">' + esc(p.location || 'Location not set') + ' | Posted ' + esc(ago(p.createdAt)) + '</div>' +
        '<div class="mm-compare-actions">' +
        '<button class="mm-btn" type="button" data-compare-action="open" data-key="' + id + '">View</button>' +
        '<button class="mm-btn" type="button" data-compare-action="remove" data-key="' + id + '">Remove</button>' +
        '</div></div>' +
        '</article>';
    }).join('');
  }

  function renderMarketInsights() {
    const rows = state.filtered.length ? state.filtered.slice() : state.products.slice();
    const title = byId('marketBannerTitle');
    const meta = byId('marketBannerMeta');
    const range = byId('marketRangeMeta');
    const leadCategory = byId('marketLeadCategory');
    const fresh = byId('marketFreshMeta');

    if (!rows.length) {
      if (title) title.textContent = 'Marketplace catalog is waiting for active products';
      if (meta) meta.textContent = 'As soon as products sync in, this area will summarize pricing, lead categories, and fresh inventory.';
      if (range) range.textContent = '0.00 GMD - 0.00 GMD';
      if (leadCategory) leadCategory.textContent = 'No active category yet';
      if (fresh) fresh.textContent = '0 new this week';
      return;
    }

    const prices = rows.map(function (row) { return num(row.price); }).sort(function (a, b) { return a - b; });
    const categoryMap = {};
    const sellerMap = {};
    let freshCount = 0;
    rows.forEach(function (row) {
      categoryMap[row.category] = (categoryMap[row.category] || 0) + 1;
      sellerMap[row.seller] = (sellerMap[row.seller] || 0) + 1;
      if (isFreshListing(row, 7)) freshCount += 1;
    });
    const topCategory = Object.keys(categoryMap).sort(function (a, b) { return categoryMap[b] - categoryMap[a]; })[0] || '';
    const topSeller = Object.keys(sellerMap).sort(function (a, b) { return sellerMap[b] - sellerMap[a]; })[0] || '';

    if (title) {
      title.textContent = rows.length + (rows.length === 1 ? ' live listing is ready to shop' : ' live listings are ready to shop');
    }
    if (meta) {
      meta.textContent = 'Lead seller: ' + (topSeller || 'Marketplace') + '. Strongest category: ' + (topCategory ? formatLabel(topCategory) : 'General') + '. Use compare to spot the best-value offer faster.';
    }
    if (range) range.textContent = money(prices[0]) + ' - ' + money(prices[prices.length - 1]);
    if (leadCategory) {
      const count = topCategory ? categoryMap[topCategory] : 0;
      leadCategory.textContent = topCategory ? (formatLabel(topCategory) + ' (' + count + ')') : 'No active category yet';
    }
    if (fresh) fresh.textContent = freshCount + (freshCount === 1 ? ' fresh listing this week' : ' fresh listings this week');
  }

  function toggleCompare(key) {
    if (!key) return;
    if (state.compare.has(key)) {
      state.compare.delete(key);
    } else {
      if (state.compare.size >= 3) {
        toast('Compare supports up to 3 products.');
        return;
      }
      state.compare.add(key);
    }
    write(KEYS.COMPARE, Array.from(state.compare));
    renderCompare();
    renderProducts();
  }

  function renderWishlist() {
    const box = byId('wishlistList');
    const keys = Array.from(state.wishlist);
    byId('wishlistCount').textContent = String(keys.length);
    if (!keys.length) {
      box.innerHTML = '<div class="mm-empty">No saved products.</div>';
      return;
    }
    box.innerHTML = keys.map(findProduct).filter(Boolean).slice(0, 8).map(function (p) {
      const id = encodeURIComponent(p._key);
      return '<div class="mm-item"><div>' + esc(p.name) + '</div><div class="mm-meta">' + money(p.price) + ' | ' + esc(p.seller) + '</div><div class="row"><button class="mm-btn" type="button" data-wish="open" data-key="' + id + '">Open</button><button class="mm-btn" type="button" data-wish="remove" data-key="' + id + '">Remove</button></div></div>';
    }).join('');
  }
  function renderRecent() {
    const box = byId('recentList');
    if (!state.recent.length) {
      box.innerHTML = '<div class="mm-empty">No recent products.</div>';
      return;
    }
    const rows = state.recent.map(findProduct).filter(Boolean).slice(0, 8);
    if (!rows.length) {
      box.innerHTML = '<div class="mm-empty">No recent products.</div>';
      return;
    }
    box.innerHTML = rows.map(function (p) {
      const id = encodeURIComponent(p._key);
      return '<div class="mm-item"><div>' + esc(p.name) + '</div><div class="mm-meta">' + esc(p.category) + ' | ' + esc(ago(p.createdAt)) + '</div><div class="row"><button class="mm-btn" type="button" data-recent="open" data-key="' + id + '">Open</button></div></div>';
    }).join('');
  }

  function trackRecent(key) {
    state.recent = state.recent.filter(function (x) { return x !== key; });
    state.recent.unshift(key);
    state.recent = state.recent.slice(0, 10);
    write(KEYS.RECENT, state.recent);
  }

  function applyFilters(pushUrl, skipRecover) {
    const q = str(byId('searchInput').value).trim().toLowerCase();
    const minPrice = Math.max(0, num(byId('minPrice').value || 0));
    const category = str(byId('categoryFilter').value);
    const seller = str(byId('sellerFilter').value);
    const minStock = Math.max(0, Math.floor(num(byId('stockFilter').value || 0)));
    const fresh = num(byId('freshFilter').value);
    const sort = str(byId('sortFilter').value || 'newest');
    const maxPrice = num(byId('maxPrice').value || state.maxPriceCap);
    const wishlistForced = state.onlyWishlist && state.wishlist.size === 0;

    if (wishlistForced) {
      state.onlyWishlist = false;
      savePrefs();
    }

    state.filtered = state.products.filter(function (p) {
      const hay = [p.name, p.category, p.seller, p.sellerEmail, p.location, p.description].join(' ').toLowerCase();
      if (q && hay.indexOf(q) < 0) return false;
      if (p.price < minPrice) return false;
      if (category && p.category !== category) return false;
      if (seller && p.seller !== seller) return false;
      if (minStock > 0 && p.stock < minStock) return false;
      if (p.price > maxPrice) return false;
      if (fresh > 0) {
        const age = Date.now() - p.createdStamp;
        if (age < 0 || age > fresh * 86400000) return false;
      }
      if (state.quickMode === 'today') {
        const age = Date.now() - p.createdStamp;
        if (age < 0 || age > 86400000) return false;
      }
      if (state.quickMode === 'budget' && p.price > 5000) return false;
      if (state.quickMode === 'highStock' && p.stock < 20) return false;
      if (state.onlyWishlist && !state.wishlist.has(p._key)) return false;
      if (state.chip && p.category !== state.chip) return false;
      return true;
    });

    state.filtered.sort(function (a, b) {
      if (sort === 'priceAsc') return a.price - b.price;
      if (sort === 'priceDesc') return b.price - a.price;
      if (sort === 'nameAsc') return a.name.localeCompare(b.name);
      if (sort === 'stockDesc') return b.stock - a.stock;
      return b.createdStamp - a.createdStamp;
    });

    const pages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    if (state.page > pages) state.page = pages;
    if (state.page < 1) state.page = 1;

    if (!state.filtered.length && state.products.length && !skipRecover) {
      let recovered = false;

      if (state.onlyWishlist) {
        state.onlyWishlist = false;
        recovered = true;
      }
      if (state.quickMode) {
        state.quickMode = '';
        recovered = true;
      }
      if (state.chip) {
        state.chip = '';
        recovered = true;
      }
      if (minPrice > 0) {
        byId('minPrice').value = '';
        recovered = true;
      }
      if (category) {
        byId('categoryFilter').value = '';
        recovered = true;
      }
      if (seller) {
        byId('sellerFilter').value = '';
        recovered = true;
      }
      if (minStock > 0) {
        byId('stockFilter').value = '';
        recovered = true;
      }
      if (fresh > 0) {
        byId('freshFilter').value = '';
        recovered = true;
      }
      if (maxPrice < state.maxPriceCap) {
        byId('maxPrice').value = String(state.maxPriceCap);
        state.maxPriceTouched = false;
        recovered = true;
      }

      if (recovered) {
        savePrefs();
        renderCategoryChips();
        return applyFilters(pushUrl, true);
      }
    }

    renderProducts();
    renderPager();
    renderStats();
    renderWishlist();
    renderRecent();
    renderCompare();
    renderMarketInsights();
    renderQuickModes();
    byId('gridBtn').classList.toggle('active', state.view === 'grid');
    byId('listBtn').classList.toggle('active', state.view === 'list');
    byId('wishlistOnlyBtn').classList.toggle('active', state.onlyWishlist);
    byId('resultChip').textContent = state.filtered.length + ' items';
    byId('maxPriceLabel').textContent = Math.floor(maxPrice) + ' GMD';
    byId('wishlistOnlyBtn').textContent = state.onlyWishlist ? 'Wishlist Only On' : 'Wishlist Only';
    const visibleUnits = state.filtered.reduce(function (sum, row) { return sum + row.stock; }, 0);
    const resultMeta = byId('resultMeta');
    const stockMeta = byId('stockMeta');
    if (resultMeta) resultMeta.textContent = 'Results: ' + state.filtered.length + ' / ' + state.products.length;
    if (stockMeta) stockMeta.textContent = 'Visible Units: ' + visibleUnits;

    if (pushUrl !== false) updateUrl();
  }

  function renderProducts() {
    const box = byId('productGrid');
    box.classList.toggle('list', state.view === 'list');
    const from = (state.page - 1) * state.pageSize;
    const rows = state.filtered.slice(from, from + state.pageSize);

    if (!rows.length) {
      box.innerHTML = '<div class="mm-empty">No products found for these filters.<div class="row"><button class="mm-btn" type="button" data-action="reset-all">Show All Products</button></div></div>';
      return;
    }

    box.innerHTML = rows.map(function (p) {
      const id = encodeURIComponent(p._key);
      const wishText = state.wishlist.has(p._key) ? 'Unsave' : 'Save';
      const compareText = state.compare.has(p._key) ? 'Uncompare' : 'Compare';
      const freshBadge = isFreshListing(p, 7) ? '<span class="badge-new">Fresh</span>' : '';
      const signal = priceSignal(p);
      const chatHref = 'chat.html?seller=' + encodeURIComponent(p.seller || '') + '&product=' + encodeURIComponent(p.name || '');
      return '<article class="mm-product-card ' + (state.wishlist.has(p._key) ? 'wish-active' : '') + '">' +
        '<div class="img-shell">' +
        freshBadge +
        '<span class="badge-sale">' + esc(signal) + '</span>' +
        '<img loading="lazy" decoding="async" fetchpriority="low" src="' + esc(p.image) + '" alt="' + esc(p.name) + '">' +
        '</div>' +
        '<div class="info">' +
        '<div class="product-topline">' +
        '<span class="market-pill">' + esc(formatLabel(p.category)) + '</span>' +
        '<span class="market-pill stock">' + p.stock + ' in stock</span>' +
        '</div>' +
        '<h3 class="pname">' + esc(p.name) + '</h3>' +
        '<div class="pprice">' + money(p.price) + '</div>' +
        '<div class="pseller">Seller: ' + esc(p.seller) + '</div>' +
        '<div class="psummary">' + esc(p.location || 'Location not set') + ' | Posted ' + esc(ago(p.createdAt)) + '</div>' +
        '<div class="product-detail-grid">' +
        '<span class="product-stat">Ready to buy</span>' +
        '<span class="product-stat">Signal: ' + esc(signal) + '</span>' +
        '</div>' +
        '<div class="product-qty-row">' +
        '<label for="qty-' + id + '">Qty</label>' +
        '<input id="qty-' + id + '" data-qty="' + id + '" type="number" min="1" max="' + p.stock + '" value="1">' +
        '</div>' +
        '</div>' +
        '<div class="card-actions">' +
        '<div class="card-actions-main">' +
        '<button class="mm-btn" type="button" data-action="cart" data-key="' + id + '">Add to Cart</button>' +
        '<button class="mm-btn mm-primary" type="button" data-action="buy" data-key="' + id + '">Buy Now</button>' +
        '</div>' +
        '<div class="card-actions-secondary">' +
        '<button class="mm-btn wish-btn ' + (state.wishlist.has(p._key) ? 'active' : '') + '" type="button" data-action="wish" data-key="' + id + '">' + wishText + '</button>' +
        '<button class="mm-btn compare-btn ' + (state.compare.has(p._key) ? 'active' : '') + '" type="button" data-action="compare" data-key="' + id + '">' + compareText + '</button>' +
        '<a href="' + esc(chatHref) + '">Chat</a>' +
        '<button class="mm-btn" type="button" data-action="open" data-key="' + id + '">View</button>' +
        '</div>' +
        '</div>' +
        '</article>';
    }).join('');
  }

  function renderPager() {
    const box = byId('pager');
    const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    if (state.filtered.length <= state.pageSize) {
      box.innerHTML = '';
      return;
    }
    const out = [];
    out.push('<button type="button" data-page="' + (state.page - 1) + '" ' + (state.page === 1 ? 'disabled' : '') + '>Prev</button>');
    const start = Math.max(1, state.page - 2);
    const end = Math.min(totalPages, state.page + 2);
    for (let i = start; i <= end; i += 1) out.push('<button type="button" data-page="' + i + '" class="' + (i === state.page ? 'active' : '') + '">' + i + '</button>');
    out.push('<button type="button" data-page="' + (state.page + 1) + '" ' + (state.page >= totalPages ? 'disabled' : '') + '>Next</button>');
    box.innerHTML = out.join('');
  }

  function openModal(product) {
    if (!product) return;
    state.selected = product._key;
    trackRecent(product._key);
    renderRecent();
    byId('modalImage').src = product.image || 'matrixx.png';
    byId('modalName').textContent = product.name;
    byId('modalPrice').textContent = money(product.price);
    byId('modalMeta').textContent = 'Seller: ' + product.seller + ' | Category: ' + product.category + ' | Stock: ' + product.stock;
    byId('modalDesc').textContent = product.description || 'No description.';
    byId('modalWish').textContent = state.wishlist.has(product._key) ? 'Remove Wishlist' : 'Wishlist';
    byId('productModal').classList.add('open');
    byId('productModal').setAttribute('aria-hidden', 'false');
  }

  function closeModal() {
    byId('productModal').classList.remove('open');
    byId('productModal').setAttribute('aria-hidden', 'true');
  }

  function toggleWishlist(key) {
    if (!key) return;
    if (state.wishlist.has(key)) state.wishlist.delete(key);
    else state.wishlist.add(key);
    write(KEYS.WISHLIST, Array.from(state.wishlist));
    renderWishlist();
    renderProducts();
    renderStats();
  }

  function refreshProducts(silent) {
    const source = loadMarketplaceRows();
    const normalizedAll = normalizeRows(source).map(normalizeProduct).filter(function (p) {
      return Boolean(p && p.name);
    });
    let normalized = normalizedAll.filter(function (p) {
      return p.stock > 0 && p.isVisible !== false;
    });

    if (!normalized.length) {
      const latestFallback = readLatestRows().map(function (row, index) {
        return normalizeProduct({
          id: row.id || ('LATE-' + index),
          name: row.name || 'Product',
          category: row.category || 'general',
          seller: row.seller || row.sellerName || 'Unknown Seller',
          sellerEmail: row.sellerEmail || '',
          location: row.location || '',
          price: num(row.price),
          stock: Math.max(1, Math.floor(num(row.stock || 1))),
          image: row.image || 'matrixx.png',
          createdAt: row.createdAt || new Date().toISOString(),
          isVisible: true
        }, index);
      }).filter(function (p) { return p.stock > 0; });
      if (latestFallback.length) normalized = latestFallback;
    }

    if (!normalized.length && !remoteFallbackBusy) {
      fetchRemoteProductsDirect().then(function (rows) {
        if (Array.isArray(rows) && rows.length) {
          refreshProducts(true);
          toast('Loaded products from remote backup.');
        }
      });
    }

    const map = new Map();
    normalized.forEach(function (p) { map.set(p._key, p); });
    const nextProducts = Array.from(map.values()).sort(function (a, b) { return b.createdStamp - a.createdStamp; });
    const nextSignature = productSignature(nextProducts);
    const sameProducts = nextSignature === lastProductsSignature;

    state.products = nextProducts;
    lastProductsSignature = nextSignature;
    state.latest = state.products.slice(0, 8);

    state.compare = new Set(Array.from(state.compare).filter(function (key) {
      return state.products.some(function (p) { return p._key === key; });
    }).slice(0, 3));
    write(KEYS.COMPARE, Array.from(state.compare));

    state.lastSync = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    byId('syncChip').textContent = 'Last Sync: ' + state.lastSync;

    if (sameProducts) {
      if (state.products.length) {
        byId('syncNote').textContent = 'Catalog checked at ' + state.lastSync + '. No product changes detected.';
      } else {
        byId('syncNote').textContent = 'Catalog checked at ' + state.lastSync + '. No visible in-stock products yet.';
      }
      if (!silent) toast('Catalog is already up to date.');
      return;
    }

    computeHeroHighlights();

    write(KEYS.LATEST, state.latest.map(function (p) {
      return {
        id: p.id,
        name: p.name,
        category: p.category,
        seller: p.seller,
        sellerEmail: p.sellerEmail,
        image: p.image,
        price: p.price,
        stock: p.stock,
        location: p.location,
        createdAt: p.createdAt
      };
    }));

    const maxPrice = state.products.reduce(function (top, p) { return Math.max(top, p.price); }, 0);
    state.maxPriceCap = Math.max(200, Math.ceil(maxPrice / 100) * 100 || 2000);
    byId('maxPrice').max = String(state.maxPriceCap);
    if (!state.maxPriceTouched || num(byId('maxPrice').value) <= 0 || num(byId('maxPrice').value) === 2000) {
      byId('maxPrice').value = String(state.maxPriceCap);
    }
    if (num(byId('maxPrice').value) > state.maxPriceCap) byId('maxPrice').value = String(state.maxPriceCap);

    renderFiltersOptions();
    renderCategoryChips();
    renderCategoryTiles();
    renderHeroHighlights();
    renderLatest();
    renderSellerList();
    applyFilters(false);

    byId('syncChip').textContent = 'Last Sync: ' + state.lastSync;
    if (state.products.length) {
      byId('syncNote').textContent = 'Online sync completed at ' + state.lastSync + '. Showing ' + state.products.length + ' live products.';
    } else {
      byId('syncNote').textContent = 'Sync completed at ' + state.lastSync + '. No visible in-stock products yet. Trying remote backup...';
    }
    if (!silent) toast('Products synced.');
  }

  function exportCsv() {
    if (!state.filtered.length) {
      toast('No data to export.');
      return;
    }
    const lines = [['id', 'name', 'category', 'seller', 'price', 'stock', 'location', 'createdAt']];
    state.filtered.forEach(function (p) {
      lines.push([p.id, p.name, p.category, p.seller, p.price.toFixed(2), String(p.stock), p.location, p.createdAt]);
    });
    const csv = lines.map(function (row) {
      return row.map(function (cell) {
        return '"' + str(cell).replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'matrixmarket-home-products.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('CSV exported.');
  }

  function updateUrl() {
    const params = new URLSearchParams();
    const q = str(byId('searchInput').value).trim();
    const minPrice = Math.max(0, num(byId('minPrice').value || 0));
    const category = str(byId('categoryFilter').value);
    const seller = str(byId('sellerFilter').value);
    const minStock = Math.max(0, Math.floor(num(byId('stockFilter').value || 0)));
    const fresh = num(byId('freshFilter').value);
    const sort = str(byId('sortFilter').value);
    const maxPrice = num(byId('maxPrice').value);

    if (q) params.set('q', q);
    if (minPrice > 0) params.set('min', String(minPrice));
    if (category) params.set('category', category);
    if (seller) params.set('seller', seller);
    if (minStock > 0) params.set('stock', String(minStock));
    if (fresh > 0) params.set('fresh', String(fresh));
    if (sort !== 'newest') params.set('sort', sort);
    if (maxPrice < state.maxPriceCap) params.set('max', String(maxPrice));
    if (state.page > 1) params.set('page', String(state.page));
    if (state.pageSize !== 12) params.set('size', String(state.pageSize));
    if (state.view !== 'grid') params.set('view', state.view);
    if (state.onlyWishlist) params.set('wish', '1');
    if (state.chip) params.set('chip', state.chip);
    if (state.quickMode) params.set('quick', state.quickMode);

    const next = params.toString();
    const url = window.location.pathname + (next ? ('?' + next) : '');
    window.history.replaceState(null, '', url);
  }

  function applyUrl() {
    const p = new URLSearchParams(window.location.search);
    if (p.has('q')) byId('searchInput').value = p.get('q') || '';
    if (p.has('min')) byId('minPrice').value = String(Math.max(0, num(p.get('min'))));
    if (p.has('category')) byId('categoryFilter').value = p.get('category') || '';
    if (p.has('seller')) byId('sellerFilter').value = p.get('seller') || '';
    if (p.has('stock')) byId('stockFilter').value = String(Math.max(0, Math.floor(num(p.get('stock')))));
    if (p.has('fresh')) byId('freshFilter').value = p.get('fresh') || '';
    if (p.has('sort')) byId('sortFilter').value = p.get('sort') || 'newest';
    if (p.has('max')) byId('maxPrice').value = String(Math.max(0, num(p.get('max'))));
    if (p.has('max')) state.maxPriceTouched = true;
    if (p.has('page')) state.page = Math.max(1, Math.floor(num(p.get('page'))));
    if (p.has('size')) {
      const size = num(p.get('size'));
      if ([8, 12, 16, 24].includes(size)) {
        state.pageSize = size;
        byId('pageSizeFilter').value = String(size);
      }
    }
    if (p.has('view')) {
      const view = p.get('view');
      if (view === 'list' || view === 'grid') state.view = view;
    }
    state.onlyWishlist = p.get('wish') === '1';
    state.chip = p.get('chip') || '';
    const quick = p.get('quick') || '';
    if (quick === 'today' || quick === 'budget' || quick === 'highStock') state.quickMode = quick;
  }

  function shareFilters() {
    updateUrl();
    const url = window.location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        toast('Filter link copied.');
      }).catch(function () {
        toast('Copy failed.');
      });
      return;
    }
    toast('Copy not supported.');
  }

  function closeHeader(force) {
    if (!force && window.innerWidth > 1100) return;
    const header = byId('mmHeader');
    const toggle = byId('menuToggle');
    if (!header) return;
    header.classList.remove('open');
    if (toggle) {
      toggle.textContent = 'Menu';
      toggle.setAttribute('aria-expanded', 'false');
    }
  }

  function setSidebarOpen(open) {
    const shell = byId('marketShell');
    const toggle = byId('sidebarToggle');
    if (!shell || !toggle) return;
    const active = Boolean(open);
    shell.classList.toggle('filters-open', active);
    toggle.setAttribute('aria-expanded', active ? 'true' : 'false');
    toggle.textContent = active ? 'Hide Filters and Saved Items' : 'Filters and Saved Items';
  }

  function setView(view) {
    state.view = view === 'list' ? 'list' : 'grid';
    byId('productGrid').classList.toggle('list', state.view === 'list');
    savePrefs();
    applyFilters(true);
  }

  function resetFilters() {
    byId('searchInput').value = '';
    byId('minPrice').value = '';
    byId('categoryFilter').value = '';
    byId('sellerFilter').value = '';
    byId('stockFilter').value = '';
    byId('freshFilter').value = '';
    byId('sortFilter').value = 'newest';
    byId('maxPrice').value = String(state.maxPriceCap);
    state.page = 1;
    state.chip = '';
    state.quickMode = '';
    state.maxPriceTouched = false;
    state.onlyWishlist = false;
    savePrefs();
    applyFilters(true);
    renderCategoryChips();
  }

  function bindEvents() {
    const menuToggle = byId('menuToggle');
    if (menuToggle) {
      menuToggle.addEventListener('click', function () {
        const header = byId('mmHeader');
        if (!header) return;
        const open = !header.classList.contains('open');
        header.classList.toggle('open', open);
        menuToggle.textContent = open ? 'Close' : 'Menu';
        menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }

    byId('mainNav').addEventListener('click', function (e) {
      if (e.target.closest('a')) closeHeader();
    });

    document.addEventListener('click', function (e) {
      if (window.innerWidth <= 1100 && !byId('mmHeader').contains(e.target)) closeHeader();
      if (window.innerWidth <= 980) {
        const shell = byId('marketShell');
        const sidebar = byId('marketSidebar');
        const toggle = byId('sidebarToggle');
        if (shell && sidebar && toggle && shell.classList.contains('filters-open') && !sidebar.contains(e.target) && !toggle.contains(e.target)) {
          setSidebarOpen(false);
        }
      }
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 1100) closeHeader(true);
      if (window.innerWidth > 980) setSidebarOpen(false);
    });

    byId('sidebarToggle').addEventListener('click', function () {
      const shell = byId('marketShell');
      setSidebarOpen(!(shell && shell.classList.contains('filters-open')));
    });

    byId('syncBtn').addEventListener('click', function () { requestRefreshProducts(false, 0); });

    byId('autoSyncBtn').addEventListener('click', function () {
      state.autoSync = !state.autoSync;
      byId('autoSyncBtn').textContent = state.autoSync ? 'Auto On' : 'Auto Off';
      savePrefs();
      toast(state.autoSync ? 'Auto sync on.' : 'Auto sync off.');
    });

    byId('headerSearchBtn').addEventListener('click', function () {
      byId('searchInput').value = byId('headerSearch').value.trim();
      state.page = 1;
      requestApplyFilters(true);
      closeHeader();
    });

    byId('headerSearch').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        byId('headerSearchBtn').click();
      }
    });

    byId('searchInput').addEventListener('input', function () {
      byId('headerSearch').value = this.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.page = 1;
        requestApplyFilters(true);
      }, 140);
    });

    byId('minPrice').addEventListener('input', function () {
      state.page = 1;
      requestApplyFilters(true);
    });

    ['categoryFilter', 'sellerFilter', 'stockFilter', 'freshFilter', 'sortFilter'].forEach(function (id) {
      byId(id).addEventListener('change', function () {
        state.page = 1;
        requestApplyFilters(true);
      });
    });

    byId('maxPrice').addEventListener('input', function () {
      state.maxPriceTouched = true;
      savePrefs();
      byId('maxPriceLabel').textContent = Math.floor(num(this.value)) + ' GMD';
      state.page = 1;
      requestApplyFilters(true);
    });

    byId('pageSizeFilter').addEventListener('change', function () {
      const size = num(this.value);
      if ([8, 12, 16, 24].includes(size)) state.pageSize = size;
      state.page = 1;
      savePrefs();
      requestApplyFilters(true);
    });

    byId('applyBtn').addEventListener('click', function () { state.page = 1; requestApplyFilters(true); });
    byId('resetBtn').addEventListener('click', resetFilters);
    byId('gridBtn').addEventListener('click', function () { setView('grid'); });
    byId('listBtn').addEventListener('click', function () { setView('list'); });

    byId('wishlistOnlyBtn').addEventListener('click', function () {
      if (!state.wishlist.size && !state.onlyWishlist) {
        toast('Wishlist is empty. Save products first.');
        return;
      }
      state.onlyWishlist = !state.onlyWishlist;
      this.textContent = state.onlyWishlist ? 'Wishlist Only On' : 'Wishlist Only';
      savePrefs();
      state.page = 1;
      requestApplyFilters(true);
    });

    byId('todayFilterBtn').addEventListener('click', function () {
      state.quickMode = state.quickMode === 'today' ? '' : 'today';
      byId('freshFilter').value = state.quickMode === 'today' ? '1' : '';
      state.page = 1;
      savePrefs();
      requestApplyFilters(true);
    });

    byId('budgetFilterBtn').addEventListener('click', function () {
      const enable = state.quickMode !== 'budget';
      state.quickMode = enable ? 'budget' : '';
      if (enable) {
        const cap = Math.min(state.maxPriceCap, 5000);
        byId('maxPrice').value = String(cap);
        state.maxPriceTouched = true;
      }
      state.page = 1;
      savePrefs();
      requestApplyFilters(true);
    });

    byId('highStockFilterBtn').addEventListener('click', function () {
      state.quickMode = state.quickMode === 'highStock' ? '' : 'highStock';
      state.page = 1;
      savePrefs();
      requestApplyFilters(true);
    });

    byId('clearAllBtn').addEventListener('click', resetFilters);

    byId('remoteLoadBtn').addEventListener('click', function () {
      fetchRemoteProductsDirect().then(function (rows) {
        if (Array.isArray(rows) && rows.length) {
          requestRefreshProducts(false, 0);
          return;
        }
        toast('Remote load failed.');
      });
    });

    byId('shareBtn').addEventListener('click', shareFilters);
    byId('csvBtn').addEventListener('click', exportCsv);

    byId('categoryChips').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-chip]');
      if (!b) return;
      state.chip = str(b.getAttribute('data-chip'));
      state.page = 1;
      renderCategoryChips();
      requestApplyFilters(true);
    });

    byId('categoryGrid').addEventListener('click', function (e) {
      const card = e.target.closest('[data-category-card]');
      if (!card) return;
      byId('categoryFilter').value = str(card.getAttribute('data-category-card'));
      state.chip = '';
      state.page = 1;
      renderCategoryChips();
      requestApplyFilters(true);
      setSidebarOpen(false);
      const target = byId('productsSection');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    byId('pager').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-page]');
      if (!b || b.disabled) return;
      state.page = Math.max(1, Math.floor(num(b.getAttribute('data-page'))));
      requestApplyFilters(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    const heroMedia = document.querySelector('.mm-hero-media');
    if (heroMedia) {
      heroMedia.addEventListener('click', function (e) {
        const b = e.target.closest('button[data-hero-action]');
        if (!b || b.disabled) return;
        const action = str(b.getAttribute('data-hero-action'));
        const slot = str(b.getAttribute('data-hero-slot'));
        const p = productForHeroSlot(slot);
        if (!p) return;
        if (action === 'open') { openModal(p); return; }
        if (action === 'cart') { addToCart(p, 1, false); return; }
        if (action === 'buy') buyNow(p, 1);
      });
    }

    byId('latestGrid').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-latest]');
      if (!b) return;
      const key = decodeURIComponent(str(b.getAttribute('data-key') || ''));
      const p = findProduct(key) || state.latest.find(function (x) { return x._key === key; });
      if (!p) return;
      if (b.getAttribute('data-latest') === 'cart') { addToCart(p, 1, false); return; }
      openModal(p);
    });

    byId('productGrid').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-action]');
      if (!b) return;
      const action = b.getAttribute('data-action');
      if (action === 'reset-all') {
        resetFilters();
        return;
      }
      const key = decodeURIComponent(str(b.getAttribute('data-key') || ''));
      const p = findProduct(key);
      if (!p) return;
      if (action === 'wish') { toggleWishlist(key); return; }
      if (action === 'compare') { toggleCompare(key); return; }
      if (action === 'open') { openModal(p); return; }
      const q = qtyFor(key, p.stock);
      if (action === 'cart') { addToCart(p, q, false); return; }
      if (action === 'buy') buyNow(p, q);
    });

    byId('wishlistList').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-wish]');
      if (!b) return;
      const key = decodeURIComponent(str(b.getAttribute('data-key') || ''));
      if (b.getAttribute('data-wish') === 'remove') { toggleWishlist(key); return; }
      const p = findProduct(key);
      if (p) openModal(p);
    });

    byId('recentList').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-recent]');
      if (!b) return;
      const key = decodeURIComponent(str(b.getAttribute('data-key') || ''));
      const p = findProduct(key);
      if (p) openModal(p);
    });

    byId('sellerList').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-seller]');
      if (!b) return;
      byId('sellerFilter').value = str(b.getAttribute('data-seller'));
      state.page = 1;
      requestApplyFilters(true);
      setSidebarOpen(false);
    });

    byId('compareList').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-compare-action]');
      if (!b) return;
      const key = decodeURIComponent(str(b.getAttribute('data-key') || ''));
      const action = b.getAttribute('data-compare-action');
      if (action === 'remove') {
        toggleCompare(key);
        return;
      }
      const p = findProduct(key);
      if (p) openModal(p);
    });

    const clearCompareBtn = byId('compareClearBtn');
    if (clearCompareBtn) {
      clearCompareBtn.addEventListener('click', function () {
        state.compare.clear();
        write(KEYS.COMPARE, []);
        renderCompare();
        renderProducts();
      });
    }

    byId('modalClose').addEventListener('click', closeModal);
    byId('productModal').addEventListener('click', function (e) {
      if (e.target === this) closeModal();
    });

    byId('modalWish').addEventListener('click', function () {
      if (!state.selected) return;
      toggleWishlist(state.selected);
      this.textContent = state.wishlist.has(state.selected) ? 'Remove Wishlist' : 'Wishlist';
    });

    byId('modalCart').addEventListener('click', function () {
      const p = findProduct(state.selected);
      if (p) addToCart(p, 1, false);
    });

    byId('modalBuy').addEventListener('click', function () {
      const p = findProduct(state.selected);
      if (p) buyNow(p, 1);
    });

    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);

    window.addEventListener('storage', function (e) {
      const key = e && typeof e.key === 'string' ? e.key : '';
      if (!key || key === 'products') requestRefreshProducts(true, 120);
      if (key === 'purchases') {
        computeHeroHighlights();
        renderHeroHighlights();
      }
      if (keyMatchesStorageEvent(key, KEYS.CART) || keyMatchesStorageEvent(key, KEYS.CART_ITEMS)) updateCartCount();
      if (!key || isBalanceStorageEvent(key)) {
        invalidateUserScopeToken();
        loadPrefs();
        updateHeaderUser();
        updateCartCount();
        requestApplyFilters(true);
      }
    });

    window.addEventListener('focus', function () {
      requestReconcile();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      requestReconcile();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeModal();
      if (e.key === '/') {
        const target = e.target;
        const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
        if (!typing) {
          e.preventDefault();
          byId('searchInput').focus();
        }
      }
    });
  }

  function reconcileHydratedState() {
    invalidateUserScopeToken();
    loadPrefs();
    updateHeaderUser();
    updateCartCount();
    computeHeroHighlights();
    renderHeroHighlights();
    if (!booted) return;
    applyFilters(true);
  }

  function init() {
    loadPrefs();
    byId('pageSizeFilter').value = String(state.pageSize);
    byId('autoSyncBtn').textContent = state.autoSync ? 'Auto On' : 'Auto Off';
    byId('wishlistOnlyBtn').textContent = state.onlyWishlist ? 'Wishlist Only On' : 'Wishlist Only';
    byId('productGrid').classList.toggle('list', state.view === 'list');
    setSidebarOpen(false);
    updateOnline();
    updateHeaderUser();
    updateCartCount();
    try {
      applyUrl();
    } catch (err) {
      console.error('applyUrl failed', err);
      setSyncNote('Home filters could not be restored from the URL. Loading default view.');
    }
    byId('headerSearch').value = byId('searchInput').value;
    try {
      refreshProducts(true);
    } catch (err) {
      console.error('refreshProducts failed', err);
      setSyncNote('Home loaded, but live products could not be prepared. You can still use the page and try Sync again.');
    }
    try { bindEvents(); } catch (err) { console.error('bindEvents failed', err); }
    tickClock();
    setInterval(function () {
      if (!document.hidden) tickClock();
    }, 1000);
    setInterval(function () {
      if (state.autoSync && !document.hidden && navigator.onLine) requestRefreshProducts(true, 0);
    }, HOME_AUTO_SYNC_MS);
    setInterval(function () {
      if (document.hidden) return;
      try { updateHeaderUser(); } catch (_) {}
    }, HEADER_REFRESH_MS);
  }

  function start() {
    function boot() {
      if (booted) return;
      booted = true;
      try {
        init();
        window.__mmHomeReady = true;
      } catch (err) {
        window.__mmHomeReady = false;
        console.error('Home boot failed.', err);
        setSyncNote('Home hit a startup issue, but the page will stay here so you can retry or inspect the content.');
      }
    }

    function hydrateReady() {
      if (!booted) {
        boot();
        return;
      }
      try {
        reconcileHydratedState();
      } catch (err) {
        console.error('Home hydration refresh failed.', err);
      }
    }

    const ready = window.MMStorage && window.MMStorage.ready;
    if (ready && typeof ready.then === 'function') {
      setTimeout(boot, 2500);
      ready.finally(hydrateReady);
      return;
    }
    boot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
