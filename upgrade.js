(function () {
  const doc = document;
  const root = doc.documentElement;
  const storage = (function () {
    if (window.MMStorage && typeof window.MMStorage.getItem === 'function') return window.MMStorage;
    try {
      if (window.localStorage && typeof window.localStorage.getItem === 'function') return window.localStorage;
    } catch (_err) {}
    return {
      getItem: function () { return null; },
      setItem: function () {},
      removeItem: function () {}
    };
  })();

  function createEl(tag, className, text) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  function ensureFabStack() {
    let stack = doc.querySelector('.mm-fab-stack');
    if (stack) return stack;
    stack = createEl('div', 'mm-fab-stack');
    doc.body.appendChild(stack);
    return stack;
  }

  function showToast(message, type) {
    if (!message) return;
    let wrap = doc.querySelector('.mm-toast-wrap');
    if (!wrap) {
      wrap = createEl('div', 'mm-toast-wrap');
      doc.body.appendChild(wrap);
    }

    const tone = type || 'mm-success';
    const toast = createEl('div', 'mm-toast ' + tone, String(message));
    wrap.appendChild(toast);

    window.setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-6px)';
    }, 2400);

    window.setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 2800);
  }

  function getToastType(message) {
    const text = String(message || '').toLowerCase();
    if (text.includes('error') || text.includes('fail') || text.includes('decline')) return 'mm-error';
    if (text.includes('pending') || text.includes('warning')) return 'mm-warning';
    return 'mm-success';
  }

  function overrideAlert() {
    if (window.__mmAlertUpgraded) return;
    window.__mmAlertUpgraded = true;
    const nativeAlert = window.alert.bind(window);

    window.alert = function (message) {
      try {
        showToast(message, getToastType(message));
      } catch (err) {
        nativeAlert(message);
      }
    };
  }

  function initThemeToggle() {
    const saved = storage.getItem('mm-theme');
    if (saved === 'light' || saved === 'dark') {
      root.setAttribute('data-theme', saved);
    }

    const stack = ensureFabStack();
    const btn = createEl('button', 'mm-fab');
    btn.type = 'button';
    btn.title = 'Switch theme';

    function syncText() {
      const mode = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      btn.textContent = mode === 'light' ? 'Dark' : 'Light';
      btn.setAttribute('aria-label', 'Switch to ' + (mode === 'light' ? 'dark' : 'light') + ' theme');
    }

    syncText();
    btn.addEventListener('click', function () {
      const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      storage.setItem('mm-theme', next);
      syncText();
    });

    stack.appendChild(btn);
  }

  function initBackToTop() {
    const stack = ensureFabStack();
    const btn = createEl('button', 'mm-fab', 'Top');
    btn.type = 'button';
    btn.title = 'Back to top';
    btn.hidden = true;

    btn.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    function toggle() {
      btn.hidden = window.scrollY < 320;
    }

    window.addEventListener('scroll', toggle, { passive: true });
    toggle();
    stack.appendChild(btn);
  }

  function firstSearchField() {
    return (
      doc.querySelector('input[type="search"]') ||
      doc.querySelector('#searchInput') ||
      doc.querySelector('#searchBox') ||
      doc.querySelector('input[placeholder*="Search" i]') ||
      doc.querySelector('input[placeholder*=\"search\" i]')
    );
  }

  function initKeyboardSearchShortcut() {
    doc.addEventListener('keydown', function (event) {
      const target = event.target;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing) return;
      if (event.key === '/') {
        const field = firstSearchField();
        if (field) {
          event.preventDefault();
          field.focus();
        }
      }
    });
  }

  function initConnectivityChip() {
    const chip = createEl('div', 'mm-status-chip');

    function render() {
      if (navigator.onLine) {
        chip.innerHTML = '<span class="mm-online">Online</span>';
      } else {
        chip.innerHTML = '<span class="mm-offline">Offline</span>';
      }
    }

    window.addEventListener('online', function () {
      render();
      showToast('Connection restored', 'mm-success');
    });

    window.addEventListener('offline', function () {
      render();
      showToast('You are offline', 'mm-warning');
    });

    render();
    doc.body.appendChild(chip);
  }

  function mapTableLabels(table) {
    const headers = Array.from(table.querySelectorAll('thead th')).map(function (th) {
      return th.textContent.trim();
    });

    if (!headers.length) {
      const firstRow = table.querySelector('tr');
      if (!firstRow) return;
      const rowHeads = Array.from(firstRow.children).map(function (cell) {
        return cell.textContent.trim();
      });
      if (!rowHeads.length) return;
      Array.from(table.querySelectorAll('tr')).forEach(function (tr, rowIdx) {
        if (rowIdx === 0) return;
        Array.from(tr.children).forEach(function (cell, idx) {
          cell.setAttribute('data-label', rowHeads[idx] || 'Value');
        });
      });
      return;
    }

    const rows = table.querySelectorAll('tbody tr');
    rows.forEach(function (row) {
      Array.from(row.children).forEach(function (cell, idx) {
        cell.setAttribute('data-label', headers[idx] || 'Value');
      });
    });
  }

  function initResponsiveTables() {
    const tables = doc.querySelectorAll('table');
    tables.forEach(function (table) {
      table.classList.add('responsive-table');
      mapTableLabels(table);
    });
  }

  function initMobileNav() {
    const header = doc.querySelector('header');
    if (!header) return;

    let nav = header.querySelector('nav');
    if (!nav) return;

    if (header.querySelector('.mm-nav-toggle')) return;

    const toggle = createEl('button', 'mm-nav-toggle', '☰');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');

    const navId = nav.id || 'mm-nav-' + Math.random().toString(36).slice(2, 8);
    nav.id = navId;
    toggle.setAttribute('aria-controls', navId);

    toggle.addEventListener('click', function () {
      const isOpen = nav.classList.toggle('mm-open');
      toggle.setAttribute('aria-expanded', String(isOpen));
      toggle.textContent = isOpen ? '✕' : '☰';
      toggle.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
    });

    const navParent = nav.parentNode;
    if (!navParent) return;
    navParent.insertBefore(toggle, nav);

    nav.querySelectorAll('a').forEach(function (anchor) {
      anchor.addEventListener('click', function () {
        if (window.innerWidth > 1100) return;
        nav.classList.remove('mm-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = '☰';
      });
    });
  }

  function initLazyImages() {
    const images = doc.querySelectorAll('img:not([loading])');
    images.forEach(function (img) {
      img.loading = 'lazy';
      img.decoding = 'async';
    });
  }

  function initPhoneInputMode() {
    doc.querySelectorAll('input[type="number"]').forEach(function (input) {
      if (!input.hasAttribute('inputmode')) {
        input.setAttribute('inputmode', 'numeric');
      }
    });
  }

  function recordPageVisit() {
    try {
      const path = location.pathname.split('/').pop() || 'index.html';
      const history = JSON.parse(storage.getItem('recentPages') || '[]');
      const filtered = history.filter(function (item) {
        return item.path !== path;
      });
      filtered.unshift({ path: path, at: Date.now() });
      storage.setItem('recentPages', JSON.stringify(filtered.slice(0, 8)));
    } catch (_err) {
      // no-op
    }
  }

  doc.addEventListener('DOMContentLoaded', function () {
    overrideAlert();
    initMobileNav();
    initThemeToggle();
    initBackToTop();
    initKeyboardSearchShortcut();
    initConnectivityChip();
    initResponsiveTables();
    initLazyImages();
    initPhoneInputMode();
    recordPageVisit();
  });
})();

