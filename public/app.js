// --- State ---
let boardId = window.location.pathname.split('/board/')[1];
let board = null;
let currentCardId = null;

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  loadBoard();
  setupActivityPanel();
  setupModal();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
  }
});

// --- API Helpers ---
async function api(url, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body && !(body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    opts.body = body;
  }
  const res = await fetch(url, opts);
  return res.json();
}

// --- Board ---
async function loadBoard() {
  board = await api(`/api/boards/${boardId}`);
  if (!board || board.error) {
    document.getElementById('board').innerHTML = '<p style="padding:40px;color:#94a3b8;font-size:18px;">Board nicht gefunden.</p>';
    return;
  }
  document.getElementById('boardTitle').textContent = board.title;
  document.title = board.title + ' - Kanban';
  renderBoard();
  checkNewActivity();
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';

  for (const col of board.columns) {
    boardEl.appendChild(createColumnEl(col));
  }

  // Add column button
  const addBtn = document.createElement('button');
  addBtn.className = 'add-column-btn';
  addBtn.textContent = '+ Spalte hinzufügen';
  addBtn.onclick = async () => {
    const title = prompt('Spaltenname:');
    if (!title) return;
    await api(`/api/boards/${boardId}/columns`, 'POST', { title });
    loadBoard();
  };
  boardEl.appendChild(addBtn);
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
    titleInput.readOnly = true;
    if (titleInput.value !== col.title) {
      await api(`/api/columns/${col.id}`, 'PATCH', { title: titleInput.value });
      col.title = titleInput.value;
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
    await api(`/api/columns/${col.id}`, 'DELETE');
    loadBoard();
  };

  header.appendChild(titleInput);
  header.appendChild(count);
  header.appendChild(deleteBtn);

  // Cards container
  const cardsContainer = document.createElement('div');
  cardsContainer.className = 'cards-container';
  cardsContainer.dataset.columnId = col.id;

  // Drag & drop on container
  cardsContainer.addEventListener('dragover', handleDragOver);
  cardsContainer.addEventListener('dragleave', handleDragLeave);
  cardsContainer.addEventListener('drop', handleDrop);

  for (const card of col.cards) {
    cardsContainer.appendChild(createCardEl(card));
  }

  // Add card input
  const addCard = document.createElement('div');
  addCard.className = 'add-card';
  const addInput = document.createElement('input');
  addInput.placeholder = '+ Karte hinzufügen...';
  addInput.onkeydown = async (e) => {
    if (e.key === 'Enter' && addInput.value.trim()) {
      await api(`/api/columns/${col.id}/cards`, 'POST', { text: addInput.value.trim() });
      addInput.value = '';
      loadBoard();
    }
  };
  addCard.appendChild(addInput);

  div.appendChild(header);
  div.appendChild(cardsContainer);
  div.appendChild(addCard);
  return div;
}

// --- Card ---
function createCardEl(card) {
  const div = document.createElement('div');
  div.className = 'card';
  div.draggable = true;
  div.dataset.cardId = card.id;
  div.dataset.columnId = card.column_id;
  div.dataset.position = card.position;

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
let draggedSourceColumnId = null;

function handleDragStart(e) {
  draggedCardId = this.dataset.cardId;
  draggedSourceColumnId = this.dataset.columnId;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
  this.classList.remove('dragging');
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
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

  if (!draggedCardId) return;

  const targetColumnId = this.dataset.columnId;
  const cards = [...this.querySelectorAll('.card:not(.dragging)')];
  const afterEl = getInsertionPoint(cards, e.clientY);

  let position;
  if (afterEl) {
    position = Number(afterEl.dataset.position);
  } else {
    position = cards.length;
  }

  await api(`/api/cards/${draggedCardId}/move`, 'PUT', {
    columnId: Number(targetColumnId),
    position
  });

  draggedCardId = null;
  draggedSourceColumnId = null;
  loadBoard();
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
      await api(`/api/cards/${currentCardId}`, 'PATCH', { text });
    }
  };
  document.getElementById('modalCardText').onkeydown = (e) => {
    if (e.key === 'Enter') e.target.blur();
  };

  // Delete card
  document.getElementById('deleteCardBtn').onclick = async () => {
    if (!currentCardId) return;
    if (!confirm('Karte löschen?')) return;
    await api(`/api/cards/${currentCardId}`, 'DELETE');
    closeModal();
    loadBoard();
  };

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
}

function openCardModal(card) {
  currentCardId = card.id;
  document.getElementById('modalCardText').value = card.text;
  renderChecklist(card.checklist || []);
  renderAttachments(card.attachments || []);
  document.getElementById('modalOverlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.add('hidden');
  currentCardId = null;
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
      await api(`/api/checklist/${item.id}`, 'PATCH', { checked: cb.checked });
      reloadModalChecklist();
    };

    const text = document.createElement('span');
    text.className = 'item-text' + (item.checked ? ' checked' : '');
    text.textContent = item.text;

    const del = document.createElement('button');
    del.className = 'delete-item';
    del.innerHTML = '&times;';
    del.onclick = async () => {
      await api(`/api/checklist/${item.id}`, 'DELETE');
      reloadModalChecklist();
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
  await api(`/api/cards/${currentCardId}/checklist`, 'POST', { text });
  input.value = '';
  reloadModalChecklist();
}

async function reloadModalChecklist() {
  if (!currentCardId) return;
  const items = await api(`/api/cards/${currentCardId}/checklist`);
  renderChecklist(items);
  loadBoard(); // refresh card indicators
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
      await api(`/api/attachments/${att.id}`, 'DELETE');
      reloadModalAttachments();
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
  for (const file of files) {
    const form = new FormData();
    form.append('file', file);
    await api(`/api/cards/${currentCardId}/attachments`, 'POST', form);
  }
  document.getElementById('fileInput').value = '';
  reloadModalAttachments();
}

async function reloadModalAttachments() {
  if (!currentCardId) return;
  // Re-fetch full board to get updated attachments
  board = await api(`/api/boards/${boardId}`);
  const card = findCard(currentCardId);
  if (card) renderAttachments(card.attachments || []);
  renderBoard();
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
}

async function toggleActivity() {
  const panel = document.getElementById('activityPanel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }

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

      item.innerHTML = `
        <div class="activity-action">${actionText}</div>
        <div class="activity-time">${formatTime(act.created_at)}</div>
      `;
      list.appendChild(item);
    }
  }

  panel.classList.remove('hidden');
}

async function checkNewActivity() {
  const lastVisit = localStorage.getItem('lastVisit_' + boardId);
  if (!lastVisit) return;

  const activities = await api(`/api/boards/${boardId}/activity`);
  const newCount = activities.filter(a => a.created_at > lastVisit).length;

  const badge = document.getElementById('activityBadge');
  if (newCount > 0) {
    badge.textContent = newCount;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
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
  return (actions[action] || (() => action))();
}

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(iso) {
  const d = new Date(iso + 'Z');
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'gerade eben';
  if (diff < 3600) return Math.floor(diff / 60) + ' Min.';
  if (diff < 86400) return Math.floor(diff / 3600) + ' Std.';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
