(() => {
  if (window.MMStorage && window.MMStorage.ready) return;

  const firebaseConfig = {
    apiKey: "AIzaSyAUtHIWT6yZ8lHVShZNdQpDEXi_M8Zuo7I",
    authDomain: "matrixmarket-f72e0.firebaseapp.com",
    databaseURL: "https://matrixmarket-f72e0-default-rtdb.firebaseio.com",
    projectId: "matrixmarket-f72e0",
    storageBucket: "matrixmarket-f72e0.firebasestorage.app",
    messagingSenderId: "16723215127",
    appId: "1:16723215127:web:ff515befb9690d4a83ad52",
    measurementId: "G-J9MHG5S3DJ"
  };

  const ROOT_PATH = "worldwideStorage";
  const DATABASE_URL = String(firebaseConfig.databaseURL || "").replace(/\/+$/, "");
  const cache = Object.create(null);
  const localOnlyCache = Object.create(null);
  const LOCAL_ONLY_PREFIXES = ["firebase:"];
  const pending = new Map();
  let pendingClear = false;
  let syncing = false;
  let applyingRemote = false;
  let remoteWritable = true;
  let remoteMode = "memory";
  let readyDone = false;
  let db = null;
  let api = null;

  function toRaw(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch (_) {}
    return String(value);
  }

  function decodeKey(value) {
    try { return decodeURIComponent(value); } catch (_) { return String(value); }
  }

  function keyPath(key) {
    return ROOT_PATH + "/" + encodeURIComponent(String(key));
  }

  function isLocalOnlyKey(key) {
    const k = String(key == null ? "" : key);
    for (let i = 0; i < LOCAL_ONLY_PREFIXES.length; i += 1) {
      if (k.indexOf(LOCAL_ONLY_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  function remoteKeys() {
    return Object.keys(cache);
  }

  function localOnlyKeys() {
    return Object.keys(localOnlyCache);
  }

  function keys() {
    return remoteKeys().concat(localOnlyKeys());
  }

  function hasRemoteKey(key) {
    return Object.prototype.hasOwnProperty.call(cache, key);
  }

  function hasLocalOnlyKey(key) {
    return Object.prototype.hasOwnProperty.call(localOnlyCache, key);
  }

  function isPermissionDenied(error) {
    const code = String(error && error.code || "").toLowerCase();
    const msg = String(error && (error.message || error) || "").toLowerCase();
    return code.indexOf("permission_denied") >= 0 || msg.indexOf("permission_denied") >= 0 || msg.indexOf("permission denied") >= 0;
  }

  function onlineWritable() {
    return remoteWritable && (remoteMode === "firebase" || remoteMode === "rest");
  }

  function restRootUrl() {
    return DATABASE_URL + "/" + ROOT_PATH + ".json";
  }

  function restKeyUrl(key) {
    return DATABASE_URL + "/" + keyPath(key) + ".json";
  }

  async function restRequest(url, options) {
    const opts = Object.assign({ method: "GET", headers: { "Content-Type": "application/json" } }, options || {});
    const res = await fetch(url, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!res.ok) {
      const message = String((data && data.error) || ("HTTP " + res.status));
      throw new Error(message);
    }
    if (data && typeof data === "object" && data.error) throw new Error(String(data.error));
    return data;
  }

  async function bootstrapRestMode() {
    if (!DATABASE_URL) throw new Error("Missing databaseURL.");
    const first = await restRequest(restRootUrl(), { method: "GET", cache: "no-store" });
    applyRemoteSnapshot(first && typeof first === "object" ? first : {});
    remoteMode = "rest";
    remoteWritable = true;
  }

  function dispatchStorageEvent(key, oldValue, newValue) {
    try {
      window.dispatchEvent(new StorageEvent("storage", {
        key: key,
        oldValue: oldValue,
        newValue: newValue,
        storageArea: null,
        url: location.href
      }));
    } catch (_) {
      window.dispatchEvent(new Event("storage"));
    }
  }

  function applyCacheMap(nextMap) {
    const oldKeys = new Set(remoteKeys());
    Object.keys(nextMap).forEach((key) => {
      const next = nextMap[key];
      const prev = hasRemoteKey(key) ? cache[key] : null;
      if (prev !== next) {
        cache[key] = next;
        dispatchStorageEvent(key, prev, next);
      }
      oldKeys.delete(key);
    });
    oldKeys.forEach((key) => {
      const prev = cache[key];
      delete cache[key];
      dispatchStorageEvent(key, prev, null);
    });
  }

  function applyRemoteSnapshot(rawRemote) {
    const remoteMap = Object.create(null);
    const source = rawRemote && typeof rawRemote === "object" ? rawRemote : {};
    Object.keys(source).forEach((encoded) => {
      const decoded = decodeKey(encoded);
      if (isLocalOnlyKey(decoded)) return;
      remoteMap[decoded] = toRaw(source[encoded]);
    });

    if (pendingClear) {
      Object.keys(remoteMap).forEach((k) => delete remoteMap[k]);
    }
    pending.forEach((value, key) => {
      if (value === null) delete remoteMap[key];
      else remoteMap[key] = value;
    });
    applyCacheMap(remoteMap);
  }

  async function flushPending() {
    if (syncing || applyingRemote || !onlineWritable()) return;
    if (!pendingClear && pending.size === 0) return;
    syncing = true;
    try {
      if (pendingClear) {
        if (remoteMode === "firebase") await api.remove(api.ref(db, ROOT_PATH));
        else await restRequest(restRootUrl(), { method: "DELETE" });
        pendingClear = false;
      }
      const entries = Array.from(pending.entries());
      pending.clear();
      for (let i = 0; i < entries.length; i += 1) {
        const key = entries[i][0];
        const value = entries[i][1];
        if (remoteMode === "firebase") {
          if (value === null) await api.remove(api.ref(db, keyPath(key)));
          else await api.set(api.ref(db, keyPath(key)), value);
        } else if (value === null) {
          await restRequest(restKeyUrl(key), { method: "DELETE" });
        } else {
          await restRequest(restKeyUrl(key), { method: "PUT", body: JSON.stringify(value) });
        }
      }
    } catch (err) {
      if (isPermissionDenied(err)) {
        remoteWritable = false;
        pendingClear = false;
        pending.clear();
      }
      // Keep app usable while offline.
    } finally {
      syncing = false;
      if ((pendingClear || pending.size > 0) && onlineWritable()) flushPending();
    }
  }

  const ready = (async () => {
    try {
      const [firebaseApp, firebaseDb, firebaseAuth] = await Promise.all([
        import("https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js"),
        import("https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js"),
        import("https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js")
      ]);

      const app = firebaseApp.getApps().length ? firebaseApp.getApp() : firebaseApp.initializeApp(firebaseConfig);
      let auth = null;
      try {
        auth = firebaseAuth.getAuth(app);
        if (!auth.currentUser) await firebaseAuth.signInAnonymously(auth);
      } catch (_) {}

      db = firebaseDb.getDatabase(app);
      remoteMode = "firebase";
      api = { ref: firebaseDb.ref, get: firebaseDb.get, set: firebaseDb.set, remove: firebaseDb.remove, onValue: firebaseDb.onValue };
      window.MMFirebase = { app, auth, db, ref: api.ref, get: api.get, set: api.set, remove: api.remove, onValue: api.onValue };

      const rootRef = api.ref(db, ROOT_PATH);
      const first = await api.get(rootRef);
      applyRemoteSnapshot(first.exists() ? first.val() : {});

      api.onValue(
        rootRef,
        (snap) => {
          applyingRemote = true;
          try { applyRemoteSnapshot(snap.exists() ? snap.val() : {}); }
          finally { applyingRemote = false; }
          flushPending();
        },
        (err) => {
          if (isPermissionDenied(err)) remoteWritable = false;
        }
      );

      await flushPending();
      readyDone = true;
      window.dispatchEvent(new Event("mm-storage-hydrated"));
    } catch (_firebaseError) {
      try {
        await bootstrapRestMode();
        await flushPending();
      } catch (_restError) {
        remoteMode = "memory";
        remoteWritable = false;
      } finally {
        readyDone = true;
        window.dispatchEvent(new Event("mm-storage-hydrated"));
      }
    }
  })();

  const storageApi = {
    getItem(key) {
      const k = String(key);
      if (hasLocalOnlyKey(k)) return localOnlyCache[k];
      return hasRemoteKey(k) ? cache[k] : null;
    },
    setItem(key, value) {
      const k = String(key);
      const next = toRaw(value);
      if (isLocalOnlyKey(k)) {
        const prevLocal = hasLocalOnlyKey(k) ? localOnlyCache[k] : null;
        localOnlyCache[k] = next;
        if (prevLocal !== next) dispatchStorageEvent(k, prevLocal, next);
        return;
      }

      const prev = hasRemoteKey(k) ? cache[k] : null;
      cache[k] = next;
      pending.set(k, next);
      if (prev !== next) dispatchStorageEvent(k, prev, next);
      flushPending();
    },
    removeItem(key) {
      const k = String(key);
      if (isLocalOnlyKey(k)) {
        const prevLocal = hasLocalOnlyKey(k) ? localOnlyCache[k] : null;
        if (hasLocalOnlyKey(k)) delete localOnlyCache[k];
        if (prevLocal !== null) dispatchStorageEvent(k, prevLocal, null);
        return;
      }

      const prev = hasRemoteKey(k) ? cache[k] : null;
      if (hasRemoteKey(k)) delete cache[k];
      pending.set(k, null);
      if (prev !== null) dispatchStorageEvent(k, prev, null);
      flushPending();
    },
    clear() {
      const remoteCurrent = remoteKeys();
      const localCurrent = localOnlyKeys();
      if (!remoteCurrent.length && !localCurrent.length && pending.size === 0) return;

      remoteCurrent.forEach((k) => {
        const prev = cache[k];
        delete cache[k];
        dispatchStorageEvent(k, prev, null);
      });
      localCurrent.forEach((k) => {
        const prev = localOnlyCache[k];
        delete localOnlyCache[k];
        dispatchStorageEvent(k, prev, null);
      });

      if (remoteCurrent.length || pending.size > 0) {
        pendingClear = true;
        pending.clear();
        flushPending();
      }
    },
    key(index) {
      const list = keys();
      const i = Number(index);
      return Number.isInteger(i) && i >= 0 && i < list.length ? list[i] : null;
    },
    get length() {
      return keys().length;
    }
  };

  window.MMStorage = Object.assign(storageApi, {
    ready,
    path() { return ROOT_PATH; },
    syncNow: flushPending,
    keys() { return keys().slice(); },
    status() { return { mode: remoteMode, writable: onlineWritable(), ready: readyDone }; },
    isOnlineReady() { const s = this.status(); return Boolean(s.ready && s.writable); }
  });

  function createOnlineStorageAlias() {
    return {
      getItem(key) { return storageApi.getItem(key); },
      setItem(key, value) { storageApi.setItem(key, value); },
      removeItem(key) { storageApi.removeItem(key); },
      clear() { storageApi.clear(); },
      key(index) { return storageApi.key(index); },
      get length() { return storageApi.length; }
    };
  }

  function forceStorageAlias(name, alias) {
    let attached = false;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get() { return alias; }
      });
      attached = true;
    } catch (_) {}

    if (attached) return;

    try {
      const nativeStore = window[name];
      if (!nativeStore) return;
      nativeStore.getItem = alias.getItem;
      nativeStore.setItem = alias.setItem;
      nativeStore.removeItem = alias.removeItem;
      nativeStore.clear = alias.clear;
      nativeStore.key = alias.key;
      try {
        Object.defineProperty(nativeStore, "length", {
          configurable: true,
          get() { return alias.length; }
        });
      } catch (_) {}
    } catch (_) {}
  }

  const onlineLocalAlias = createOnlineStorageAlias();
  const onlineSessionAlias = createOnlineStorageAlias();
  forceStorageAlias("localStorage", onlineLocalAlias);
  forceStorageAlias("sessionStorage", onlineSessionAlias);
  window.MMStorageSession = onlineSessionAlias;
})();
