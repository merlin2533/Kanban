// PWA Install Prompt Handler
(function () {
  let deferredPrompt = null;

  // Create install banner
  function createBanner() {
    const banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.innerHTML =
      '<div class="pwa-install-content">' +
        '<div class="pwa-install-icon">' +
          '<img src="/icons/icon-192.png" alt="Kanban" width="40" height="40">' +
        '</div>' +
        '<div class="pwa-install-text">' +
          '<strong>Kanban installieren</strong>' +
          '<span>Als App auf deinem Ger\u00e4t installieren</span>' +
        '</div>' +
        '<div class="pwa-install-actions">' +
          '<button id="pwa-install-btn" class="pwa-btn-install">Installieren</button>' +
          '<button id="pwa-dismiss-btn" class="pwa-btn-dismiss" aria-label="Schlie\u00dfen">\u00d7</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(banner);

    document.getElementById('pwa-install-btn').addEventListener('click', installApp);
    document.getElementById('pwa-dismiss-btn').addEventListener('click', dismissBanner);
  }

  async function installApp() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    var result = await deferredPrompt.userChoice;
    if (result.outcome === 'accepted') {
      hideBanner();
      localStorage.setItem('pwa-installed', '1');
    }
    deferredPrompt = null;
  }

  function dismissBanner() {
    hideBanner();
    localStorage.setItem('pwa-install-dismissed', Date.now().toString());
  }

  function hideBanner() {
    var banner = document.getElementById('pwa-install-banner');
    if (banner) {
      banner.classList.add('pwa-install-hidden');
      setTimeout(function () { banner.remove(); }, 300);
    }
  }

  function shouldShowBanner() {
    // Don't show if already installed
    if (localStorage.getItem('pwa-installed')) return false;
    // Don't show if running as standalone PWA
    if (window.matchMedia('(display-mode: standalone)').matches) return false;
    if (window.navigator.standalone) return false;
    // Don't show if dismissed in last 7 days
    var dismissed = localStorage.getItem('pwa-install-dismissed');
    if (dismissed && Date.now() - parseInt(dismissed, 10) < 7 * 24 * 60 * 60 * 1000) return false;
    return true;
  }

  // Inject styles
  var style = document.createElement('style');
  style.textContent =
    '#pwa-install-banner{' +
      'position:fixed;bottom:0;left:0;right:0;z-index:10000;' +
      'background:#fff;border-top:1px solid #e2e8f0;' +
      'box-shadow:0 -4px 20px rgba(0,0,0,0.1);' +
      'padding:12px 16px;' +
      'transform:translateY(0);transition:transform 0.3s ease;' +
    '}' +
    '#pwa-install-banner.pwa-install-hidden{transform:translateY(100%);}' +
    '.pwa-install-content{' +
      'display:flex;align-items:center;gap:12px;' +
      'max-width:600px;margin:0 auto;' +
    '}' +
    '.pwa-install-icon img{border-radius:8px;}' +
    '.pwa-install-text{' +
      'flex:1;display:flex;flex-direction:column;gap:2px;' +
    '}' +
    '.pwa-install-text strong{font-size:14px;color:#1e293b;}' +
    '.pwa-install-text span{font-size:12px;color:#64748b;}' +
    '.pwa-install-actions{display:flex;align-items:center;gap:8px;}' +
    '.pwa-btn-install{' +
      'padding:8px 20px;background:#2563eb;color:#fff;' +
      'border:none;border-radius:8px;font-size:14px;' +
      'font-weight:600;cursor:pointer;white-space:nowrap;' +
    '}' +
    '.pwa-btn-install:hover{background:#1d4ed8;}' +
    '.pwa-btn-dismiss{' +
      'background:none;border:none;font-size:22px;' +
      'color:#94a3b8;cursor:pointer;padding:4px 8px;line-height:1;' +
    '}' +
    '.pwa-btn-dismiss:hover{color:#64748b;}' +
    '@media(prefers-color-scheme:dark){' +
      '#pwa-install-banner{background:#1e293b;border-color:#334155;box-shadow:0 -4px 20px rgba(0,0,0,0.3);}' +
      '.pwa-install-text strong{color:#e2e8f0;}' +
      '.pwa-install-text span{color:#94a3b8;}' +
    '}';
  document.head.appendChild(style);

  // Listen for the beforeinstallprompt event
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (shouldShowBanner()) {
      createBanner();
    }
  });

  // Detect successful install
  window.addEventListener('appinstalled', function () {
    hideBanner();
    localStorage.setItem('pwa-installed', '1');
    deferredPrompt = null;
  });
})();
