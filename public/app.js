// --- State ---
let boardId = window.location.pathname.split('/board/')[1];
let board = null;
let currentCardId = null;
const modifiedCards = new Set();

// --- Undo Stack ---
const undoStack = [];
const MAX_UNDO = 20;

function pushUndo(action) {
  undoStack.push(action);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  updateUndoBtn();
}

function updateUndoBtn() {
  const btn = document.getElementById('undoBtn');
  if (btn) btn.disabled = undoStack.length === 0;
}

async function performUndo() {
  if (undoStack.length === 0) return;
  const action = undoStack.pop();
  try {
    await action.undo();
    loadBoard();
  } catch (e) {
    showError('Undo fehlgeschlagen: ' + e.message);
  }
  updateUndoBtn();
}

// Auth check - before DOMContentLoaded
let currentUser = null;
let currentPermission = 'view';
let guestName = ''; // For access-link users
// For named access-link tokens, track which board they belong to so we can
// restore the token if the user switches back to that board.
let _accessTokenBoardId = null;

function getGuestName() {
  return guestName || localStorage.getItem('kanban_guest_name') || '';
}

function setGuestName(name) {
  guestName = name;
  localStorage.setItem('kanban_guest_name', name);
}

function getCurrentUsername() {
  if (currentUser) return currentUser.username;
  return getGuestName();
}

// Show guest name dialog and return a promise
function promptGuestName() {
  return new Promise((resolve) => {
    const stored = localStorage.getItem('kanban_guest_name');
    if (stored) {
      guestName = stored;
      resolve(stored);
      return;
    }
    const overlay = document.getElementById('guestNameOverlay');
    const input = document.getElementById('guestNameInput');
    const btn = document.getElementById('guestNameBtn');
    overlay.classList.remove('hidden');
    input.focus();
    const submit = () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      setGuestName(name);
      overlay.classList.add('hidden');
      resolve(name);
    };
    btn.onclick = submit;
    input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  });
}

async function checkAuth() {
  console.log('[AUTH] app.js checkAuth: starting for board:', boardId);
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');

  try {
    if (token) {
      console.log('[AUTH] app.js checkAuth: using access token');
      const res = await fetch(`/api/auth/me?token=${token}`);
      if (res.ok) {
        const data = await res.json();
        currentUser = data.user;
        currentPermission = 'admin';
        console.log('[AUTH] app.js checkAuth: token auth OK, user:', currentUser.username);
      } else {
        const boardRes = await fetch(`/api/boards/${boardId}?token=${token}`);
        if (boardRes.ok) {
          window._accessToken = token;
          _accessTokenBoardId = boardId;
          // Permission is enforced server-side; enable edit UI
          // (server rejects writes if link is view-only)
          currentPermission = 'edit';
          console.log('[AUTH] app.js checkAuth: board access token valid');
          // Prompt for guest name
          await promptGuestName();
        } else {
          console.warn('[AUTH] app.js checkAuth: token invalid, redirecting to login');
          window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
          return false;
        }
      }
    } else {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      console.log('[AUTH] app.js checkAuth: status response:', JSON.stringify(data));
      if (data.authenticated) {
        currentUser = data.user;
        currentPermission = 'admin';
        console.log('[AUTH] app.js checkAuth: authenticated as', currentUser.username);
      } else {
        // Check if board has public access before redirecting to login
        const pubRes = await fetch(`/api/boards/${boardId}/public-info`);
        if (pubRes.ok) {
          const pubData = await pubRes.json();
          if (pubData.public_access) {
            window._accessToken = pubData.token;
            currentPermission = pubData.public_access;
            console.log('[AUTH] app.js checkAuth: public board access, permission:', currentPermission);
            await promptGuestName();
          } else {
            console.warn('[AUTH] app.js checkAuth: NOT authenticated, redirecting to login');
            window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
            return false;
          }
        } else {
          console.warn('[AUTH] app.js checkAuth: NOT authenticated, redirecting to login');
          window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
          return false;
        }
      }
    }
  } catch (err) {
    console.error('[AUTH] app.js checkAuth: ERROR', err);
    window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
    return false;
  }
  return true;
}

function canEdit() {
  return currentPermission === 'admin' || currentPermission === 'edit';
}

// --- boardId guard ---
if (!boardId) {
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('board').innerHTML = '<p style="padding:40px;color:#94a3b8;font-size:18px;">Ungültige Board-URL.</p>';
  });
} else {

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  const authed = await checkAuth();
  if (!authed) return;

  await loadBoard();
  setupActivityPanel();
  setupModal();
  setupBoardSwitcher();

  // Show current user name badge in header
  const username = getCurrentUsername();
  if (username) {
    const userBadge = document.createElement('div');
    userBadge.className = 'user-badge';
    userBadge.title = 'Angemeldet als ' + username;
    const userDot = document.createElement('span');
    userDot.className = 'user-badge-dot';
    userDot.textContent = username.charAt(0).toUpperCase();
    userDot.style.background = stringToColor(username);
    userBadge.appendChild(userDot);
    const userLabel = document.createElement('span');
    userLabel.textContent = username;
    userBadge.appendChild(userLabel);
    // For guests, allow clicking to change name
    if (!currentUser) {
      userBadge.style.cursor = 'pointer';
      userBadge.onclick = async () => {
        const newName = prompt('Name ändern:', getGuestName());
        if (newName && newName.trim()) {
          setGuestName(newName.trim());
          userLabel.textContent = newName.trim();
          userDot.textContent = newName.trim().charAt(0).toUpperCase();
          userDot.style.background = stringToColor(newName.trim());
          userBadge.title = 'Angemeldet als ' + newName.trim();
        }
      };
    }
    document.querySelector('header').insertBefore(userBadge, document.querySelector('.header-actions'));
  }

  // SSE real-time sync with auto-reconnection
  let sseDebounceTimer = null;

  function buildSseUrl() {
    const params = [];
    if (window._accessToken) params.push('token=' + window._accessToken);
    const guest = getGuestName();
    if (guest && !currentUser) params.push('guest=' + encodeURIComponent(guest));
    return `/api/boards/${boardId}/events` + (params.length ? '?' + params.join('&') : '');
  }

  function setupSSE() {
    let sseErrorCount = 0;
    let reconnectDelay = 2000;
    const MAX_RECONNECT_DELAY = 30000;
    let es = new EventSource(buildSseUrl());

    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === 'presence') {
        renderPresence(event.users || []);
        return;
      }
      if (event.type === 'update') {
        // Track which cards were modified by other users
        if (event.cardId && event.user && event.user !== getCurrentUsername()) {
          modifiedCards.add(Number(event.cardId));
        }
        clearTimeout(sseDebounceTimer);
        sseDebounceTimer = setTimeout(() => {
          if (currentCardId) {
            window._pendingBoardReload = true;
          } else {
            loadBoard();
          }
        }, 500);
      }
    };

    es.onerror = () => {
      sseErrorCount++;
      console.warn('[SSE] error count:', sseErrorCount, 'next retry in', reconnectDelay + 'ms');
      es.close();

      if (sseErrorCount >= 5) {
        // Check if session is still valid before reconnecting
        fetch('/api/auth/status').then(r => r.json()).then(data => {
          if (!data.authenticated && !window._accessToken) {
            window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
            return;
          }
          scheduleReconnect();
        }).catch(() => scheduleReconnect());
      } else {
        scheduleReconnect();
      }

      function scheduleReconnect() {
        setTimeout(() => {
          console.log('[SSE] reconnecting...');
          es = null;
          setupSSE();
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
      }
    };

    es.onopen = () => {
      sseErrorCount = 0;
      reconnectDelay = 2000;
      console.log('[SSE] connected');
    };

    window._eventSource = es;
  }

  setupSSE();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
  }

  // Board title inline edit
  const boardTitleEl = document.getElementById('boardTitle');
  boardTitleEl.contentEditable = true;
  boardTitleEl.style.cursor = 'text';
  boardTitleEl.addEventListener('blur', async () => {
    const newTitle = boardTitleEl.textContent.trim();
    if (newTitle && newTitle !== board.title) {
      try {
        await api(`/api/boards/${boardId}`, 'PATCH', { title: newTitle });
        board.title = newTitle;
        document.title = newTitle + ' - Kanban';
      } catch (e) {
        showError(e.message);
        boardTitleEl.textContent = board.title;
      }
    } else if (!newTitle) {
      boardTitleEl.textContent = board.title;
    }
  });
  boardTitleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); boardTitleEl.blur(); }
  });

  // Search filter
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Karten suchen...';
  searchInput.className = 'board-search';
  searchInput.id = 'boardSearch';
  searchInput.setAttribute('aria-label', 'Karten suchen');
  document.querySelector('header').insertBefore(searchInput, document.querySelector('.header-actions'));

  let searchTimer = null;
  let searchResultsContainer = null;

  function showSearchResults(results) {
    if (!searchResultsContainer) {
      searchResultsContainer = document.createElement('div');
      searchResultsContainer.className = 'search-results-dropdown';
      searchInput.parentNode.insertBefore(searchResultsContainer, searchInput.nextSibling);
    }
    searchResultsContainer.innerHTML = '';
    if (!results.length) {
      searchResultsContainer.innerHTML = '<div class="search-result-empty">Keine Ergebnisse</div>';
      searchResultsContainer.classList.remove('hidden');
      return;
    }
    for (const card of results) {
      const item = document.createElement('a');
      item.className = 'search-result-item';
      const token = window._accessToken ? `?token=${window._accessToken}` : '';
      item.href = `/board/${boardId}/card/${card.id}${token}`;
      const colors = { high: '#dc2626', medium: '#f59e0b', low: '#22c55e' };
      const priorityDot = card.priority ? `<span class="search-result-priority" style="background:${colors[card.priority]}"></span>` : '';
      item.innerHTML = `<span class="search-result-text">${esc(card.text)}</span>${priorityDot}<span class="search-result-col">${esc(card.column_title || '')}</span>`;
      searchResultsContainer.appendChild(item);
    }
    searchResultsContainer.classList.remove('hidden');
  }

  function hideSearchResults() {
    if (searchResultsContainer) searchResultsContainer.classList.add('hidden');
    // Also restore all cards visibility
    document.querySelectorAll('.card').forEach(c => c.style.display = '');
  }

  searchInput.oninput = () => {
    const query = searchInput.value.trim();
    clearTimeout(searchTimer);
    if (!query) { hideSearchResults(); return; }
    // Quick client-side filter while waiting for server
    document.querySelectorAll('.card').forEach(card => {
      const text = card.textContent.toLowerCase();
      card.style.display = text.includes(query.toLowerCase()) ? '' : 'none';
    });
    if (query.length < 2) return;
    searchTimer = setTimeout(async () => {
      try {
        const results = await api(`/api/boards/${boardId}/search?q=${encodeURIComponent(query)}`);
        showSearchResults(results);
      } catch {}
    }, 300);
  };

  searchInput.onblur = () => setTimeout(hideSearchResults, 200);
  searchInput.onfocus = () => { if (searchInput.value.trim().length >= 2 && searchResultsContainer) searchResultsContainer.classList.remove('hidden'); };

  // Sort
  const sortSelect = document.createElement('select');
  sortSelect.className = 'board-sort';
  sortSelect.id = 'boardSort';
  sortSelect.setAttribute('aria-label', 'Sortierung');
  sortSelect.innerHTML = '<option value="">Standard</option><option value="alpha">A-Z</option><option value="date">Neueste</option><option value="due">Fälligkeit</option>';
  document.querySelector('header').insertBefore(sortSelect, document.querySelector('.header-actions'));

  sortSelect.onchange = () => {
    renderBoard();
  };

  // Label filter
  const labelFilter = document.createElement('select');
  labelFilter.className = 'board-sort';
  labelFilter.id = 'labelFilter';
  labelFilter.setAttribute('aria-label', 'Label-Filter');
  labelFilter.innerHTML = '<option value="">Alle Labels</option>';
  document.querySelector('header').insertBefore(labelFilter, document.querySelector('.header-actions'));

  labelFilter.onchange = () => {
    const selectedLabel = labelFilter.value;
    document.querySelectorAll('.card').forEach(card => {
      if (!selectedLabel) {
        card.style.display = '';
        return;
      }
      const dots = card.querySelectorAll('.card-label-dot');
      const hasLabel = [...dots].some(dot => dot.title === selectedLabel);
      card.style.display = hasLabel ? '' : 'none';
    });
  };

  // Export button
  const exportBtn = document.createElement('button');
  exportBtn.className = 'icon-btn';
  exportBtn.innerHTML = '&#11015;'; // download arrow
  exportBtn.title = 'Board exportieren';
  exportBtn.onclick = async () => {
    try {
      const data = await api(`/api/boards/${boardId}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (board.title || 'board') + '.json';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { showError(e.message); }
  };
  document.querySelector('.header-actions').insertBefore(exportBtn, document.getElementById('activityBtn'));

  // Archive view button
  const archiveViewBtn = document.createElement('button');
  archiveViewBtn.className = 'icon-btn';
  archiveViewBtn.innerHTML = '&#128451;'; // archive icon
  archiveViewBtn.title = 'Archiv';
  archiveViewBtn.onclick = toggleArchivePanel;
  document.querySelector('.header-actions').insertBefore(archiveViewBtn, document.getElementById('activityBtn'));

  // Undo button
  const undoBtn = document.createElement('button');
  undoBtn.className = 'icon-btn';
  undoBtn.id = 'undoBtn';
  undoBtn.innerHTML = '&#8630;'; // undo arrow
  undoBtn.title = 'Rückgängig (Ctrl+Z)';
  undoBtn.disabled = true;
  undoBtn.onclick = performUndo;
  document.querySelector('.header-actions').insertBefore(undoBtn, document.getElementById('activityBtn'));

  // Share/copy link button
  const shareBtn = document.createElement('button');
  shareBtn.className = 'icon-btn';
  shareBtn.innerHTML = '&#128279;'; // link icon
  shareBtn.title = 'Link kopieren';
  shareBtn.onclick = () => {
    const url = window.location.href;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(() => {
        const orig = shareBtn.innerHTML;
        shareBtn.innerHTML = '&#10003;';
        setTimeout(() => { shareBtn.innerHTML = orig; }, 2000);
      }).catch(() => showError('Link konnte nicht kopiert werden'));
    } else {
      // Fallback for non-HTTPS
      const textarea = document.createElement('textarea');
      textarea.value = url;
      textarea.style.cssText = 'position:fixed;left:-9999px;';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        const orig = shareBtn.innerHTML;
        shareBtn.innerHTML = '&#10003;';
        setTimeout(() => { shareBtn.innerHTML = orig; }, 2000);
      } catch { showError('Kopieren fehlgeschlagen - HTTPS erforderlich'); }
      document.body.removeChild(textarea);
    }
  };
  document.querySelector('.header-actions').insertBefore(shareBtn, document.getElementById('activityBtn'));

  // Board delete button
  const deleteBoard = document.createElement('button');
  deleteBoard.className = 'icon-btn';
  deleteBoard.innerHTML = '&#128465;'; // trash icon
  deleteBoard.title = 'Board löschen';
  if (!canEdit()) deleteBoard.style.display = 'none';
  deleteBoard.onclick = async () => {
    if (!confirm('Board komplett löschen? Das kann nicht rückgängig gemacht werden!')) return;
    try {
      await api(`/api/boards/${boardId}`, 'DELETE');
      window.location.href = '/';
    } catch (e) {
      showError(e.message);
    }
  };
  document.querySelector('.header-actions').appendChild(deleteBoard);

  // Permissions button (admin only)
  if (currentUser && currentUser.is_admin) {
    const permBtn = document.createElement('button');
    permBtn.className = 'icon-btn';
    permBtn.innerHTML = '&#128273;'; // key icon
    permBtn.title = 'Berechtigungen';
    permBtn.onclick = togglePermissionsPanel;
    document.querySelector('.header-actions').insertBefore(permBtn, document.getElementById('activityBtn'));
  }

  // Members button (admin only)
  if (currentUser && currentUser.is_admin) {
    const membersBtn = document.createElement('button');
    membersBtn.className = 'icon-btn';
    membersBtn.innerHTML = '&#128101;'; // people icon
    membersBtn.title = 'Mitglieder';
    membersBtn.onclick = toggleMembersPanel;
    document.querySelector('.header-actions').insertBefore(membersBtn, document.getElementById('activityBtn'));
  }

  // Save as Template button (admin only)
  if (currentUser && currentUser.is_admin) {
    const templateBtn = document.createElement('button');
    templateBtn.className = 'icon-btn';
    templateBtn.innerHTML = '&#128203;'; // clipboard icon
    templateBtn.title = 'Als Vorlage speichern';
    templateBtn.onclick = async () => {
      const name = prompt('Vorlagen-Name:', board.title);
      if (!name) return;
      try {
        await api(`/api/boards/${boardId}/save-template`, 'POST', { name });
        showError('Vorlage gespeichert!');
      } catch (e) { showError(e.message); }
    };
    document.querySelector('.header-actions').insertBefore(templateBtn, document.getElementById('activityBtn'));
  }

  // Bulk select mode
  let bulkMode = false;
  const selectedCards = new Set();

  const bulkBtn = document.createElement('button');
  bulkBtn.className = 'icon-btn';
  bulkBtn.innerHTML = '&#9745;'; // checkbox icon
  bulkBtn.title = 'Mehrfachauswahl';
  bulkBtn.id = 'bulkSelectBtn';
  if (!canEdit()) bulkBtn.style.display = 'none';
  bulkBtn.onclick = () => toggleBulkMode();
  document.querySelector('.header-actions').insertBefore(bulkBtn, document.getElementById('activityBtn'));

  // Bulk toolbar (hidden by default)
  const bulkToolbar = document.createElement('div');
  bulkToolbar.className = 'bulk-toolbar hidden';
  bulkToolbar.id = 'bulkToolbar';
  bulkToolbar.innerHTML = `
    <span id="bulkCount">0 ausgewählt</span>
    <button class="bulk-action-btn" id="bulkArchiveBtn">Archivieren</button>
    <button class="bulk-action-btn" id="bulkDeleteBtn" style="color:#dc2626">Löschen</button>
    <select class="bulk-action-btn" id="bulkMoveSelect"><option value="">In Spalte verschieben...</option></select>
    <button class="bulk-action-btn" id="bulkCancelBtn">Abbrechen</button>
  `;
  document.querySelector('header').appendChild(bulkToolbar);

  function toggleBulkMode(on) {
    bulkMode = on !== undefined ? on : !bulkMode;
    selectedCards.clear();
    bulkBtn.classList.toggle('active', bulkMode);
    bulkToolbar.classList.toggle('hidden', !bulkMode);
    updateBulkCount();
    renderBoard(); // Re-render to show/hide checkboxes
  }

  function updateBulkCount() {
    const el = document.getElementById('bulkCount');
    if (el) el.textContent = selectedCards.size + ' ausgewählt';
    const archBtn = document.getElementById('bulkArchiveBtn');
    const delBtn = document.getElementById('bulkDeleteBtn');
    const moveSel = document.getElementById('bulkMoveSelect');
    const disabled = selectedCards.size === 0;
    if (archBtn) archBtn.disabled = disabled;
    if (delBtn) delBtn.disabled = disabled;
    if (moveSel) moveSel.disabled = disabled;
  }

  document.getElementById('bulkArchiveBtn').onclick = async () => {
    if (!selectedCards.size) return;
    try {
      await api(`/api/boards/${boardId}/bulk`, 'POST', { action: 'archive', cardIds: [...selectedCards] });
      toggleBulkMode(false);
      loadBoard();
    } catch (e) { showError(e.message); }
  };

  document.getElementById('bulkDeleteBtn').onclick = async () => {
    if (!selectedCards.size || !confirm(`${selectedCards.size} Karten löschen?`)) return;
    try {
      await api(`/api/boards/${boardId}/bulk`, 'POST', { action: 'delete', cardIds: [...selectedCards] });
      toggleBulkMode(false);
      loadBoard();
    } catch (e) { showError(e.message); }
  };

  document.getElementById('bulkMoveSelect').onchange = async (e) => {
    const colId = Number(e.target.value);
    if (!colId || !selectedCards.size) { e.target.value = ''; return; }
    try {
      await api(`/api/boards/${boardId}/bulk`, 'POST', { action: 'move', cardIds: [...selectedCards], columnId: colId });
      toggleBulkMode(false);
      loadBoard();
    } catch (err) { showError(err.message); }
    e.target.value = '';
  };

  document.getElementById('bulkCancelBtn').onclick = () => toggleBulkMode(false);

  // Expose to createCardEl and renderBoard
  window._bulkMode = () => bulkMode;
  window._selectedCards = selectedCards;
  window._updateBulkCount = updateBulkCount;
  window._updateBulkMoveColumns = () => {
    const sel = document.getElementById('bulkMoveSelect');
    if (!sel || !board) return;
    sel.innerHTML = '<option value="">In Spalte verschieben...</option>';
    for (const col of board.columns) {
      const opt = document.createElement('option');
      opt.value = col.id;
      opt.textContent = col.title;
      sel.appendChild(opt);
    }
  };

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Always allow Escape to close modal/panels, even in inputs
      const modal = document.getElementById('modalOverlay');
      if (modal && !modal.classList.contains('hidden')) {
        closeModal();
        e.preventDefault();
        return;
      }
      const actPanel = document.getElementById('activityPanel');
      if (actPanel && !actPanel.classList.contains('hidden')) { actPanel.classList.add('hidden'); e.preventDefault(); return; }
      const archPanel = document.getElementById('archivePanel');
      if (archPanel && !archPanel.classList.contains('hidden')) { archPanel.classList.add('hidden'); e.preventDefault(); return; }
      const permPanel = document.getElementById('permissionsPanel');
      if (permPanel && !permPanel.classList.contains('hidden')) { permPanel.classList.add('hidden'); e.preventDefault(); return; }
      const membersPanel = document.getElementById('membersPanel');
      if (membersPanel && !membersPanel.classList.contains('hidden')) { membersPanel.classList.add('hidden'); e.preventDefault(); return; }
      return;
    }

    // Don't trigger when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    if (e.key === 'n' && !e.ctrlKey && !e.metaKey) {
      // Focus first column's add card input
      const firstInput = document.querySelector('.add-card input');
      if (firstInput) { firstInput.focus(); e.preventDefault(); }
    }
    if (e.key === 'f' && !e.ctrlKey && !e.metaKey) {
      // Focus search
      const search = document.getElementById('boardSearch');
      if (search) { search.focus(); e.preventDefault(); }
    }
    if (e.key === '?' && !e.ctrlKey) {
      // Show shortcuts help
      showShortcutsHelp();
      e.preventDefault();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      performUndo();
    }
  });
});

// --- API Helpers ---
async function api(url, method = 'GET', body = null) {
  if (window._accessToken) {
    const separator = url.includes('?') ? '&' : '?';
    url = url + separator + 'token=' + window._accessToken;
  }
  const opts = { method, headers: {} };
  opts.headers['X-Requested-With'] = 'kanban';
  // Send guest name for access-link users
  const guest = getGuestName();
  if (guest && !currentUser) {
    opts.headers['X-Guest-Name'] = guest;
  }
  if (body && !(body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    opts.body = body;
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    if (res.status === 401) {
      console.warn('[AUTH] app.js api(): got 401 from', method, url, '- redirecting to login');
      window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
      return new Promise(() => {}); // never resolves, page is navigating away
    }
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// --- Error Toast ---
function showError(msg) {
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#dc2626;color:#fff;padding:12px 24px;border-radius:8px;z-index:9999;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.2);';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function showShortcutsHelp() {
  const existing = document.getElementById('shortcutsModal');
  if (existing) { existing.remove(); return; }
  const modal = document.createElement('div');
  modal.id = 'shortcutsModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;';
  modal.innerHTML = '<div style="background:#fff;border-radius:12px;padding:24px 32px;min-width:260px;box-shadow:0 8px 32px rgba(0,0,0,0.2);"><h3 style="margin:0 0 16px;font-size:16px;">Tastaturkürzel</h3><table style="border-collapse:collapse;font-size:14px;"><tr><td style="padding:4px 16px 4px 0;"><kbd>n</kbd></td><td>Neue Karte</td></tr><tr><td style="padding:4px 16px 4px 0;"><kbd>f</kbd></td><td>Suche</td></tr><tr><td style="padding:4px 16px 4px 0;"><kbd>Ctrl+Z</kbd></td><td>Rückgängig</td></tr><tr><td style="padding:4px 16px 4px 0;"><kbd>Esc</kbd></td><td>Schließen</td></tr><tr><td style="padding:4px 16px 4px 0;"><kbd>?</kbd></td><td>Diese Hilfe</td></tr></table><button onclick="document.getElementById(\'shortcutsModal\').remove()" style="margin-top:16px;padding:6px 16px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;">Schließen</button></div>';
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

// --- Loading helper ---
async function withLoading(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = '...';
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// --- Board ---
let boardLoading = false;

async function loadBoard() {
  if (boardLoading) return;
  boardLoading = true;
  try {
    board = await api(`/api/boards/${boardId}`);
    if (!board || board.error) {
      document.getElementById('board').innerHTML = '<p style="padding:40px;color:#94a3b8;font-size:18px;">Board nicht gefunden.</p>';
      return;
    }
    document.getElementById('boardTitle').textContent = board.title;
    document.title = board.title + ' - Kanban';
    renderBoard();
    // Update label filter options
    const lf = document.getElementById('labelFilter');
    if (lf && board.labels) {
      const currentVal = lf.value;
      lf.innerHTML = '<option value="">Alle Labels</option>';
      for (const label of board.labels) {
        const opt = document.createElement('option');
        opt.value = label.name;
        opt.textContent = label.name;
        opt.style.color = label.color;
        lf.appendChild(opt);
      }
      lf.value = currentVal;
    }
    checkNewActivity();
  } catch (e) {
    showError(e.message);
  } finally {
    boardLoading = false;
  }
}

function handleColumnDragOver(e) {
  if (!e.dataTransfer.types.includes('text/column')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

async function handleColumnDrop(e) {
  const colId = e.dataTransfer.getData('text/column');
  if (!colId) return;
  e.preventDefault();

  const boardEl = document.getElementById('board');
  // Find target position based on drop location
  const columns = [...boardEl.querySelectorAll('.column:not(.dragging)')];
  let targetPos = columns.length;
  for (let i = 0; i < columns.length; i++) {
    const rect = columns[i].getBoundingClientRect();
    if (e.clientX < rect.left + rect.width / 2) {
      targetPos = i;
      break;
    }
  }

  try {
    await api(`/api/columns/${colId}/move`, 'PUT', { position: targetPos });
    loadBoard();
  } catch (err) {
    showError(err.message);
  }
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  if (window._updateBulkMoveColumns) window._updateBulkMoveColumns();

  for (const col of board.columns) {
    boardEl.appendChild(createColumnEl(col));
  }

  // Column drop zones — attach once only
  if (!boardEl._columnDragSetup) {
    boardEl.addEventListener('dragover', handleColumnDragOver);
    boardEl.addEventListener('drop', handleColumnDrop);
    boardEl._columnDragSetup = true;
  }

  // Add column inline area
  const addColDiv = document.createElement('div');
  addColDiv.className = 'add-column-area';

  const addBtn = document.createElement('button');
  addBtn.className = 'add-column-btn';
  addBtn.textContent = '+ Spalte hinzufügen';

  const addColInput = document.createElement('input');
  addColInput.className = 'add-column-input';
  addColInput.placeholder = 'Spaltenname...';
  addColInput.style.display = 'none';

  addBtn.onclick = () => {
    addBtn.style.display = 'none';
    addColInput.style.display = '';
    addColInput.focus();
  };

  addColInput.onkeydown = async (e) => {
    if (e.key === 'Enter' && addColInput.value.trim()) {
      try {
        await api(`/api/boards/${boardId}/columns`, 'POST', { title: addColInput.value.trim() });
        addColInput.value = '';
        loadBoard();
      } catch (err) { showError(err.message); }
    }
    if (e.key === 'Escape') {
      addColInput.value = '';
      addColInput.style.display = 'none';
      addBtn.style.display = '';
    }
  };

  addColInput.onblur = () => {
    if (!addColInput.value.trim()) {
      addColInput.style.display = 'none';
      addBtn.style.display = '';
    }
  };

  addColDiv.appendChild(addBtn);
  addColDiv.appendChild(addColInput);
  boardEl.appendChild(addColDiv);
}

// --- Column ---
function createColumnEl(col) {
  const div = document.createElement('div');
  div.className = 'column';
  div.dataset.columnId = col.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';

  const titleInput = document.createElement('input');
  titleInput.className = 'column-title';
  titleInput.value = col.title;
  titleInput.readOnly = true;
  titleInput.onclick = () => { titleInput.readOnly = false; titleInput.focus(); };
  titleInput.onblur = async () => {
    if (!titleInput.value.trim()) {
      titleInput.value = col.title;
      titleInput.readOnly = true;
      return;
    }
    titleInput.readOnly = true;
    if (titleInput.value !== col.title) {
      try {
        await api(`/api/columns/${col.id}`, 'PATCH', { title: titleInput.value });
        col.title = titleInput.value;
      } catch (e) {
        showError(e.message);
        titleInput.value = col.title;
      }
    }
  };
  titleInput.onkeydown = (e) => { if (e.key === 'Enter') titleInput.blur(); };

  const count = document.createElement('span');
  count.className = 'column-count';
  count.textContent = col.cards.length;

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-col-btn';
  deleteBtn.innerHTML = '&times;';
  deleteBtn.title = 'Spalte löschen';
  deleteBtn.onclick = async () => {
    if (!confirm(`Spalte "${col.title}" mit allen Karten löschen?`)) return;
    try {
      await api(`/api/columns/${col.id}`, 'DELETE');
      pushUndo({
        description: `Spalte "${col.title}" gelöscht`,
        undo: async () => {
          await api(`/api/boards/${boardId}/columns`, 'POST', { title: col.title });
        }
      });
      loadBoard();
    } catch (e) {
      showError(e.message);
    }
  };

  if (!canEdit()) {
    titleInput.onclick = null;
    titleInput.readOnly = true;
    titleInput.style.pointerEvents = 'none';
    deleteBtn.style.display = 'none';
  }

  if (col.wip_limit > 0) {
    const wipBadge = document.createElement('span');
    wipBadge.className = 'wip-badge';
    wipBadge.textContent = `max ${col.wip_limit}`;
    if (col.cards.length >= col.wip_limit) {
      wipBadge.classList.add('wip-exceeded');
    }
    header.insertBefore(wipBadge, deleteBtn);
  }

  count.ondblclick = async () => {
    const limit = prompt('WIP-Limit setzen (0 = kein Limit):', col.wip_limit || '0');
    if (limit === null) return;
    const num = parseInt(limit);
    if (isNaN(num) || num < 0) return;
    try {
      await api(`/api/columns/${col.id}`, 'PATCH', { wip_limit: num });
      loadBoard();
    } catch (e) { showError(e.message); }
  };
  count.title = 'Doppelklick: WIP-Limit setzen';

  header.appendChild(titleInput);
  header.appendChild(count);
  header.appendChild(deleteBtn);

  // Column drag & drop
  header.draggable = true;
  header.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/column', col.id.toString());
    e.dataTransfer.effectAllowed = 'move';
    div.classList.add('dragging');
  });
  header.addEventListener('dragend', () => {
    div.classList.remove('dragging');
  });

  // Cards container
  const cardsContainer = document.createElement('div');
  cardsContainer.className = 'cards-container';
  cardsContainer.dataset.columnId = col.id;

  // Drag & drop on container
  cardsContainer.addEventListener('dragover', handleDragOver);
  cardsContainer.addEventListener('dragleave', handleDragLeave);
  cardsContainer.addEventListener('drop', handleDrop);

  const sortBy = document.getElementById('boardSort')?.value;
  let sortedCards = [...col.cards];
  if (sortBy === 'alpha') {
    sortedCards.sort((a, b) => a.text.localeCompare(b.text));
  } else if (sortBy === 'date') {
    sortedCards.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  } else if (sortBy === 'due') {
    sortedCards.sort((a, b) => {
      if (!a.due_date && !b.due_date) return 0;
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date.localeCompare(b.due_date);
    });
  }

  for (const card of sortedCards) {
    cardsContainer.appendChild(createCardEl(card));
  }

  // Add card input
  const addCard = document.createElement('div');
  addCard.className = 'add-card';
  const addInput = document.createElement('input');
  addInput.placeholder = '+ Karte hinzufügen...';
  addInput.onkeydown = async (e) => {
    if (e.key === 'Enter' && addInput.value.trim()) {
      try {
        const newCard = await api(`/api/columns/${col.id}/cards`, 'POST', { text: addInput.value.trim() });
        addInput.value = '';
        const token = window._accessToken ? `?token=${window._accessToken}` : '';
        window.location.href = `/board/${boardId}/card/${newCard.id}${token}`;
      } catch (e) {
        showError(e.message);
      }
    }
  };
  addCard.appendChild(addInput);

  // Card template dropdown
  const templateSelect = document.createElement('select');
  templateSelect.className = 'card-template-select';
  templateSelect.title = 'Aus Vorlage erstellen';
  templateSelect.innerHTML = '<option value="">Vorlage...</option>';
  // Populate lazily on focus
  templateSelect.onfocus = async () => {
    if (templateSelect.dataset.loaded) return;
    templateSelect.dataset.loaded = '1';
    try {
      const templates = await api(`/api/boards/${boardId}/card-templates`);
      for (const t of templates) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        templateSelect.appendChild(opt);
      }
    } catch {}
  };
  templateSelect.onchange = async () => {
    const templateId = Number(templateSelect.value);
    if (!templateId) return;
    templateSelect.value = '';
    try {
      const newCard = await api(`/api/columns/${col.id}/cards/from-template`, 'POST', { templateId });
      const token = window._accessToken ? `?token=${window._accessToken}` : '';
      window.location.href = `/board/${boardId}/card/${newCard.id}${token}`;
    } catch (e) { showError(e.message); }
  };
  addCard.appendChild(templateSelect);

  if (!canEdit()) {
    addCard.style.display = 'none';
  }

  div.appendChild(header);
  div.appendChild(cardsContainer);
  div.appendChild(addCard);
  return div;
}

// --- Card ---
function createCardEl(card) {
  const div = document.createElement('div');
  div.className = 'card';
  div.draggable = canEdit();
  div.dataset.cardId = card.id;
  div.dataset.columnId = card.column_id;
  div.dataset.position = card.position;

  // Activity highlighting: if card was modified by someone else
  if (modifiedCards.has(card.id)) {
    div.classList.add('card-activity-highlight');
  }

  // Label dots
  if (card.labels && card.labels.length > 0) {
    const dots = document.createElement('div');
    dots.className = 'card-label-dots';
    for (const label of card.labels) {
      const dot = document.createElement('div');
      dot.className = 'card-label-dot';
      dot.style.background = label.color;
      dot.title = label.name;
      dots.appendChild(dot);
    }
    div.appendChild(dots);
  }

  // Thumbnail if image attachment exists
  if (card.attachments && card.attachments.length > 0) {
    const img = card.attachments.find(a => a.mimetype && a.mimetype.startsWith('image/'));
    if (img) {
      const thumb = document.createElement('img');
      thumb.className = 'card-thumbnail';
      thumb.src = '/uploads/' + img.filepath.split(/[/\\]/).pop();
      thumb.alt = img.filename;
      div.appendChild(thumb);
    }
  }

  const textDiv = document.createElement('div');
  textDiv.className = 'card-text';
  textDiv.textContent = card.text;
  div.appendChild(textDiv);

  // Meta indicators
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  let hasMeta = false;

  if (card.checklist && card.checklist.length > 0) {
    const done = card.checklist.filter(i => i.checked).length;
    const total = card.checklist.length;
    const span = document.createElement('span');
    span.className = 'check-indicator' + (done === total ? ' done' : '');
    span.textContent = `\u2713 ${done}/${total}`;
    meta.appendChild(span);
    hasMeta = true;
  }

  if (card.attachments && card.attachments.length > 0) {
    const span = document.createElement('span');
    span.textContent = `\uD83D\uDCCE ${card.attachments.length}`;
    meta.appendChild(span);
    hasMeta = true;
  }

  if (card.due_date) {
    const due = new Date(card.due_date);
    const now = new Date();
    const dueSpan = document.createElement('span');
    const isOverdue = due < now;
    const isSoon = !isOverdue && (due - now) < 86400000 * 2; // 2 days
    dueSpan.style.cssText = isOverdue ? 'color:#dc2626;' : isSoon ? 'color:#f59e0b;' : '';
    dueSpan.textContent = '\uD83D\uDCC5 ' + due.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    meta.appendChild(dueSpan);
    hasMeta = true;
  }

  if (card.comments && card.comments.length > 0) {
    const commentSpan = document.createElement('span');
    commentSpan.textContent = `\uD83D\uDCAC ${card.comments.length}`;
    commentSpan.title = 'Kommentare';
    meta.appendChild(commentSpan);
    hasMeta = true;
  }

  if (card.assignees && card.assignees.length > 0) {
    const assigneeSpan = document.createElement('span');
    assigneeSpan.className = 'card-assignees';
    for (const a of card.assignees) {
      const dot = document.createElement('span');
      dot.className = 'assignee-dot';
      dot.textContent = a.username.charAt(0).toUpperCase();
      dot.style.background = stringToColor(a.username);
      dot.title = a.username;
      assigneeSpan.appendChild(dot);
    }
    meta.appendChild(assigneeSpan);
    hasMeta = true;
  }

  // Show creator
  if (card.created_by) {
    const creatorSpan = document.createElement('span');
    creatorSpan.className = 'card-creator';
    creatorSpan.textContent = card.created_by;
    creatorSpan.title = 'Erstellt von ' + card.created_by;
    meta.appendChild(creatorSpan);
    hasMeta = true;
  }

  if (hasMeta) div.appendChild(meta);

  if (card.priority) {
    const colors = { high: '#dc2626', medium: '#f59e0b', low: '#22c55e' };
    div.style.borderLeft = `4px solid ${colors[card.priority] || 'transparent'}`;
  }

  // Bulk select checkbox
  if (window._bulkMode && window._bulkMode()) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'card-bulk-checkbox';
    cb.checked = window._selectedCards && window._selectedCards.has(card.id);
    cb.onclick = (e) => {
      e.stopPropagation();
      if (window._selectedCards) {
        if (cb.checked) window._selectedCards.add(card.id);
        else window._selectedCards.delete(card.id);
        if (window._updateBulkCount) window._updateBulkCount();
      }
    };
    div.insertBefore(cb, div.firstChild);
  }

  // Click to navigate to card page
  div.onclick = (e) => {
    if (e.target.closest('.card-thumbnail')) return;
    if (e.target.classList.contains('card-bulk-checkbox')) return;
    if (window._bulkMode && window._bulkMode()) {
      // In bulk mode: toggle selection
      const cb = div.querySelector('.card-bulk-checkbox');
      if (cb) { cb.checked = !cb.checked; cb.onclick(e); }
      return;
    }
    modifiedCards.delete(card.id);
    const token = window._accessToken ? `?token=${window._accessToken}` : '';
    window.location.href = `/board/${boardId}/card/${card.id}${token}`;
  };

  // Drag events
  div.addEventListener('dragstart', handleDragStart);
  div.addEventListener('dragend', handleDragEnd);

  // Touch drag support
  let touchClone = null;
  let touchSource = null;

  div.addEventListener('touchstart', (e) => {
    if (!canEdit()) return;
    const touch = e.touches[0];
    touchSource = div;

    // Long press to start drag
    div._touchTimer = setTimeout(() => {
      div.classList.add('dragging');
      touchClone = div.cloneNode(true);
      touchClone.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;opacity:0.8;width:' + div.offsetWidth + 'px;';
      touchClone.style.left = touch.clientX - 20 + 'px';
      touchClone.style.top = touch.clientY - 20 + 'px';
      document.body.appendChild(touchClone);
    }, 300);
  }, { passive: true });

  div.addEventListener('touchmove', (e) => {
    if (!touchClone) {
      clearTimeout(div._touchTimer);
      return;
    }
    e.preventDefault();
    const touch = e.touches[0];
    touchClone.style.left = touch.clientX - 20 + 'px';
    touchClone.style.top = touch.clientY - 20 + 'px';
  }, { passive: false });

  div.addEventListener('touchend', async (e) => {
    clearTimeout(div._touchTimer);
    if (!touchClone || !touchSource) return;

    touchSource.classList.remove('dragging');
    const touch = e.changedTouches[0];
    document.body.removeChild(touchClone);
    touchClone = null;

    // Find target column under touch point
    const elements = document.elementsFromPoint(touch.clientX, touch.clientY);
    const targetContainer = elements.find(el => el.classList && el.classList.contains('cards-container'));
    if (targetContainer && touchSource.dataset.cardId) {
      const targetColumnId = Number(targetContainer.dataset.columnId);
      const cards = [...targetContainer.querySelectorAll('.card')];
      let position = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        if (touch.clientY < rect.top + rect.height / 2) {
          position = i;
          break;
        }
      }
      try {
        await api(`/api/cards/${touchSource.dataset.cardId}/move`, 'PUT', { columnId: targetColumnId, position });
        loadBoard();
      } catch (err) { showError(err.message); }
    }
    touchSource = null;
  });

  return div;
}

// --- Drag & Drop ---
let draggedCardId = null;

function handleDragStart(e) {
  draggedCardId = this.dataset.cardId;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/card', this.dataset.cardId);
}

function handleDragEnd(e) {
  this.classList.remove('dragging');
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  draggedCardId = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  this.classList.add('drag-over');

  // Remove existing indicators
  document.querySelectorAll('.drop-indicator').forEach(el => el.remove());

  // Find insertion point
  const cards = [...this.querySelectorAll('.card:not(.dragging)')];
  const afterEl = getInsertionPoint(cards, e.clientY);

  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  if (afterEl) {
    this.insertBefore(indicator, afterEl);
  } else {
    this.appendChild(indicator);
  }
}

function handleDragLeave(e) {
  if (!this.contains(e.relatedTarget)) {
    this.classList.remove('drag-over');
    this.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  }
}

async function handleDrop(e) {
  e.preventDefault();
  this.classList.remove('drag-over');
  document.querySelectorAll('.drop-indicator').forEach(el => el.remove());

  // Ignore column drags
  if (e.dataTransfer.types.includes('text/column')) return;

  if (!draggedCardId) return;

  const targetColumnId = this.dataset.columnId;
  const cards = [...this.querySelectorAll('.card:not(.dragging)')];
  const afterEl = getInsertionPoint(cards, e.clientY);

  let position;
  if (afterEl) {
    position = cards.indexOf(afterEl);
  } else {
    position = cards.length;
  }

  try {
    await api(`/api/cards/${draggedCardId}/move`, 'PUT', {
      columnId: Number(targetColumnId),
      position
    });
    loadBoard();
  } catch (e) {
    showError(e.message);
  } finally {
    draggedCardId = null;
  }
}

function getInsertionPoint(cards, y) {
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      return card;
    }
  }
  return null;
}

// --- Card Modal ---
function setupModal() {
  document.getElementById('modalOverlay').onclick = (e) => {
    if (e.target.id === 'modalOverlay') closeModal();
  };
  document.getElementById('modalClose').onclick = closeModal;

  // Save title on blur
  document.getElementById('modalCardText').onblur = async () => {
    if (!currentCardId) return;
    const text = document.getElementById('modalCardText').value.trim();
    if (text) {
      try {
        await api(`/api/cards/${currentCardId}`, 'PATCH', { text });
      } catch (e) {
        showError(e.message);
      }
    }
  };
  document.getElementById('modalCardText').onkeydown = (e) => {
    if (e.key === 'Enter') e.target.blur();
  };

  // Description
  const descArea = document.getElementById('modalDescription');
  if (descArea) {
    descArea.onblur = async () => {
      if (!currentCardId) return;
      const desc = descArea.value;
      try {
        await api(`/api/cards/${currentCardId}`, 'PATCH', { description: desc });
      } catch (e) {
        showError(e.message);
      }
    };
  }

  // Due date
  const dueDateInput = document.getElementById('modalDueDate');
  if (dueDateInput) {
    dueDateInput.onchange = async () => {
      if (!currentCardId) return;
      try {
        await api(`/api/cards/${currentCardId}`, 'PATCH', { due_date: dueDateInput.value || null });
      } catch (e) { showError(e.message); }
    };
  }

  // Archive card
  document.getElementById('archiveCardBtn').onclick = () => withLoading(document.getElementById('archiveCardBtn'), async () => {
    if (!currentCardId) return;
    try {
      const cardData = findCard(currentCardId);
      await api(`/api/cards/${currentCardId}/archive`, 'PUT');
      if (cardData) {
        pushUndo({
          description: `Karte "${cardData.text}" archiviert`,
          undo: async () => {
            await api(`/api/cards/${cardData.id}/restore`, 'PUT');
          }
        });
      }
      closeModal();
      loadBoard();
    } catch (e) { showError(e.message); }
  });

  // Restore card
  const restoreBtn = document.getElementById('restoreCardBtn');
  if (restoreBtn) {
    restoreBtn.onclick = () => withLoading(restoreBtn, async () => {
      if (!currentCardId) return;
      try {
        await api(`/api/cards/${currentCardId}/restore`, 'PUT');
        closeModal();
        loadBoard();
      } catch (e) { showError(e.message); }
    });
  }

  // Delete card
  document.getElementById('deleteCardBtn').onclick = () => withLoading(document.getElementById('deleteCardBtn'), async () => {
    if (!currentCardId || !confirm('Karte löschen?')) return;
    const cardData = findCard(currentCardId);
    try {
      await api(`/api/cards/${currentCardId}`, 'DELETE');
      if (cardData) {
        pushUndo({
          description: `Karte "${cardData.text}" gelöscht`,
          undo: async () => {
            await api(`/api/columns/${cardData.column_id}/cards`, 'POST', { text: cardData.text });
          }
        });
      }
      closeModal();
      loadBoard();
    } catch (e) {
      showError(e.message);
    }
  });

  // Comments
  document.getElementById('addCommentBtn').onclick = addComment;
  document.getElementById('commentInput').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(); }
  };
  // Markdown hint below comment input
  const addCommentBtn = document.getElementById('addCommentBtn');
  if (addCommentBtn) {
    const hint = document.createElement('small');
    hint.style.cssText = 'color:#94a3b8;font-size:11px;display:block;margin-top:4px;';
    hint.textContent = 'Markdown: **fett**, *kursiv*, `code`, [Link](url)';
    addCommentBtn.closest('.add-row').insertAdjacentElement('afterend', hint);
  }

  // Labels
  const addLabelBtn = document.getElementById('addLabelBtn');
  const labelDropdown = document.getElementById('labelDropdown');
  if (addLabelBtn && labelDropdown) {
    addLabelBtn.onclick = () => {
      labelDropdown.classList.toggle('hidden');
      if (!labelDropdown.classList.contains('hidden')) renderLabelPicker();
    };
    document.getElementById('createLabelBtn').onclick = createNewLabel;
    document.getElementById('newLabelName').onkeydown = (e) => {
      if (e.key === 'Enter') createNewLabel();
    };
  }

  // Checklist add
  document.getElementById('addChecklistBtn').onclick = addChecklistItem;
  document.getElementById('checklistInput').onkeydown = (e) => {
    if (e.key === 'Enter') addChecklistItem();
  };

  // File upload
  document.getElementById('uploadBtn').onclick = () => document.getElementById('fileInput').click();
  document.getElementById('fileInput').onchange = uploadFiles;

  // Drag & drop upload
  const uploadArea = document.getElementById('uploadArea');
  uploadArea.ondragover = (e) => { e.preventDefault(); uploadArea.classList.add('drag-active'); };
  uploadArea.ondragleave = () => uploadArea.classList.remove('drag-active');
  uploadArea.ondrop = (e) => {
    e.preventDefault();
    uploadArea.classList.remove('drag-active');
    if (e.dataTransfer.files.length) {
      uploadFilesFromList(e.dataTransfer.files);
    }
  };

  document.getElementById('moveCardBtn').onclick = () => withLoading(document.getElementById('moveCardBtn'), async () => {
    if (!currentCardId) return;
    const select = document.getElementById('moveColumnSelect');
    const targetCol = Number(select.value);
    try {
      await api(`/api/cards/${currentCardId}/move`, 'PUT', { columnId: targetCol, position: 0 });
      closeModal();
      loadBoard();
    } catch (e) { showError(e.message); }
  });

  // Priority buttons
  document.querySelectorAll('.priority-btn').forEach(btn => {
    btn.onclick = async () => {
      if (!currentCardId) return;
      const priority = btn.dataset.priority || null;
      try {
        await api(`/api/cards/${currentCardId}`, 'PATCH', { priority });
        document.querySelectorAll('.priority-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      } catch (e) { showError(e.message); }
    };
  });

  // Assignee select
  document.getElementById('assignUserSelect').onchange = async () => {
    const select = document.getElementById('assignUserSelect');
    const userId = Number(select.value);
    if (!userId || !currentCardId) return;
    select.value = '';
    try {
      await api(`/api/cards/${currentCardId}/assignees/${userId}`, 'POST');
      board = await api(`/api/boards/${boardId}`);
      const card = findCard(currentCardId);
      if (card) renderAssignees(card.assignees || []);
    } catch (e) { showError(e.message); }
  };
}

async function openCardModal(card) {
  currentCardId = card.id;
  document.getElementById('modalCardText').value = card.text;
  const descArea = document.getElementById('modalDescription');
  if (descArea) descArea.value = card.description || '';
  const dueDateInput = document.getElementById('modalDueDate');
  if (dueDateInput) {
    dueDateInput.value = card.due_date || '';
  }
  // Priority
  document.querySelectorAll('.priority-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.priority === (card.priority || ''));
  });
  renderChecklist(card.checklist || []);
  renderAttachments(card.attachments || []);
  renderCardLabels(card.labels || []);
  renderComments(card.comments || []);
  // Assignees
  renderAssignees(card.assignees || []);
  const assignSelect = document.getElementById('assignUserSelect');
  if (assignSelect) {
    assignSelect.innerHTML = '<option value="">+ Benutzer zuweisen...</option>';
    try {
      if (currentUser && currentUser.is_admin) {
        const users = await api('/api/admin/users');
        const assigned = new Set((card.assignees || []).map(a => a.id));
        for (const u of users) {
          if (!assigned.has(u.id)) {
            const opt = document.createElement('option');
            opt.value = u.id;
            opt.textContent = u.username;
            assignSelect.appendChild(opt);
          }
        }
      }
    } catch {}
  }
  const moveSelect = document.getElementById('moveColumnSelect');
  if (moveSelect && board) {
    moveSelect.innerHTML = '';
    for (const col of board.columns) {
      const opt = document.createElement('option');
      opt.value = col.id;
      opt.textContent = col.title;
      if (col.id === card.column_id) opt.selected = true;
      moveSelect.appendChild(opt);
    }
  }
  const archiveBtn = document.getElementById('archiveCardBtn');
  if (archiveBtn) archiveBtn.style.display = card.archived ? 'none' : '';
  const restoreBtn = document.getElementById('restoreCardBtn');
  if (restoreBtn) restoreBtn.style.display = card.archived ? '' : 'none';
  document.getElementById('modalOverlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.add('hidden');
  currentCardId = null;
  document.getElementById('checklistInput').value = '';
  document.getElementById('fileInput').value = '';
  const dd = document.getElementById('labelDropdown');
  if (dd) dd.classList.add('hidden');
  const commentInput = document.getElementById('commentInput');
  if (commentInput) commentInput.value = '';
  if (window._pendingBoardReload) {
    window._pendingBoardReload = false;
    loadBoard();
  }
}

// --- Labels ---
function renderCardLabels(labels) {
  const container = document.getElementById('cardLabels');
  if (!container) return;
  container.innerHTML = '';
  for (const label of labels) {
    const tag = document.createElement('span');
    tag.className = 'label-tag';
    tag.style.background = label.color;
    tag.textContent = label.name;
    const rm = document.createElement('button');
    rm.className = 'remove-label';
    rm.innerHTML = '&times;';
    rm.onclick = async () => {
      try {
        await api(`/api/cards/${currentCardId}/labels/${label.id}`, 'DELETE');
        reloadCardLabels();
      } catch (e) { showError(e.message); }
    };
    tag.appendChild(rm);
    container.appendChild(tag);
  }
}

function renderLabelPicker() {
  const list = document.getElementById('boardLabelsList');
  if (!list || !board) return;
  list.innerHTML = '';
  const cardLabels = findCard(currentCardId)?.labels || [];
  const cardLabelIds = new Set(cardLabels.map(l => l.id));

  for (const label of (board.labels || [])) {
    const item = document.createElement('div');
    item.className = 'board-label-item';

    const dot = document.createElement('div');
    dot.className = 'label-color-dot';
    dot.style.background = label.color;

    const name = document.createElement('span');
    name.className = 'label-name';
    name.textContent = label.name;

    const check = document.createElement('span');
    check.className = 'label-check';
    check.textContent = cardLabelIds.has(label.id) ? '\u2713' : '';

    const del = document.createElement('button');
    del.className = 'delete-label-btn';
    del.innerHTML = '&times;';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Label "${label.name}" löschen?`)) return;
      try {
        await api(`/api/labels/${label.id}`, 'DELETE');
        board.labels = board.labels.filter(l => l.id !== label.id);
        renderLabelPicker();
        reloadCardLabels();
      } catch (err) { showError(err.message); }
    };

    item.onclick = async () => {
      try {
        if (cardLabelIds.has(label.id)) {
          await api(`/api/cards/${currentCardId}/labels/${label.id}`, 'DELETE');
        } else {
          await api(`/api/cards/${currentCardId}/labels/${label.id}`, 'POST');
        }
        reloadCardLabels();
        renderLabelPicker();
      } catch (e) { showError(e.message); }
    };

    item.appendChild(dot);
    item.appendChild(name);
    item.appendChild(check);
    item.appendChild(del);
    list.appendChild(item);
  }
}

async function createNewLabel() {
  const nameInput = document.getElementById('newLabelName');
  const colorInput = document.getElementById('newLabelColor');
  const name = nameInput.value.trim();
  if (!name || !board) return;
  nameInput.value = '';
  try {
    const label = await api(`/api/boards/${boardId}/labels`, 'POST', { name, color: colorInput.value });
    if (!board.labels) board.labels = [];
    board.labels.push(label);
    renderLabelPicker();
  } catch (e) {
    showError(e.message);
    nameInput.value = name;
  }
}

async function reloadCardLabels() {
  if (!currentCardId) return;
  board = await api(`/api/boards/${boardId}`);
  const card = findCard(currentCardId);
  if (card) renderCardLabels(card.labels || []);
}

// --- Checklist ---
function renderChecklist(items) {
  const container = document.getElementById('checklistItems');
  container.innerHTML = '';

  const total = items.length;
  const done = items.filter(i => i.checked).length;

  // Progress bar
  if (total > 0) {
    const progressBar = document.createElement('div');
    progressBar.className = 'progress-bar';
    const fill = document.createElement('div');
    fill.className = 'progress-bar-fill' + (done === total ? ' complete' : '');
    fill.style.width = Math.round((done / total) * 100) + '%';
    progressBar.appendChild(fill);
    container.appendChild(progressBar);
  }

  document.getElementById('checklistProgress').textContent = total > 0 ? `${done}/${total}` : '';

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'checklist-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = item.checked;
    cb.onchange = async () => {
      try {
        await api(`/api/checklist/${item.id}`, 'PATCH', { checked: cb.checked });
        reloadModalChecklist();
      } catch (e) {
        showError(e.message);
      }
    };

    const text = document.createElement('span');
    text.className = 'item-text' + (item.checked ? ' checked' : '');
    text.textContent = item.text;

    const del = document.createElement('button');
    del.className = 'delete-item';
    del.innerHTML = '&times;';
    del.onclick = async () => {
      try {
        await api(`/api/checklist/${item.id}`, 'DELETE');
        reloadModalChecklist();
      } catch (e) {
        showError(e.message);
      }
    };

    row.appendChild(cb);
    row.appendChild(text);
    row.appendChild(del);
    container.appendChild(row);
  }
}

async function addChecklistItem() {
  const input = document.getElementById('checklistInput');
  const text = input.value.trim();
  if (!text || !currentCardId) return;
  input.value = ''; // clear immediately to prevent double submit
  try {
    await api(`/api/cards/${currentCardId}/checklist`, 'POST', { text });
    reloadModalChecklist();
  } catch (e) {
    showError(e.message);
    input.value = text; // restore on error
  }
}

async function reloadModalChecklist() {
  if (!currentCardId) return;
  try {
    const items = await api(`/api/cards/${currentCardId}/checklist`);
    renderChecklist(items);
    loadBoard(); // refresh card indicators
  } catch (e) {
    showError(e.message);
  }
}

// --- Attachments ---
function renderAttachments(attachments) {
  const container = document.getElementById('attachmentsList');
  container.innerHTML = '';

  for (const att of attachments) {
    const item = document.createElement('div');
    item.className = 'attachment-item';

    if (att.mimetype && att.mimetype.startsWith('image/')) {
      const thumb = document.createElement('img');
      thumb.className = 'attachment-thumb';
      thumb.src = '/uploads/' + att.filepath.split(/[/\\]/).pop();
      thumb.alt = att.filename;
      item.appendChild(thumb);
    } else {
      const icon = document.createElement('div');
      icon.className = 'attachment-icon';
      icon.textContent = '\uD83D\uDCC4';
      item.appendChild(icon);
    }

    const info = document.createElement('div');
    info.className = 'attachment-info';

    const name = document.createElement('a');
    name.className = 'attachment-name';
    name.href = `/api/attachments/${att.id}`;
    name.textContent = att.filename;
    name.target = '_blank';

    const size = document.createElement('div');
    size.className = 'attachment-size';
    size.textContent = formatSize(att.size);

    info.appendChild(name);
    info.appendChild(size);

    const del = document.createElement('button');
    del.className = 'attachment-delete';
    del.innerHTML = '&times;';
    del.onclick = async () => {
      try {
        await api(`/api/attachments/${att.id}`, 'DELETE');
        reloadModalAttachments();
      } catch (e) {
        showError(e.message);
      }
    };

    item.appendChild(info);
    item.appendChild(del);
    container.appendChild(item);
  }
}

async function uploadFiles() {
  const files = document.getElementById('fileInput').files;
  await uploadFilesFromList(files);
}

async function uploadFilesFromList(files) {
  if (!currentCardId || !files.length) return;
  try {
    for (const file of files) {
      const form = new FormData();
      form.append('file', file);
      await api(`/api/cards/${currentCardId}/attachments`, 'POST', form);
    }
    document.getElementById('fileInput').value = '';
    reloadModalAttachments();
  } catch (e) {
    showError(e.message);
  }
}

async function reloadModalAttachments() {
  if (!currentCardId) return;
  try {
    // Re-fetch full board to get updated attachments, but don't re-render the board
    // while the modal is open. The board will re-render when the modal closes via loadBoard().
    board = await api(`/api/boards/${boardId}`);
    const card = findCard(currentCardId);
    if (card) renderAttachments(card.attachments || []);
  } catch (e) {
    showError(e.message);
  }
}

function findCard(cardId) {
  for (const col of board.columns) {
    for (const card of col.cards) {
      if (card.id === Number(cardId)) return card;
    }
  }
  return null;
}

function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const h = hash % 360;
  return `hsl(${h}, 60%, 45%)`;
}

function renderAssignees(assignees) {
  const container = document.getElementById('cardAssignees');
  if (!container) return;
  container.innerHTML = '';
  for (const a of assignees) {
    const tag = document.createElement('span');
    tag.className = 'assignee-tag';
    const initial = document.createElement('span');
    initial.className = 'assignee-initial';
    initial.textContent = a.username.charAt(0).toUpperCase();
    initial.style.background = stringToColor(a.username);
    tag.appendChild(initial);
    const name = document.createElement('span');
    name.textContent = a.username;
    tag.appendChild(name);
    const rm = document.createElement('button');
    rm.className = 'remove-label';
    rm.innerHTML = '&times;';
    rm.onclick = async () => {
      try {
        await api(`/api/cards/${currentCardId}/assignees/${a.id}`, 'DELETE');
        board = await api(`/api/boards/${boardId}`);
        const card = findCard(currentCardId);
        if (card) renderAssignees(card.assignees || []);
      } catch (e) { showError(e.message); }
    };
    tag.appendChild(rm);
    container.appendChild(tag);
  }
}

function renderPresence(users) {
  let container = document.getElementById('presenceIndicator');
  if (!container) {
    container = document.createElement('div');
    container.id = 'presenceIndicator';
    container.className = 'presence-indicator';
    document.querySelector('header').insertBefore(container, document.querySelector('.header-actions'));
  }
  container.innerHTML = '';
  for (const u of users) {
    const dot = document.createElement('span');
    dot.className = 'presence-dot';
    dot.textContent = u.username.charAt(0).toUpperCase();
    dot.style.background = stringToColor(u.username);
    dot.title = u.username + ' (online)';
    container.appendChild(dot);
  }
}

function renderMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)"'<>]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n/g, '<br>');
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// --- Activity Panel ---
function setupActivityPanel() {
  document.getElementById('activityBtn').onclick = toggleActivity;
  document.getElementById('closeActivity').onclick = () => {
    document.getElementById('activityPanel').classList.add('hidden');
  };
  const closeArchiveBtn = document.getElementById('closeArchive');
  if (closeArchiveBtn) {
    closeArchiveBtn.onclick = () => {
      document.getElementById('archivePanel').classList.add('hidden');
    };
  }
}

async function toggleActivity() {
  const panel = document.getElementById('activityPanel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }

  try {
    const ACTIVITY_PAGE_SIZE = 50;
    const activities = await api(`/api/boards/${boardId}/activity?limit=${ACTIVITY_PAGE_SIZE}`);
    const list = document.getElementById('activityList');
    list.innerHTML = '';

    const lastVisit = localStorage.getItem('lastVisit_' + boardId);
    localStorage.setItem('lastVisit_' + boardId, new Date().toISOString());
    document.getElementById('activityBadge').classList.add('hidden');

    if (activities.length === 0) {
      list.innerHTML = '<p style="color:#94a3b8;padding:20px;text-align:center;">Noch keine Aktivität.</p>';
    } else {
      renderActivityItems(list, activities, lastVisit);

      // Load more button if we got a full page
      if (activities.length >= ACTIVITY_PAGE_SIZE) {
        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'load-more-btn';
        loadMoreBtn.textContent = 'Mehr laden...';
        let offset = ACTIVITY_PAGE_SIZE;
        loadMoreBtn.onclick = async () => {
          loadMoreBtn.disabled = true;
          loadMoreBtn.textContent = '...';
          try {
            const more = await api(`/api/boards/${boardId}/activity?limit=${ACTIVITY_PAGE_SIZE}&offset=${offset}`);
            if (more.length > 0) {
              renderActivityItems(list, more, lastVisit);
              offset += more.length;
            }
            if (more.length < ACTIVITY_PAGE_SIZE) {
              loadMoreBtn.remove();
            } else {
              loadMoreBtn.disabled = false;
              loadMoreBtn.textContent = 'Mehr laden...';
            }
          } catch (e) {
            showError(e.message);
            loadMoreBtn.disabled = false;
            loadMoreBtn.textContent = 'Mehr laden...';
          }
        };
        list.appendChild(loadMoreBtn);
      }
    }

    panel.classList.remove('hidden');
  } catch (e) {
    showError(e.message);
  }
}

function renderActivityItems(list, activities, lastVisit) {
  for (const act of activities) {
    const item = document.createElement('div');
    item.className = 'activity-item';
    if (lastVisit && act.created_at > lastVisit) {
      item.classList.add('new');
    }

    const details = JSON.parse(act.details || '{}');
    const actionText = formatAction(act.action, details);

    const actionDiv = document.createElement('div');
    actionDiv.className = 'activity-action';
    actionDiv.innerHTML = actionText;
    const timeDiv = document.createElement('div');
    timeDiv.className = 'activity-time';
    timeDiv.textContent = formatTime(act.created_at);
    item.appendChild(actionDiv);
    item.appendChild(timeDiv);

    // Insert before the load-more button if it exists
    const loadMoreBtn = list.querySelector('.load-more-btn');
    if (loadMoreBtn) {
      list.insertBefore(item, loadMoreBtn);
    } else {
      list.appendChild(item);
    }
  }
}

async function checkNewActivity() {
  const lastVisit = localStorage.getItem('lastVisit_' + boardId);
  if (!lastVisit) return;

  try {
    const activities = await api(`/api/boards/${boardId}/activity?limit=50`);
    const newCount = activities.filter(a => a.created_at > lastVisit).length;

    const badge = document.getElementById('activityBadge');
    if (newCount > 0) {
      badge.textContent = newCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (e) {
    showError(e.message);
  }
}

function formatAction(action, details) {
  const user = details.user ? `<span class="activity-user">${esc(details.user)}</span> ` : '';
  const actions = {
    board_created: () => `${user}Board <strong>${esc(details.title)}</strong> erstellt`,
    column_created: () => `${user}Spalte <strong>${esc(details.title)}</strong> hinzugefügt`,
    column_updated: () => `${user}Spalte umbenannt zu <strong>${esc(details.title)}</strong>`,
    column_deleted: () => `${user}Spalte <strong>${esc(details.title)}</strong> gelöscht`,
    card_created: () => `${user}Karte <strong>${esc(details.text)}</strong> in ${esc(details.columnTitle)} erstellt`,
    card_updated: () => `${user}Karte bearbeitet: <strong>${esc(details.text)}</strong>`,
    card_deleted: () => `${user}Karte <strong>${esc(details.text)}</strong> gelöscht`,
    card_moved: () => `${user}Karte <strong>${esc(details.text)}</strong> von ${esc(details.from)} nach ${esc(details.to)} verschoben`,
    card_archived: () => `${user}Karte <strong>${esc(details.text)}</strong> archiviert`,
    card_restored: () => `${user}Karte <strong>${esc(details.text)}</strong> wiederhergestellt`,
    comment_added: () => `${user}Kommentar zu <strong>${esc(details.cardText)}</strong>: "${esc((details.commentText || '').slice(0, 50))}"`,
    board_updated: () => `${user}Board umbenannt zu <strong>${esc(details.title)}</strong>`,
    board_imported: () => `${user}Board <strong>${esc(details.title)}</strong> importiert`,
    column_moved: () => `${user}Spalte verschoben`,
    access_link_created: () => `${user}Zugriffs-Link erstellt (${esc(details.permission)})`,
    file_uploaded: () => `${user}Datei <strong>${esc(details.filename)}</strong> hochgeladen`,
    checklist_item_added: () => `${user}Checklist-Item zu <strong>${esc(details.cardText)}</strong> hinzugefügt`,
    checklist_item_updated: () => `${user}Checklist-Item in <strong>${esc(details.cardText)}</strong> aktualisiert`,
  };
  return (actions[action] || (() => esc(action)))();
}

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(iso) {
  const d = new Date(/Z$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z');
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'gerade eben';
  if (diff < 3600) return Math.floor(diff / 60) + ' Min.';
  if (diff < 86400) return Math.floor(diff / 3600) + ' Std.';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// --- Comments ---
function renderComments(comments) {
  const container = document.getElementById('commentsList');
  if (!container) return;
  container.innerHTML = '';

  // Comments are already sorted newest first from the API
  for (const comment of comments) {
    const item = document.createElement('div');
    item.className = 'comment-item';

    // Author header
    if (comment.author) {
      const authorDiv = document.createElement('div');
      authorDiv.className = 'comment-author';
      const authorDot = document.createElement('span');
      authorDot.className = 'comment-author-dot';
      authorDot.textContent = comment.author.charAt(0).toUpperCase();
      authorDot.style.background = stringToColor(comment.author);
      authorDiv.appendChild(authorDot);
      const authorName = document.createElement('span');
      authorName.className = 'comment-author-name';
      authorName.textContent = comment.author;
      authorDiv.appendChild(authorName);
      item.appendChild(authorDiv);
    }

    const text = document.createElement('div');
    text.className = 'comment-text';
    text.innerHTML = renderMarkdown(comment.text);

    const footer = document.createElement('div');
    footer.className = 'comment-footer';

    const time = document.createElement('span');
    time.className = 'comment-time';
    time.textContent = formatTime(comment.created_at);

    const actions = document.createElement('span');
    actions.className = 'comment-actions';

    // Edit button
    if (canEdit()) {
      const edit = document.createElement('button');
      edit.className = 'comment-edit';
      edit.innerHTML = '&#9998;';
      edit.title = 'Bearbeiten';
      edit.onclick = () => {
        // Replace text div with textarea for editing
        const editArea = document.createElement('textarea');
        editArea.className = 'comment-edit-area';
        editArea.value = comment.text;
        editArea.rows = 3;
        text.replaceWith(editArea);
        editArea.focus();

        const saveRow = document.createElement('div');
        saveRow.className = 'comment-edit-actions';
        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Speichern';
        saveBtn.className = 'comment-save-btn';
        saveBtn.onclick = async () => {
          const newText = editArea.value.trim();
          if (!newText) return;
          try {
            await api(`/api/comments/${comment.id}`, 'PATCH', { text: newText });
            reloadComments();
          } catch (e) { showError(e.message); }
        };
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Abbrechen';
        cancelBtn.className = 'comment-cancel-btn';
        cancelBtn.onclick = () => reloadComments();
        saveRow.appendChild(saveBtn);
        saveRow.appendChild(cancelBtn);
        editArea.insertAdjacentElement('afterend', saveRow);
      };
      actions.appendChild(edit);
    }

    // Delete button
    const del = document.createElement('button');
    del.className = 'comment-delete';
    del.innerHTML = '&times;';
    del.onclick = async () => {
      try {
        await api(`/api/comments/${comment.id}`, 'DELETE');
        reloadComments();
      } catch (e) { showError(e.message); }
    };
    actions.appendChild(del);

    footer.appendChild(time);
    footer.appendChild(actions);
    item.appendChild(text);
    item.appendChild(footer);
    container.appendChild(item);
  }
}

async function addComment() {
  const input = document.getElementById('commentInput');
  const text = input.value.trim();
  if (!text || !currentCardId) return;
  input.value = '';
  try {
    await api(`/api/cards/${currentCardId}/comments`, 'POST', { text });
    reloadComments();
  } catch (e) {
    showError(e.message);
    input.value = text;
  }
}

async function reloadComments() {
  if (!currentCardId) return;
  try {
    const comments = await api(`/api/cards/${currentCardId}/comments`);
    renderComments(comments);
  } catch (e) {
    showError(e.message);
  }
}

// --- Archive Panel ---
async function toggleArchivePanel() {
  const panel = document.getElementById('archivePanel');
  if (!panel) return;
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }

  try {
    const archived = await api(`/api/boards/${boardId}/archived`);
    const list = document.getElementById('archivedList');
    list.innerHTML = '';

    if (archived.length === 0) {
      list.innerHTML = '<p style="color:#94a3b8;padding:20px;text-align:center;">Keine archivierten Karten.</p>';
    } else {
      for (const card of archived) {
        const item = document.createElement('div');
        item.className = 'archived-item';

        const text = document.createElement('span');
        text.className = 'archived-text';
        text.textContent = card.text;

        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'restore-btn';
        restoreBtn.textContent = 'Wiederherstellen';
        restoreBtn.onclick = async () => {
          try {
            await api(`/api/cards/${card.id}/restore`, 'PUT');
            document.getElementById('archivePanel').classList.add('hidden');
            loadBoard();
            setTimeout(() => toggleArchivePanel(), 300);
          } catch (e) { showError(e.message); }
        };

        item.appendChild(text);
        item.appendChild(restoreBtn);
        list.appendChild(item);
      }
    }

    panel.classList.remove('hidden');
  } catch (e) { showError(e.message); }
}

// --- Permissions Panel ---
async function togglePermissionsPanel() {
  // Reuse activity panel pattern
  let panel = document.getElementById('permissionsPanel');
  if (panel && !panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }

  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'permissionsPanel';
    panel.className = 'activity-panel';
    panel.innerHTML = `
      <div class="activity-header">
        <h2>Zugriff &amp; Links</h2>
        <button class="icon-btn" onclick="document.getElementById('permissionsPanel').classList.add('hidden')" aria-label="Schließen">&times;</button>
      </div>
      <div style="padding:12px 20px;border-bottom:1px solid #e2e8f0;">
        <div style="font-weight:600;margin-bottom:8px;font-size:14px;">&#127758; Öffentlicher Zugang</div>
        <p style="font-size:12px;color:#64748b;margin:0 0 8px;">Jeder mit dem Board-Link kann zugreifen (ohne Token).</p>
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="publicAccessPermission" style="padding:6px;border:1px solid #e2e8f0;border-radius:6px;">
            <option value="">Deaktiviert</option>
            <option value="view">Nur lesen</option>
            <option value="edit">Bearbeiten</option>
          </select>
          <button onclick="savePublicAccess()" style="padding:6px 12px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;">Speichern</button>
        </div>
      </div>
      <div id="accessLinksList" class="activity-list"></div>
      <div style="padding:12px 20px;border-top:1px solid #e2e8f0;">
        <div style="font-weight:600;margin-bottom:8px;font-size:14px;">+ Token-Link erstellen</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="newLinkPermission" style="padding:6px;border:1px solid #e2e8f0;border-radius:6px;">
            <option value="view">Nur lesen</option>
            <option value="edit">Bearbeiten</option>
          </select>
          <input type="text" id="newLinkLabel" placeholder="Bezeichnung..." style="flex:1;padding:6px;border:1px solid #e2e8f0;border-radius:6px;">
          <button onclick="createAccessLink()" style="padding:6px 12px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;">Erstellen</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
  }

  // Load public access setting and links
  try {
    const pubInfo = await fetch(`/api/boards/${boardId}/public-info`).then(r => r.json());
    const pubSelect = document.getElementById('publicAccessPermission');
    if (pubSelect) pubSelect.value = pubInfo.public_access || '';

    const links = await api(`/api/boards/${boardId}/access-links`);
    const visibleLinks = links.filter(l => !l.id.startsWith('pub_'));
    const list = document.getElementById('accessLinksList');
    list.innerHTML = '';

    if (visibleLinks.length === 0) {
      list.innerHTML = '<p style="color:#94a3b8;padding:20px;text-align:center;">Keine Token-Links.</p>';
    } else {
      for (const link of visibleLinks) {
        const item = document.createElement('div');
        item.style.cssText = 'padding:10px 0;border-bottom:1px solid #f1f5f9;';

        const url = window.location.origin + '/board/' + boardId + '?token=' + link.id;

        item.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <strong>${esc(link.label) || 'Link'}</strong>
              <span style="font-size:12px;padding:2px 6px;border-radius:4px;background:${link.permission === 'edit' ? '#dbeafe' : '#f1f5f9'};color:${link.permission === 'edit' ? '#2563eb' : '#64748b'};margin-left:4px;">${link.permission === 'edit' ? 'Bearbeiten' : 'Nur lesen'}</span>
            </div>
            <div style="display:flex;gap:4px;">
              <button class="icon-btn" title="Link kopieren" style="font-size:14px;padding:4px 8px;" data-copy-url>&#128279;</button>
              <button class="icon-btn" title="Löschen" style="font-size:14px;padding:4px 8px;color:#dc2626;" data-link-id="${esc(link.id)}">&#128465;</button>
            </div>
          </div>
        `;
        item.querySelector('[data-copy-url]').addEventListener('click', () => {
          if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(url).catch(() => {
              const ta = document.createElement('textarea');
              ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
              document.body.appendChild(ta); ta.select();
              try { document.execCommand('copy'); } catch {}
              document.body.removeChild(ta);
            });
          } else {
            const ta = document.createElement('textarea');
            ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); } catch {}
            document.body.removeChild(ta);
          }
        });

        item.querySelector('[data-link-id]').onclick = async () => {
          try {
            await api(`/api/access-links/${link.id}`, 'DELETE');
            togglePermissionsPanel();
          } catch (e) { showError(e.message); }
        };

        list.appendChild(item);
      }
    }

    panel.classList.remove('hidden');
  } catch (e) { showError(e.message); }
}

async function createAccessLink() {
  const permission = document.getElementById('newLinkPermission').value;
  const label = document.getElementById('newLinkLabel').value.trim();
  try {
    await api(`/api/boards/${boardId}/access-links`, 'POST', { permission, label });
    document.getElementById('newLinkLabel').value = '';
    togglePermissionsPanel(); // refresh
  } catch (e) { showError(e.message); }
}

async function savePublicAccess() {
  const permission = document.getElementById('publicAccessPermission').value || null;
  try {
    await api(`/api/boards/${boardId}/public-access`, 'PUT', { permission });
    const btn = document.querySelector('#permissionsPanel button[onclick="savePublicAccess()"]');
    if (btn) { const orig = btn.textContent; btn.textContent = '✓'; setTimeout(() => { btn.textContent = orig; }, 1500); }
  } catch (e) { showError(e.message); }
}

// --- Board Switcher ---
async function setupBoardSwitcher() {
  try {
    const boards = await api('/api/boards');

    if (boards.length <= 1) return;

    const switcher = document.createElement('select');
    switcher.className = 'board-switcher';
    switcher.setAttribute('aria-label', 'Board wechseln');

    for (const b of boards) {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.title;
      if (b.id === boardId) opt.selected = true;
      switcher.appendChild(opt);
    }

    switcher.onchange = () => {
      const newBoardId = switcher.value;
      if (newBoardId === boardId) return;
      // If navigating back to the board this named token belongs to, preserve
      // the token so the user doesn't lose access to a private board.
      const preserveToken = window._accessToken && _accessTokenBoardId && newBoardId === _accessTokenBoardId;
      window.location.href = '/board/' + newBoardId + (preserveToken ? '?token=' + encodeURIComponent(window._accessToken) : '');
    };

    // Insert after the home link, before boardTitle
    const header = document.querySelector('header');
    const boardTitle = document.getElementById('boardTitle');
    header.insertBefore(switcher, boardTitle);

    // Hide h1 when switcher is present — they both show the board name
    boardTitle.style.display = 'none';
  } catch {}
}

// --- Board Members Panel ---
async function toggleMembersPanel() {
  let panel = document.getElementById('membersPanel');
  if (panel && !panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }

  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'membersPanel';
    panel.className = 'activity-panel';
    panel.innerHTML = `
      <div class="activity-header">
        <h2>Board-Mitglieder</h2>
        <button class="icon-btn" onclick="document.getElementById('membersPanel').classList.add('hidden')" aria-label="Schließen">&times;</button>
      </div>
      <div id="membersList" class="activity-list"></div>
      <div style="padding:12px 20px;border-top:1px solid #e2e8f0;">
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="addMemberUser" style="flex:1;padding:6px;border:1px solid #e2e8f0;border-radius:6px;">
            <option value="">Benutzer hinzufügen...</option>
          </select>
          <select id="addMemberRole" style="padding:6px;border:1px solid #e2e8f0;border-radius:6px;">
            <option value="editor">Bearbeiter</option>
            <option value="viewer">Betrachter</option>
            <option value="admin">Board-Admin</option>
          </select>
          <button onclick="addBoardMember()" style="padding:6px 12px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;">+</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
  }

  try {
    const [members, allUsers] = await Promise.all([
      api(`/api/boards/${boardId}/members`),
      currentUser.is_admin ? api('/api/admin/users') : Promise.resolve([])
    ]);

    const list = document.getElementById('membersList');
    list.innerHTML = '';

    if (members.length === 0) {
      list.innerHTML = '<p style="color:#94a3b8;padding:20px;text-align:center;">Keine Mitglieder (alle Admins haben Zugriff).</p>';
    } else {
      for (const m of members) {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f1f5f9;';

        const info = document.createElement('div');
        const nameSpan = document.createElement('strong');
        nameSpan.textContent = m.username;
        const roleSpan = document.createElement('span');
        roleSpan.style.cssText = 'font-size:12px;padding:2px 6px;border-radius:4px;background:#f1f5f9;color:#64748b;margin-left:8px;';
        const roleLabels = { admin: 'Admin', editor: 'Bearbeiter', viewer: 'Betrachter' };
        roleSpan.textContent = roleLabels[m.role] || m.role;
        info.appendChild(nameSpan);
        info.appendChild(roleSpan);

        const del = document.createElement('button');
        del.style.cssText = 'background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px;';
        del.innerHTML = '&times;';
        del.onclick = async () => {
          try {
            await api(`/api/boards/${boardId}/members/${m.id}`, 'DELETE');
            toggleMembersPanel(); // refresh
          } catch (e) { showError(e.message); }
        };

        item.appendChild(info);
        item.appendChild(del);
        list.appendChild(item);
      }
    }

    // Populate add member dropdown
    const memberIds = new Set(members.map(m => m.id));
    const addSelect = document.getElementById('addMemberUser');
    addSelect.innerHTML = '<option value="">Benutzer hinzufügen...</option>';
    for (const u of allUsers) {
      if (!memberIds.has(u.id)) {
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = u.username;
        addSelect.appendChild(opt);
      }
    }

    panel.classList.remove('hidden');
  } catch (e) { showError(e.message); }
}

async function addBoardMember() {
  const userSelect = document.getElementById('addMemberUser');
  const roleSelect = document.getElementById('addMemberRole');
  const userId = Number(userSelect.value);
  if (!userId) return;
  try {
    await api(`/api/boards/${boardId}/members`, 'POST', { user_id: userId, role: roleSelect.value });
    userSelect.value = '';
    document.getElementById('membersPanel').classList.add('hidden');
    toggleMembersPanel(); // refresh
  } catch (e) { showError(e.message); }
}

// Expose functions used in inline onclick handlers to global scope
window.addBoardMember = addBoardMember;
window.createAccessLink = createAccessLink;

} // end boardId guard
