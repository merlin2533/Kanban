// --- State ---
let boardId = window.location.pathname.split('/board/')[1];
let board = null;
let currentCardId = null;

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

async function checkAuth() {
  // Check for access token in URL
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');

  try {
    const url = token ? `/api/auth/me?token=${token}` : '/api/auth/me';
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      currentPermission = 'admin';
    } else if (token) {
      // Validate access token via a board API call
      const boardRes = await fetch(`/api/boards/${boardId}?token=${token}`);
      if (boardRes.ok) {
        currentPermission = 'view'; // will be set properly by server
        // Store token for subsequent requests
        window._accessToken = token;
      } else {
        window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
        return false;
      }
    } else {
      window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
      return false;
    }
  } catch {
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

  // SSE real-time sync
  const eventSource = new EventSource(`/api/boards/${boardId}/events`);
  let sseDebounceTimer = null;
  eventSource.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.type === 'update') {
      clearTimeout(sseDebounceTimer);
      sseDebounceTimer = setTimeout(() => loadBoard(), 500);
    }
  };
  eventSource.onerror = () => {
    // Reconnect is automatic with EventSource
  };

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

  searchInput.oninput = () => {
    const query = searchInput.value.toLowerCase().trim();
    document.querySelectorAll('.card').forEach(card => {
      const text = card.textContent.toLowerCase();
      card.style.display = !query || text.includes(query) ? '' : 'none';
    });
  };

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
      a.click();
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
    navigator.clipboard.writeText(window.location.href).then(() => {
      const orig = shareBtn.innerHTML;
      shareBtn.innerHTML = '&#10003;'; // checkmark
      setTimeout(() => { shareBtn.innerHTML = orig; }, 2000);
    }).catch(() => showError('Link konnte nicht kopiert werden'));
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

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
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
    if (e.key === 'Escape') {
      closeModal();
      const actPanel = document.getElementById('activityPanel');
      if (actPanel && !actPanel.classList.contains('hidden')) actPanel.classList.add('hidden');
      const archPanel = document.getElementById('archivePanel');
      if (archPanel && !archPanel.classList.contains('hidden')) archPanel.classList.add('hidden');
    }
    if (e.key === '?' && !e.ctrlKey) {
      // Show shortcuts help
      alert('Tastaturkürzel:\n\nn - Neue Karte\nf - Suche\nEsc - Schließen\n? - Diese Hilfe');
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
  if (body && !(body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    opts.body = body;
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
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
        await api(`/api/columns/${col.id}/cards`, 'POST', { text: addInput.value.trim() });
        addInput.value = '';
        loadBoard();
      } catch (e) {
        showError(e.message);
      }
    }
  };
  addCard.appendChild(addInput);

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

  if (hasMeta) div.appendChild(meta);

  // Click to open modal
  div.onclick = (e) => {
    if (e.target.closest('.card-thumbnail')) return;
    openCardModal(card);
  };

  // Drag events
  div.addEventListener('dragstart', handleDragStart);
  div.addEventListener('dragend', handleDragEnd);

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
  document.getElementById('archiveCardBtn').onclick = async () => {
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
  };

  // Restore card
  const restoreBtn = document.getElementById('restoreCardBtn');
  if (restoreBtn) {
    restoreBtn.onclick = async () => {
      if (!currentCardId) return;
      try {
        await api(`/api/cards/${currentCardId}/restore`, 'PUT');
        closeModal();
        loadBoard();
      } catch (e) { showError(e.message); }
    };
  }

  // Delete card
  document.getElementById('deleteCardBtn').onclick = async () => {
    if (!currentCardId) return;
    if (!confirm('Karte löschen?')) return;
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
  };

  // Comments
  document.getElementById('addCommentBtn').onclick = addComment;
  document.getElementById('commentInput').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(); }
  };

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

  document.getElementById('moveCardBtn').onclick = async () => {
    if (!currentCardId) return;
    const select = document.getElementById('moveColumnSelect');
    const targetCol = Number(select.value);
    try {
      await api(`/api/cards/${currentCardId}/move`, 'PUT', { columnId: targetCol, position: 0 });
      closeModal();
      loadBoard();
    } catch (e) { showError(e.message); }
  };
}

function openCardModal(card) {
  currentCardId = card.id;
  document.getElementById('modalCardText').value = card.text;
  const descArea = document.getElementById('modalDescription');
  if (descArea) descArea.value = card.description || '';
  const dueDateInput = document.getElementById('modalDueDate');
  if (dueDateInput) {
    dueDateInput.value = card.due_date || '';
  }
  renderChecklist(card.checklist || []);
  renderAttachments(card.attachments || []);
  renderCardLabels(card.labels || []);
  renderComments(card.comments || []);
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
    const activities = await api(`/api/boards/${boardId}/activity`);
    const list = document.getElementById('activityList');
    list.innerHTML = '';

    const lastVisit = localStorage.getItem('lastVisit_' + boardId);
    localStorage.setItem('lastVisit_' + boardId, new Date().toISOString());
    document.getElementById('activityBadge').classList.add('hidden');

    if (activities.length === 0) {
      list.innerHTML = '<p style="color:#94a3b8;padding:20px;text-align:center;">Noch keine Aktivität.</p>';
    } else {
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
        actionDiv.innerHTML = actionText; // actionText is already escaped via esc()
        const timeDiv = document.createElement('div');
        timeDiv.className = 'activity-time';
        timeDiv.textContent = formatTime(act.created_at); // textContent, safe
        item.appendChild(actionDiv);
        item.appendChild(timeDiv);

        list.appendChild(item);
      }
    }

    panel.classList.remove('hidden');
  } catch (e) {
    showError(e.message);
  }
}

async function checkNewActivity() {
  const lastVisit = localStorage.getItem('lastVisit_' + boardId);
  if (!lastVisit) return;

  try {
    const activities = await api(`/api/boards/${boardId}/activity`);
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
  const actions = {
    board_created: () => `Board <strong>${esc(details.title)}</strong> erstellt`,
    column_created: () => `Spalte <strong>${esc(details.title)}</strong> hinzugefügt`,
    column_updated: () => `Spalte umbenannt zu <strong>${esc(details.title)}</strong>`,
    column_deleted: () => `Spalte <strong>${esc(details.title)}</strong> gelöscht`,
    card_created: () => `Karte <strong>${esc(details.text)}</strong> in ${esc(details.columnTitle)} erstellt`,
    card_updated: () => `Karte bearbeitet: <strong>${esc(details.text)}</strong>`,
    card_deleted: () => `Karte <strong>${esc(details.text)}</strong> gelöscht`,
    card_moved: () => `Karte <strong>${esc(details.text)}</strong> von ${esc(details.from)} nach ${esc(details.to)} verschoben`,
    file_uploaded: () => `Datei <strong>${esc(details.filename)}</strong> hochgeladen`,
    checklist_item_added: () => `Checklist-Item zu <strong>${esc(details.cardText)}</strong> hinzugefügt`,
    checklist_item_updated: () => `Checklist-Item in <strong>${esc(details.cardText)}</strong> aktualisiert`,
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

  for (const comment of comments) {
    const item = document.createElement('div');
    item.className = 'comment-item';

    const text = document.createElement('div');
    text.className = 'comment-text';
    text.textContent = comment.text;

    const footer = document.createElement('div');
    footer.className = 'comment-footer';

    const time = document.createElement('span');
    time.className = 'comment-time';
    time.textContent = formatTime(comment.created_at);

    const del = document.createElement('button');
    del.className = 'comment-delete';
    del.innerHTML = '&times;';
    del.onclick = async () => {
      try {
        await api(`/api/comments/${comment.id}`, 'DELETE');
        reloadComments();
      } catch (e) { showError(e.message); }
    };

    footer.appendChild(time);
    footer.appendChild(del);
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
        <h2>Zugriffs-Links</h2>
        <button class="icon-btn" onclick="document.getElementById('permissionsPanel').classList.add('hidden')" aria-label="Schließen">&times;</button>
      </div>
      <div id="accessLinksList" class="activity-list"></div>
      <div style="padding:12px 20px;border-top:1px solid #e2e8f0;">
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

  // Load links
  try {
    const links = await api(`/api/boards/${boardId}/access-links`);
    const list = document.getElementById('accessLinksList');
    list.innerHTML = '';

    if (links.length === 0) {
      list.innerHTML = '<p style="color:#94a3b8;padding:20px;text-align:center;">Keine Zugriffs-Links.</p>';
    } else {
      for (const link of links) {
        const item = document.createElement('div');
        item.style.cssText = 'padding:10px 0;border-bottom:1px solid #f1f5f9;';

        const url = window.location.origin + '/board/' + boardId + '?token=' + link.id;

        item.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <strong>${link.label || 'Link'}</strong>
              <span style="font-size:12px;padding:2px 6px;border-radius:4px;background:${link.permission === 'edit' ? '#dbeafe' : '#f1f5f9'};color:${link.permission === 'edit' ? '#2563eb' : '#64748b'};margin-left:4px;">${link.permission === 'edit' ? 'Bearbeiten' : 'Nur lesen'}</span>
            </div>
            <div style="display:flex;gap:4px;">
              <button class="icon-btn" title="Link kopieren" style="font-size:14px;padding:4px 8px;" onclick="navigator.clipboard.writeText('${url}')">&#128279;</button>
              <button class="icon-btn" title="Löschen" style="font-size:14px;padding:4px 8px;color:#dc2626;" data-link-id="${link.id}">&#128465;</button>
            </div>
          </div>
        `;

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

} // end boardId guard
