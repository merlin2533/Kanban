// --- Card Page State ---
const pathParts = window.location.pathname.split('/');
// URL: /board/:boardId/card/:cardId
const boardId = pathParts[2];
const cardId = Number(pathParts[4]);

// --- localStorage helpers (safe for Private Browsing / quota errors) ---
function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    if (e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')) {
      // Try to free space by removing stale entries, then retry once
      try {
        Object.keys(localStorage)
          .filter(k => /^(kanban_priority_filter_|kanban_due_filter_|col_collapsed_)/.test(k))
          .forEach(k => localStorage.removeItem(k));
        localStorage.setItem(key, value);
        return true;
      } catch { return false; }
    }
    return false;
  }
}
function lsRemove(key) {
  try { localStorage.removeItem(key); } catch { /* noop */ }
}

let board = null;
let card = null;
let currentUser = null;
let currentPermission = 'view';
let guestName = '';

// --- Auth helpers ---
function getGuestName() {
  return guestName || lsGet('kanban_guest_name') || '';
}
function setGuestName(name) {
  guestName = name;
  lsSet('kanban_guest_name', name);
}
function getCurrentUsername() {
  if (currentUser) return currentUser.username;
  return getGuestName();
}
function canEdit() {
  return currentPermission === 'admin' || currentPermission === 'edit' || currentPermission === 'cards_only';
}

function promptGuestName() {
  return new Promise((resolve) => {
    const stored = lsGet('kanban_guest_name');
    if (stored) { guestName = stored; resolve(stored); return; }
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
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  try {
    if (token) {
      const res = await fetch(`/api/auth/me?token=${token}`);
      if (res.ok) {
        const data = await res.json();
        currentUser = data.user;
        currentPermission = 'admin';
      } else {
        const boardRes = await fetch(`/api/boards/${boardId}?token=${token}`);
        if (boardRes.ok) {
          window._accessToken = token;
          currentPermission = 'edit';
          await promptGuestName();
        } else {
          window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
          return false;
        }
      }
    } else {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      if (data.authenticated) {
        currentUser = data.user;
        currentPermission = 'admin';
      } else {
        const pubRes = await fetch(`/api/boards/${boardId}/public-info`);
        if (pubRes.ok) {
          const pubData = await pubRes.json();
          if (pubData.public_access) {
            window._accessToken = pubData.token;
            currentPermission = pubData.public_access;
            await promptGuestName();
          } else {
            window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
            return false;
          }
        } else {
          window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
          return false;
        }
      }
    }
  } catch (err) {
    window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
    return false;
  }
  return true;
}

// --- API helper ---
async function api(url, method = 'GET', body = null) {
  if (window._accessToken) {
    const sep = url.includes('?') ? '&' : '?';
    url = url + sep + 'token=' + window._accessToken;
  }
  const opts = { method, headers: { 'X-Requested-With': 'kanban' } };
  const guest = getGuestName();
  if (guest && !currentUser) opts.headers['X-Guest-Name'] = guest;
  if (body && !(body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    opts.body = body;
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    if (res.status === 401) {
      window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
      return new Promise(() => {});
    }
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// --- Toast notifications ---
function showToast(msg, type = 'error', duration = 4000) {
  const colors = { error: '#dc2626', success: '#22c55e', info: '#2563eb' };
  const toast = document.createElement('div');
  toast.className = 'kanban-toast';
  toast.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:${colors[type] || colors.error};color:#fff;padding:12px 24px;border-radius:8px;z-index:9999;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.2);pointer-events:none;`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

function showError(msg) { showToast(msg, 'error'); }
function showSuccess(msg) { showToast(msg, 'success', 3000); }
function showInfo(msg) { showToast(msg, 'info', 3000); }

// --- Utility ---
function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${hash % 360}, 60%, 45%)`;
}

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
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

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\((\/uploads\/[^)]+)\)/g, '<img src="$2" alt="$1" class="md-image">')
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)"'<>]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n/g, '<br>');
}

// --- Image paste helpers ---
function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.value = textarea.value.substring(0, start) + text + textarea.value.substring(end);
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
}

async function handleImagePaste(e, textarea, afterUpload) {
  const items = Array.from(e.clipboardData ? e.clipboardData.items : []);
  const imageItem = items.find(item => item.type.startsWith('image/'));
  if (!imageItem) return;
  e.preventDefault();
  const file = imageItem.getAsFile();
  if (!file) return;
  const placeholder = '![Bild wird hochgeladen...]()';
  insertAtCursor(textarea, placeholder);
  try {
    const form = new FormData();
    form.append('file', file);
    const att = await api(`/api/cards/${cardId}/attachments`, 'POST', form);
    const md = `![${att.filename}](/uploads/${att.filepath})`;
    textarea.value = textarea.value.replace(placeholder, md);
    textarea.dispatchEvent(new Event('input'));
    if (afterUpload) await afterUpload();
  } catch (err) {
    textarea.value = textarea.value.replace(placeholder, '');
    showError('Bild-Upload fehlgeschlagen: ' + err.message);
  }
}

// --- Load card data ---
let cardLoading = false;
async function loadCard() {
  if (cardLoading) return;
  cardLoading = true;
  try {
  board = await api(`/api/boards/${boardId}`);
  // Find the card across all columns (and archived if needed)
  for (const col of board.columns) {
    for (const c of col.cards) {
      if (c.id === cardId) { card = c; break; }
    }
    if (card) break;
  }
  if (!card) {
    // Try archived cards
    try {
      const archived = await api(`/api/boards/${boardId}/archived`);
      card = archived.find(c => c.id === cardId) || null;
    } catch (e) { console.warn('[loadCard] Archiv konnte nicht geladen werden:', e.message); }
  }
  if (!card) {
    document.querySelector('.card-page-main').innerHTML = '<p style="padding:40px;color:#94a3b8;font-size:18px;">Karte nicht gefunden.</p>';
    return;
  }
  renderCardPage();
  } finally {
    cardLoading = false;
  }
}

// --- Render full card page ---
function renderCardPage() {
  document.title = card.text + ' – Kanban';
  document.getElementById('boardTitle').textContent = board.title || '';
  document.getElementById('backLink').href = `/board/${boardId}` + (window._accessToken ? `?token=${window._accessToken}` : '');

  // Title
  const titleInput = document.getElementById('cardTitle');
  titleInput.value = card.text;

  // Description
  document.getElementById('cardDescription').value = card.description || '';

  // Due date
  document.getElementById('cardDueDate').value = card.due_date || '';

  // Time tracking
  const timeEstimateEl = document.getElementById('timeEstimate');
  const timeLoggedDisplayEl = document.getElementById('timeLoggedDisplay');
  if (timeEstimateEl) timeEstimateEl.value = card.time_estimate != null ? card.time_estimate : '';
  if (timeLoggedDisplayEl) {
    const logged = card.time_logged || 0;
    timeLoggedDisplayEl.textContent = logged > 0 ? `${logged} Min (${Math.floor(logged/60)}h ${logged%60}m)` : '–';
  }

  // Priority
  document.querySelectorAll('.priority-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.priority === (card.priority || ''));
  });

  // Archived badge
  const badge = document.getElementById('archivedBadge');
  if (badge) badge.classList.toggle('hidden', !card.archived);

  // Archive/Restore buttons
  const archiveBtn = document.getElementById('archiveCardBtn');
  const restoreBtn = document.getElementById('restoreCardBtn');
  if (archiveBtn) archiveBtn.classList.toggle('hidden', !!card.archived);
  if (restoreBtn) restoreBtn.classList.toggle('hidden', !card.archived);

  renderAssignees(card.assignees || []);
  renderCardLabels(card.labels || []);
  loadDependencies();
  renderChecklist(card.checklist || []);
  renderAttachments(card.attachments || []);
  // Initial comment load with pagination
  loadComments(false).catch(e => showError(e.message));
  renderRecurrence();

  // Move: populate column select
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

  // Assignee select (admin only)
  const assignSelect = document.getElementById('assignUserSelect');
  if (assignSelect && currentUser && currentUser.is_admin) {
    api('/api/admin/users').then(users => {
      const assigned = new Set((card.assignees || []).map(a => a.id));
      assignSelect.innerHTML = '<option value="">+ Benutzer zuweisen...</option>';
      for (const u of users) {
        if (!assigned.has(u.id)) {
          const opt = document.createElement('option');
          opt.value = u.id;
          opt.textContent = u.username;
          assignSelect.appendChild(opt);
        }
      }
    }).catch(() => {});
  }
  if (assignSelect && !(currentUser && currentUser.is_admin)) {
    document.getElementById('assigneesSection').style.display = 'none';
  }

  // Hide edit controls if view-only
  if (!canEdit()) {
    document.getElementById('cardTitle').readOnly = true;
    document.getElementById('cardDescription').readOnly = true;
    document.getElementById('cardDueDate').disabled = true;
    document.querySelectorAll('.priority-btn').forEach(b => b.disabled = true);
    document.getElementById('addCommentBtn').style.display = 'none';
    document.getElementById('commentInput').style.display = 'none';
    document.querySelector('.comment-markdown-hint').style.display = 'none';
    document.getElementById('archiveCardBtn').style.display = 'none';
    document.getElementById('restoreCardBtn').style.display = 'none';
    document.getElementById('deleteCardBtn').style.display = 'none';
    document.getElementById('moveSection').style.display = 'none';
    document.getElementById('addChecklistBtn').style.display = 'none';
    document.getElementById('checklistInput').style.display = 'none';
    document.getElementById('uploadArea').style.display = 'none';
    document.getElementById('addLabelBtn').style.display = 'none';
    document.getElementById('assigneesSection').style.display = 'none';
    const timeLogRow = document.getElementById('timeLogRow');
    if (timeLogRow) timeLogRow.style.display = 'none';
    const timeEstimateEl2 = document.getElementById('timeEstimate');
    if (timeEstimateEl2) timeEstimateEl2.disabled = true;
  }

  // User badge in header
  const username = getCurrentUsername();
  if (username) {
    const actions = document.getElementById('headerActions');
    const existing = document.getElementById('userBadge');
    if (!existing) {
      const userBadge = document.createElement('div');
      userBadge.id = 'userBadge';
      userBadge.className = 'user-badge';
      userBadge.title = 'Angemeldet als ' + username;
      const dot = document.createElement('span');
      dot.className = 'user-badge-dot';
      dot.textContent = username.charAt(0).toUpperCase();
      dot.style.background = stringToColor(username);
      userBadge.appendChild(dot);
      const label = document.createElement('span');
      label.textContent = username;
      userBadge.appendChild(label);
      actions.appendChild(userBadge);
    }
  }
}

// --- Comments pagination state ---
let commentOffset = 0;
const COMMENT_PAGE_SIZE = 20;
let commentLoading = false;

// --- Render a single comment ---
function renderComment(comment) {
  const item = document.createElement('div');
  item.className = 'comment-item';

  if (comment.author) {
    const authorDiv = document.createElement('div');
    authorDiv.className = 'comment-author';
    const dot = document.createElement('span');
    dot.className = 'comment-author-dot';
    dot.textContent = comment.author.charAt(0).toUpperCase();
    dot.style.background = stringToColor(comment.author);
    authorDiv.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'comment-author-name';
    name.textContent = comment.author;
    authorDiv.appendChild(name);
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

  if (canEdit()) {
    const edit = document.createElement('button');
    edit.className = 'comment-edit';
    edit.innerHTML = '&#9998;';
    edit.title = 'Bearbeiten';
    edit.onclick = () => {
      const editArea = document.createElement('textarea');
      editArea.className = 'comment-edit-area';
      editArea.value = comment.text;
      editArea.rows = 3;
      text.replaceWith(editArea);
      editArea.addEventListener('paste', (e) => handleImagePaste(e, editArea));
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

  const del = document.createElement('button');
  del.className = 'comment-delete';
  del.innerHTML = '&times;';
  del.title = 'Löschen';
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
  return item;
}

// --- Load comments with pagination ---
async function loadComments(append = false) {
  if (commentLoading) return;
  commentLoading = true;
  if (!append) commentOffset = 0;
  try {
  const data = await api(`/api/cards/${cardId}/comments?limit=${COMMENT_PAGE_SIZE}&offset=${commentOffset}`);

  // Handle both old format (array) and new format (object with .comments)
  const comments = Array.isArray(data) ? data : data.comments;
  const total = Array.isArray(data) ? comments.length : data.total;

  const container = document.getElementById('commentsList');
  if (!container) return;

  if (!append) {
    container.innerHTML = '';
    // Remove any existing load-more button
    const existing = document.getElementById('loadMoreCommentsBtn');
    if (existing) existing.remove();
  }

  if (!append && comments.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'comments-empty';
    empty.textContent = 'Noch keine Kommentare.';
    container.appendChild(empty);
    commentOffset = 0;
    return;
  }

  for (const comment of comments) {
    container.appendChild(renderComment(comment));
  }

  commentOffset += comments.length;

  // Show/hide load more button
  let loadMoreBtn = document.getElementById('loadMoreCommentsBtn');
  const hasMore = commentOffset < total;

  if (hasMore) {
    if (!loadMoreBtn) {
      loadMoreBtn = document.createElement('button');
      loadMoreBtn.id = 'loadMoreCommentsBtn';
      loadMoreBtn.className = 'btn-secondary';
      loadMoreBtn.style.cssText = 'width:100%;margin-top:8px;';
      loadMoreBtn.textContent = 'Ältere Kommentare laden';
      loadMoreBtn.onclick = () => loadComments(true);
      container.after(loadMoreBtn);
    }
  } else if (loadMoreBtn) {
    loadMoreBtn.remove();
  }
  } catch (e) { showError(e.message); } finally { commentLoading = false; }
}

// --- Render comments (kept for initial load from card data) ---
function renderComments(comments) {
  const container = document.getElementById('commentsList');
  if (!container) return;
  container.innerHTML = '';
  // Remove stale load-more button
  const existing = document.getElementById('loadMoreCommentsBtn');
  if (existing) existing.remove();

  if (comments.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'comments-empty';
    empty.textContent = 'Noch keine Kommentare.';
    container.appendChild(empty);
    return;
  }

  for (const comment of comments) {
    container.appendChild(renderComment(comment));
  }
}

async function addComment() {
  const input = document.getElementById('commentInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await api(`/api/cards/${cardId}/comments`, 'POST', { text });
    reloadComments();
  } catch (e) {
    showError(e.message);
    input.value = text;
  }
}

async function reloadComments() {
  try {
    await loadComments(false);
  } catch (e) { showError(e.message); }
}

// --- Assignees ---
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
    const nameSpan = document.createElement('span');
    nameSpan.textContent = a.username;
    tag.appendChild(nameSpan);
    if (canEdit()) {
      const rm = document.createElement('button');
      rm.className = 'remove-label';
      rm.innerHTML = '&times;';
      rm.onclick = async () => {
        try {
          await api(`/api/cards/${cardId}/assignees/${a.id}`, 'DELETE');
          board = await api(`/api/boards/${boardId}`);
          card = findCard(cardId) || card;
          renderAssignees(card.assignees || []);
        } catch (e) { showError(e.message); }
      };
      tag.appendChild(rm);
    }
    container.appendChild(tag);
  }
}

// --- Card Dependencies ---
async function loadDependencies() {
  const deps = await api(`/api/cards/${cardId}/dependencies`);
  renderDependencies(deps);
}

function renderDependencies(deps) {
  if (!deps) deps = { blocking: [], blocked: [] };
  let section = document.getElementById('dependenciesSection');
  if (!section) {
    section = document.createElement('div');
    section.id = 'dependenciesSection';
    section.className = 'card-section';
    const assigneesSection = document.getElementById('assigneesSection') || document.querySelector('.assignees-section');
    if (assigneesSection) assigneesSection.after(section);
    else document.querySelector('.card-detail')?.appendChild(section);
  }

  section.innerHTML = `<div class="card-field-label">Abhängigkeiten</div>`;

  if (deps.blocking.length === 0 && !canEdit()) {
    const empty = document.createElement('p');
    empty.style.cssText = 'color:#94a3b8;font-size:13px;margin:4px 0;';
    empty.textContent = 'Keine Abhängigkeiten';
    section.appendChild(empty);
    return;
  }

  if (deps.blocking.length > 0) {
    const blockingDiv = document.createElement('div');
    blockingDiv.innerHTML = '<div style="font-size:12px;color:#64748b;margin:4px 0;">Blockiert von:</div>';
    for (const dep of deps.blocking) {
      const item = document.createElement('div');
      item.className = 'dep-item';
      item.innerHTML = `<span class="dep-card-text">${esc(dep.text)}</span><span class="dep-column">${esc(dep.column_title)}</span>`;
      if (canEdit()) {
        const rm = document.createElement('button');
        rm.className = 'remove-label';
        rm.textContent = '×';
        rm.onclick = async () => {
          await api(`/api/cards/${cardId}/dependencies/${dep.id}`, 'DELETE');
          loadDependencies();
        };
        item.appendChild(rm);
      }
      blockingDiv.appendChild(item);
    }
    section.appendChild(blockingDiv);
  }

  if (canEdit()) {
    const addDiv = document.createElement('div');
    addDiv.style.cssText = 'margin-top:8px;';
    addDiv.innerHTML = `
      <input type="number" id="depCardIdInput" placeholder="Karten-ID eingeben..." style="padding:4px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;width:160px;">
      <button id="addDepBtn" class="btn-secondary" style="margin-left:4px;">+ Blockiert von</button>
    `;
    section.appendChild(addDiv);
    document.getElementById('addDepBtn').onclick = async () => {
      const blockingId = parseInt(document.getElementById('depCardIdInput').value);
      if (isNaN(blockingId) || blockingId <= 0) return;
      if (blockingId === cardId) { showError('Karte kann nicht von sich selbst blockiert werden'); return; }
      try {
        await api(`/api/cards/${cardId}/dependencies`, 'POST', { blocking_card_id: blockingId });
        document.getElementById('depCardIdInput').value = '';
        loadDependencies();
      } catch (e) { showError(e.message); }
    };
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
    if (canEdit()) {
      const rm = document.createElement('button');
      rm.className = 'remove-label';
      rm.innerHTML = '&times;';
      rm.onclick = async () => {
        try {
          await api(`/api/cards/${cardId}/labels/${label.id}`, 'DELETE');
          reloadCardLabels();
        } catch (e) { showError(e.message); }
      };
      tag.appendChild(rm);
    }
    container.appendChild(tag);
  }
}

async function reloadCardLabels() {
  board = await api(`/api/boards/${boardId}`);
  card = findCard(cardId) || card;
  renderCardLabels(card.labels || []);
  renderLabelPicker();
}

function renderLabelPicker() {
  const list = document.getElementById('boardLabelsList');
  if (!list || !board) return;
  list.innerHTML = '';
  const cardLabelIds = new Set((card.labels || []).map(l => l.id));
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
          await api(`/api/cards/${cardId}/labels/${label.id}`, 'DELETE');
        } else {
          await api(`/api/cards/${cardId}/labels/${label.id}`, 'POST');
        }
        reloadCardLabels();
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
  if (!name) return;
  try {
    const label = await api(`/api/boards/${boardId}/labels`, 'POST', { name, color: colorInput.value });
    nameInput.value = '';
    if (!board.labels) board.labels = [];
    board.labels.push(label);
    renderLabelPicker();
  } catch (e) { showError(e.message); }
}

// --- Checklist ---
function renderChecklist(items) {
  const container = document.getElementById('checklistItems');
  container.innerHTML = '';
  const total = items.length;
  const done = items.filter(i => i.checked).length;
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
    cb.disabled = !canEdit();
    cb.onchange = async () => {
      try {
        await api(`/api/checklist/${item.id}`, 'PATCH', { checked: cb.checked });
        reloadChecklist();
      } catch (e) { showError(e.message); }
    };
    const textWrap = document.createElement('div');
    textWrap.className = 'checklist-text-wrap';

    const text = document.createElement('span');
    text.className = 'item-text' + (item.checked ? ' checked' : '');
    text.textContent = item.text;
    textWrap.appendChild(text);

    if (item.checked && item.checked_by) {
      const info = document.createElement('span');
      info.className = 'checklist-checked-info';
      const when = item.checked_at ? formatTime(item.checked_at) : '';
      info.textContent = `✓ ${item.checked_by}${when ? ' · ' + when : ''}`;
      textWrap.appendChild(info);
    }

    row.appendChild(cb);
    row.appendChild(textWrap);
    if (canEdit()) {
      const del = document.createElement('button');
      del.className = 'delete-item';
      del.innerHTML = '&times;';
      del.onclick = async () => {
        try {
          await api(`/api/checklist/${item.id}`, 'DELETE');
          reloadChecklist();
        } catch (e) { showError(e.message); }
      };
      row.appendChild(del);
    }
    container.appendChild(row);
  }
}

async function addChecklistItem() {
  const input = document.getElementById('checklistInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await api(`/api/cards/${cardId}/checklist`, 'POST', { text });
    reloadChecklist();
  } catch (e) { showError(e.message); input.value = text; }
}

async function reloadChecklist() {
  try {
    const items = await api(`/api/cards/${cardId}/checklist`);
    renderChecklist(items);
  } catch (e) { showError(e.message); }
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
      const ext = att.filename ? att.filename.split('.').pop().toLowerCase() : '';
      if (att.mimetype === 'text/csv' || ext === 'csv') {
        icon.textContent = '\uD83D\uDCCA'; // 📊
      } else if (att.mimetype === 'application/vnd.ms-excel' || att.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || ext === 'xls' || ext === 'xlsx') {
        icon.textContent = '\uD83D\uDCCA'; // 📊
      } else {
        icon.textContent = '\uD83D\uDCC4'; // 📄
      }
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
    item.appendChild(info);
    if (canEdit()) {
      const del = document.createElement('button');
      del.className = 'attachment-delete';
      del.innerHTML = '&times;';
      del.onclick = async () => {
        try {
          await api(`/api/attachments/${att.id}`, 'DELETE');
          reloadAttachments();
        } catch (e) { showError(e.message); }
      };
      item.appendChild(del);
    }
    container.appendChild(item);
  }
}

async function uploadFiles() {
  const files = document.getElementById('fileInput').files;
  await uploadFilesFromList(files);
}

async function uploadFilesFromList(files) {
  if (!files.length) return;
  try {
    for (const file of files) {
      const form = new FormData();
      form.append('file', file);
      await api(`/api/cards/${cardId}/attachments`, 'POST', form);
    }
    document.getElementById('fileInput').value = '';
    reloadAttachments();
  } catch (e) { showError(e.message); }
}

async function reloadAttachments() {
  try {
    board = await api(`/api/boards/${boardId}`);
    card = findCard(cardId) || card;
    renderAttachments(card.attachments || []);
  } catch (e) { showError(e.message); }
}

function findCard(id) {
  if (!board) return null;
  for (const col of board.columns) {
    for (const c of col.cards) {
      if (c.id === Number(id)) return c;
    }
  }
  return null;
}

// --- Loading helper ---
async function withLoading(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '...';
  try { await fn(); } finally { btn.disabled = false; btn.textContent = orig; }
}

// --- SSE real-time ---
function setupSSE() {
  let reconnectDelay = 2000;
  let es;
  let stopped = false;
  let reconnectTimer = null;

  function connect() {
    if (stopped) return;
    const params = [];
    if (window._accessToken) params.push('token=' + window._accessToken);
    const guest = getGuestName();
    if (guest && !currentUser) params.push('guest=' + encodeURIComponent(guest));
    const url = `/api/boards/${boardId}/events` + (params.length ? '?' + params.join('&') : '');
    es = new EventSource(url);

    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type !== 'update') return;
      // A new card being created doesn't affect the current card page
      if (event.action === 'card_created') return;
      // Reload if this card or the board changed
      if (!event.cardId || event.cardId === cardId || event.action === 'bulk_move' || event.action === 'bulk_archive') {
        loadCard();
      }
    };

    es.onerror = () => {
      if (stopped) return;
      es.close();
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => { connect(); }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
    };
    es.onopen = () => { reconnectDelay = 2000; };
    window._eventSource = es;
  }

  connect();

  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    if (es) { es.close(); es = null; }
  });
}

// --- Markdown preview for description ---
function setupDescriptionPreview() {
  const btn = document.getElementById('descPreviewBtn');
  const textarea = document.getElementById('cardDescription');
  const preview = document.getElementById('descPreview');
  if (!btn || !textarea || !preview) return;
  let previewMode = false;

  btn.onclick = () => {
    previewMode = !previewMode;
    if (previewMode) {
      preview.innerHTML = renderMarkdown(textarea.value) || '<em style="color:#94a3b8">Keine Beschreibung</em>';
      preview.classList.remove('hidden');
      textarea.classList.add('hidden');
      btn.textContent = 'Bearbeiten';
      btn.classList.add('active');
    } else {
      preview.classList.add('hidden');
      textarea.classList.remove('hidden');
      btn.textContent = 'Vorschau';
      btn.classList.remove('active');
    }
  };
}

// --- Duplicate card ---
async function duplicateCard() {
  const btn = document.getElementById('duplicateCardBtn');
  await withLoading(btn, async () => {
    try {
      const newCard = await api(`/api/cards/${cardId}/duplicate`, 'POST');
      const token = window._accessToken ? `?token=${window._accessToken}` : '';
      window.location.href = `/board/${boardId}/card/${newCard.id}${token}`;
    } catch (e) { showError(e.message); }
  });
}

// --- Activity log ---
let activityLoaded = false;

async function toggleActivity() {
  const list = document.getElementById('activityList');
  const icon = document.getElementById('activityToggleIcon');
  if (!list.classList.contains('hidden')) {
    list.classList.add('hidden');
    icon.textContent = '▼';
    return;
  }
  list.classList.remove('hidden');
  icon.textContent = '▲';
  if (activityLoaded) return;
  activityLoaded = true;
  list.innerHTML = '<p style="color:#94a3b8;font-size:13px;padding:8px 0;">Lade...</p>';
  try {
    const activities = await api(`/api/cards/${cardId}/activity`);
    renderActivity(activities, list);
  } catch (e) { list.innerHTML = '<p style="color:#ef4444;font-size:13px;">Fehler beim Laden.</p>'; }
}

function renderActivity(activities, container) {
  container.innerHTML = '';
  if (!activities.length) {
    container.innerHTML = '<p style="color:#94a3b8;font-size:13px;padding:8px 0;">Noch keine Aktivität.</p>';
    return;
  }
  for (const act of activities) {
    const item = document.createElement('div');
    item.className = 'card-activity-item';
    const details = JSON.parse(act.details || '{}');
    const user = details.user ? `<strong>${esc(details.user)}</strong> ` : '';
    const actionMap = {
      card_created: () => `${user}Karte erstellt`,
      card_updated: () => `${user}Karte bearbeitet`,
      card_archived: () => `${user}Karte archiviert`,
      card_restored: () => `${user}Karte wiederhergestellt`,
      card_moved: () => `${user}Karte verschoben`,
      comment_added: () => `${user}Kommentar: „${esc((details.commentText || '').slice(0, 60))}"`,
      checklist_item_added: () => `${user}Checklist-Item hinzugefügt: ${esc(details.itemText || '')}`,
      checklist_item_updated: () => `${user}Checklist-Item ${details.checked ? 'abgehakt' : 'abgehakt rückgängig'}: ${esc(details.itemText || '')}`,
      file_uploaded: () => `${user}Datei hochgeladen: ${esc(details.filename || '')}`,
    };
    const text = (actionMap[act.action] || (() => esc(act.action)))();
    item.innerHTML = `<span class="card-activity-text">${text}</span><span class="card-activity-time">${formatTime(act.created_at)}</span>`;
    container.appendChild(item);
  }
}

// --- Recurrence ---
function renderRecurrence() {
  const sel = document.getElementById('cardRecurrence');
  if (sel) sel.value = card.recurrence || '';
}

// --- Browser push notifications for due dates ---
function setupNotificationCheck() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'denied') return;

  // Check if this card is due today or overdue
  if (!card.due_date) return;
  const due = new Date(card.due_date);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());

  if (dueDay <= today) {
    const isOverdue = dueDay < today;
    const msg = isOverdue ? `Überfällig: ${card.text}` : `Heute fällig: ${card.text}`;

    const showIt = () => {
      new Notification('Kanban Erinnerung', {
        body: msg,
        icon: '/icons/icon-192.svg',
        tag: 'card-due-' + cardId,
      });
    };

    if (Notification.permission === 'granted') {
      showIt();
    } else {
      Notification.requestPermission().then(p => { if (p === 'granted') showIt(); });
    }
  }
}

// --- Setup event listeners ---
function setupEvents() {
  // Title save on blur
  const titleInput = document.getElementById('cardTitle');
  titleInput.onblur = async () => {
    const text = titleInput.value.trim();
    if (!text) { titleInput.value = card.text; return; }
    if (text === card.text) return;
    try {
      await api(`/api/cards/${cardId}`, 'PATCH', { text });
      card.text = text;
      document.title = text + ' – Kanban';
    } catch (e) { showError(e.message); titleInput.value = card.text; }
  };
  titleInput.onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };

  // Description save on blur
  const descArea = document.getElementById('cardDescription');
  descArea.onblur = async () => {
    const desc = descArea.value;
    if (desc === (card.description || '')) return;
    try {
      await api(`/api/cards/${cardId}`, 'PATCH', { description: desc });
      card.description = desc;
    } catch (e) { showError(e.message); }
  };

  // Image paste for description
  descArea.addEventListener('paste', (e) => handleImagePaste(e, descArea, async () => {
    await api(`/api/cards/${cardId}`, 'PATCH', { description: descArea.value });
    card.description = descArea.value;
  }));

  // Due date
  document.getElementById('cardDueDate').onchange = async (e) => {
    try {
      await api(`/api/cards/${cardId}`, 'PATCH', { due_date: e.target.value || null });
    } catch (e) { showError(e.message); }
  };

  // Priority
  document.querySelectorAll('.priority-btn').forEach(btn => {
    btn.onclick = async () => {
      const priority = btn.dataset.priority || null;
      try {
        await api(`/api/cards/${cardId}`, 'PATCH', { priority });
        document.querySelectorAll('.priority-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        card.priority = priority;
      } catch (e) { showError(e.message); }
    };
  });

  // Assignee select
  document.getElementById('assignUserSelect').onchange = async () => {
    const select = document.getElementById('assignUserSelect');
    const userId = Number(select.value);
    if (!userId) return;
    select.value = '';
    try {
      await api(`/api/cards/${cardId}/assignees/${userId}`, 'POST');
      board = await api(`/api/boards/${boardId}`);
      card = findCard(cardId) || card;
      renderAssignees(card.assignees || []);
    } catch (e) { showError(e.message); }
  };

  // Labels
  const addLabelBtn = document.getElementById('addLabelBtn');
  const labelDropdown = document.getElementById('labelDropdown');
  addLabelBtn.onclick = () => {
    labelDropdown.classList.toggle('hidden');
    if (!labelDropdown.classList.contains('hidden')) renderLabelPicker();
  };
  document.getElementById('createLabelBtn').onclick = createNewLabel;
  document.getElementById('newLabelName').onkeydown = (e) => { if (e.key === 'Enter') createNewLabel(); };

  // Checklist
  document.getElementById('addChecklistBtn').onclick = addChecklistItem;
  document.getElementById('checklistInput').onkeydown = (e) => { if (e.key === 'Enter') addChecklistItem(); };

  // File upload
  document.getElementById('uploadBtn').onclick = () => document.getElementById('fileInput').click();
  document.getElementById('fileInput').onchange = uploadFiles;
  const uploadArea = document.getElementById('uploadArea');
  uploadArea.ondragover = (e) => { e.preventDefault(); uploadArea.classList.add('drag-active'); };
  uploadArea.ondragleave = () => uploadArea.classList.remove('drag-active');
  uploadArea.ondrop = (e) => {
    e.preventDefault();
    uploadArea.classList.remove('drag-active');
    if (e.dataTransfer.files.length) uploadFilesFromList(e.dataTransfer.files);
  };

  // Move card
  document.getElementById('moveCardBtn').onclick = () => withLoading(document.getElementById('moveCardBtn'), async () => {
    const select = document.getElementById('moveColumnSelect');
    const targetCol = Number(select.value);
    try {
      await api(`/api/cards/${cardId}/move`, 'PUT', { columnId: targetCol, position: 0 });
      card.column_id = targetCol;
      showSuccess('Karte verschoben');
    } catch (e) { showError(e.message); }
  });

  // Archive
  document.getElementById('archiveCardBtn').onclick = () => withLoading(document.getElementById('archiveCardBtn'), async () => {
    try {
      await api(`/api/cards/${cardId}/archive`, 'PUT');
      window.location.href = `/board/${boardId}` + (window._accessToken ? `?token=${window._accessToken}` : '');
    } catch (e) { showError(e.message); }
  });

  // Restore
  document.getElementById('restoreCardBtn').onclick = () => withLoading(document.getElementById('restoreCardBtn'), async () => {
    try {
      await api(`/api/cards/${cardId}/restore`, 'PUT');
      window.location.href = `/board/${boardId}` + (window._accessToken ? `?token=${window._accessToken}` : '');
    } catch (e) { showError(e.message); }
  });

  // Delete
  document.getElementById('deleteCardBtn').onclick = () => withLoading(document.getElementById('deleteCardBtn'), async () => {
    if (!confirm('Karte wirklich löschen?')) return;
    try {
      await api(`/api/cards/${cardId}`, 'DELETE');
      window.location.href = `/board/${boardId}` + (window._accessToken ? `?token=${window._accessToken}` : '');
    } catch (e) { showError(e.message); }
  });

  // Comments
  document.getElementById('addCommentBtn').onclick = addComment;
  const commentInput = document.getElementById('commentInput');
  commentInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(); }
  };
  commentInput.addEventListener('paste', (e) => handleImagePaste(e, commentInput));

  // Duplicate
  document.getElementById('duplicateCardBtn').onclick = duplicateCard;

  // Activity toggle
  document.getElementById('activityToggle').onclick = toggleActivity;

  // Recurrence
  document.getElementById('cardRecurrence').onchange = async (e) => {
    try {
      await api(`/api/cards/${cardId}`, 'PATCH', { recurrence: e.target.value || null });
      card.recurrence = e.target.value || null;
    } catch (err) { showError(err.message); }
  };

  // Time estimate save on change
  const timeEstimateEl = document.getElementById('timeEstimate');
  if (timeEstimateEl) {
    timeEstimateEl.onchange = async () => {
      const val = timeEstimateEl.value === '' ? null : parseInt(timeEstimateEl.value);
      try { await api(`/api/cards/${cardId}`, 'PATCH', { time_estimate: val }); } catch (e) { showError(e.message); }
    };
  }

  // Time log button
  const timeLogBtn = document.getElementById('timeLogBtn');
  if (timeLogBtn) {
    timeLogBtn.onclick = async () => {
      const mins = parseInt(document.getElementById('timeLogInput').value);
      if (!mins || mins < 1) return;
      try {
        const updated = await api(`/api/cards/${cardId}/log-time`, 'POST', { minutes: mins });
        const timeLoggedDisplayEl = document.getElementById('timeLoggedDisplay');
        const logged = updated.time_logged || 0;
        if (timeLoggedDisplayEl) timeLoggedDisplayEl.textContent = `${logged} Min (${Math.floor(logged/60)}h ${logged%60}m)`;
      } catch (e) { showError(e.message); } finally {
        document.getElementById('timeLogInput').value = '';
      }
    };
  }

  // Close label dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#labelPicker')) {
      labelDropdown.classList.add('hidden');
    }
  });
}

// showSuccess is defined above via showToast

// --- Watch Card ---
let isWatching = false;

async function loadWatchStatus() {
  if (!currentUser) return;
  try {
    const data = await api(`/api/cards/${cardId}/watching`);
    isWatching = data.watching;
    updateWatchButton();
  } catch {}
}

function updateWatchButton() {
  const btn = document.getElementById('watchCardBtn');
  const icon = document.getElementById('watchIcon');
  if (!btn) return;
  if (!currentUser) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  if (isWatching) {
    icon.textContent = '\uD83D\uDD14'; // bell
    btn.title = 'Beobachtung beenden';
    btn.classList.add('watching');
  } else {
    icon.textContent = '\uD83D\uDC41'; // eye
    btn.title = 'Karte beobachten';
    btn.classList.remove('watching');
  }
}

async function toggleWatch() {
  if (!currentUser) return;
  try {
    if (isWatching) {
      await api(`/api/cards/${cardId}/watch`, 'DELETE');
      isWatching = false;
    } else {
      await api(`/api/cards/${cardId}/watch`, 'POST');
      isWatching = true;
      // Ensure push subscription is active when watching
      await ensurePushSubscription();
    }
    updateWatchButton();
  } catch (e) {
    showError(e.message);
  }
}

// --- Push Subscription ---
async function ensurePushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) return; // already subscribed
    const res = await fetch('/api/push/vapid-key');
    const { publicKey } = await res.json();
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await api('/api/push/subscribe', 'POST', sub.toJSON());
  } catch (err) {
    console.warn('Push subscription failed:', err);
  }
}

function urlBase64ToUint8Array(base64String) {
  var padding = '='.repeat((4 - base64String.length % 4) % 4);
  var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  var rawData = atob(base64);
  var outputArray = new Uint8Array(rawData.length);
  for (var i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// --- Init ---
if (!boardId || !cardId) {
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('main').innerHTML = '<p style="padding:40px;color:#94a3b8;">Ungültige URL.</p>';
  });
} else {
  document.addEventListener('DOMContentLoaded', async () => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    const authed = await checkAuth();
    if (!authed) return;
    setupEvents();
    setupDescriptionPreview();
    await loadCard();
    setupSSE();
    setupNotificationCheck();
    // Watch button
    loadWatchStatus();
    const watchBtn = document.getElementById('watchCardBtn');
    if (watchBtn) watchBtn.addEventListener('click', toggleWatch);
  });
}
