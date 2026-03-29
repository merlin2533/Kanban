// --- Card Page State ---
const pathParts = window.location.pathname.split('/');
// URL: /board/:boardId/card/:cardId
const boardId = pathParts[2];
const cardId = Number(pathParts[4]);

let board = null;
let card = null;
let currentUser = null;
let currentPermission = 'view';
let guestName = '';

// --- Auth helpers ---
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
function canEdit() {
  return currentPermission === 'admin' || currentPermission === 'edit';
}

function promptGuestName() {
  return new Promise((resolve) => {
    const stored = localStorage.getItem('kanban_guest_name');
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
        window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
        return false;
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

// --- Error toast ---
function showError(msg) {
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#dc2626;color:#fff;padding:12px 24px;border-radius:8px;z-index:9999;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.2);';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

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
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)"'<>]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n/g, '<br>');
}

// --- Load card data ---
async function loadCard() {
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
    } catch {}
  }
  if (!card) {
    document.querySelector('.card-page-main').innerHTML = '<p style="padding:40px;color:#94a3b8;font-size:18px;">Karte nicht gefunden.</p>';
    return;
  }
  renderCardPage();
}

// --- Render full card page ---
function renderCardPage() {
  document.title = card.text + ' – Kanban';
  document.getElementById('boardTitle').textContent = board.title || '';
  document.getElementById('backLink').href = `/board/${boardId}`;

  // Title
  const titleInput = document.getElementById('cardTitle');
  titleInput.value = card.text;

  // Description
  document.getElementById('cardDescription').value = card.description || '';

  // Due date
  document.getElementById('cardDueDate').value = card.due_date || '';

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
  renderChecklist(card.checklist || []);
  renderAttachments(card.attachments || []);
  renderComments(card.comments || []);
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

// --- Render comments (newest first) ---
function renderComments(comments) {
  const container = document.getElementById('commentsList');
  if (!container) return;
  container.innerHTML = '';

  if (comments.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'comments-empty';
    empty.textContent = 'Noch keine Kommentare.';
    container.appendChild(empty);
    return;
  }

  // API already returns newest first (ORDER BY created_at DESC)
  for (const comment of comments) {
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
    container.appendChild(item);
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
    const comments = await api(`/api/cards/${cardId}/comments`);
    renderComments(comments);
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

  function connect() {
    const params = [];
    if (window._accessToken) params.push('token=' + window._accessToken);
    const guest = getGuestName();
    if (guest && !currentUser) params.push('guest=' + encodeURIComponent(guest));
    const url = `/api/boards/${boardId}/events` + (params.length ? '?' + params.join('&') : '');
    es = new EventSource(url);

    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type !== 'update') return;
      // Reload if this card or the board changed
      if (!event.cardId || event.cardId === cardId || event.action === 'bulk_move' || event.action === 'bulk_archive') {
        loadCard();
      }
    };

    es.onerror = () => {
      es.close();
      setTimeout(() => { connect(); }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
    };
    es.onopen = () => { reconnectDelay = 2000; };
  }
  connect();
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
      window.location.href = `/board/${boardId}`;
    } catch (e) { showError(e.message); }
  });

  // Restore
  document.getElementById('restoreCardBtn').onclick = () => withLoading(document.getElementById('restoreCardBtn'), async () => {
    try {
      await api(`/api/cards/${cardId}/restore`, 'PUT');
      window.location.href = `/board/${boardId}`;
    } catch (e) { showError(e.message); }
  });

  // Delete
  document.getElementById('deleteCardBtn').onclick = () => withLoading(document.getElementById('deleteCardBtn'), async () => {
    if (!confirm('Karte wirklich löschen?')) return;
    try {
      await api(`/api/cards/${cardId}`, 'DELETE');
      window.location.href = `/board/${boardId}`;
    } catch (e) { showError(e.message); }
  });

  // Comments
  document.getElementById('addCommentBtn').onclick = addComment;
  document.getElementById('commentInput').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(); }
  };

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

  // Close label dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#labelPicker')) {
      labelDropdown.classList.add('hidden');
    }
  });
}

function showSuccess(msg) {
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#22c55e;color:#fff;padding:12px 24px;border-radius:8px;z-index:9999;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.2);';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
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
  });
}
