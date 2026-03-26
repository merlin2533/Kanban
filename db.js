const Database = require('better-sqlite3');
const path = require('path');
const { nanoid } = require('nanoid');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'kanban.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'Untitled Board',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS columns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    column_id INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    description TEXT DEFAULT '',
    position INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS checklist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    checked INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    mimetype TEXT,
    size INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#2563eb'
  );

  CREATE TABLE IF NOT EXISTS card_labels (
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, label_id)
  );

  CREATE INDEX IF NOT EXISTS idx_columns_board_id ON columns(board_id);
  CREATE INDEX IF NOT EXISTS idx_cards_column_id ON cards(column_id);
  CREATE INDEX IF NOT EXISTS idx_checklist_card_id ON checklist_items(card_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_card_id ON attachments(card_id);
  CREATE INDEX IF NOT EXISTS idx_activity_board_id ON activity_log(board_id);
  CREATE INDEX IF NOT EXISTS idx_labels_board_id ON labels(board_id);
  CREATE INDEX IF NOT EXISTS idx_card_labels_card_id ON card_labels(card_id);
  CREATE INDEX IF NOT EXISTS idx_card_labels_label_id ON card_labels(label_id);
`);

// Migration: add description column if missing
try {
  db.prepare("SELECT description FROM cards LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE cards ADD COLUMN description TEXT DEFAULT ''");
}

// --- Helpers ---

function logActivity(boardId, action, details) {
  db.prepare('INSERT INTO activity_log (board_id, action, details) VALUES (?, ?, ?)').run(
    boardId, action, JSON.stringify(details)
  );
}

// --- Boards ---

function createBoard(title) {
  const id = nanoid();
  const insert = db.transaction(() => {
    db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(id, title || 'Untitled Board');
    const defaults = ['To Do', 'In Progress', 'Done'];
    defaults.forEach((t, i) => {
      db.prepare('INSERT INTO columns (board_id, title, position) VALUES (?, ?, ?)').run(id, t, i);
    });
    logActivity(id, 'board_created', { title: title || 'Untitled Board' });
  });
  insert();
  return getBoard(id);
}

// Fix #7: Optimized getBoard — replaces N+1 nested loops with batch queries
function getBoard(id) {
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(id);
  if (!board) return null;

  const columns = db.prepare('SELECT * FROM columns WHERE board_id = ? ORDER BY position').all(id);
  if (columns.length === 0) {
    board.columns = [];
    return board;
  }

  const columnIds = columns.map(c => c.id);
  const placeholders = columnIds.map(() => '?').join(',');

  const allCards = db.prepare(
    `SELECT * FROM cards WHERE column_id IN (${placeholders}) ORDER BY position`
  ).all(...columnIds);

  const cardIds = allCards.map(c => c.id);

  let allChecklist = [];
  let allAttachments = [];
  let allCardLabels = [];

  if (cardIds.length > 0) {
    const cardPlaceholders = cardIds.map(() => '?').join(',');
    allChecklist = db.prepare(
      `SELECT * FROM checklist_items WHERE card_id IN (${cardPlaceholders}) ORDER BY position`
    ).all(...cardIds);
    allAttachments = db.prepare(
      `SELECT * FROM attachments WHERE card_id IN (${cardPlaceholders}) ORDER BY created_at`
    ).all(...cardIds);
    allCardLabels = db.prepare(
      `SELECT cl.card_id, l.* FROM card_labels cl JOIN labels l ON cl.label_id = l.id WHERE cl.card_id IN (${cardPlaceholders})`
    ).all(...cardIds);
  }

  // Build lookup maps
  const checklistByCard = new Map();
  for (const item of allChecklist) {
    if (!checklistByCard.has(item.card_id)) checklistByCard.set(item.card_id, []);
    checklistByCard.get(item.card_id).push(item);
  }

  const attachmentsByCard = new Map();
  for (const att of allAttachments) {
    if (!attachmentsByCard.has(att.card_id)) attachmentsByCard.set(att.card_id, []);
    attachmentsByCard.get(att.card_id).push(att);
  }

  const labelsByCard = new Map();
  for (const cl of allCardLabels) {
    if (!labelsByCard.has(cl.card_id)) labelsByCard.set(cl.card_id, []);
    labelsByCard.get(cl.card_id).push({ id: cl.id, name: cl.name, color: cl.color, board_id: cl.board_id });
  }

  const cardsByColumn = new Map();
  for (const card of allCards) {
    card.checklist = checklistByCard.get(card.id) || [];
    card.attachments = attachmentsByCard.get(card.id) || [];
    card.labels = labelsByCard.get(card.id) || [];
    if (!cardsByColumn.has(card.column_id)) cardsByColumn.set(card.column_id, []);
    cardsByColumn.get(card.column_id).push(card);
  }

  for (const col of columns) {
    col.cards = cardsByColumn.get(col.id) || [];
  }

  board.columns = columns;
  board.labels = db.prepare('SELECT * FROM labels WHERE board_id = ? ORDER BY name').all(id);
  return board;
}

// Fix #9: updateBoard, deleteBoard, getBoards
function updateBoard(id, title) {
  db.prepare('UPDATE boards SET title = ? WHERE id = ?').run(title, id);
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(id);
  if (board) logActivity(id, 'board_updated', { title });
  return board;
}

function deleteBoard(id) {
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(id);
  if (board) db.prepare('DELETE FROM boards WHERE id = ?').run(id);
  return board;
}

function getBoards() {
  return db.prepare('SELECT id, title, created_at FROM boards ORDER BY created_at DESC').all();
}

// --- Columns ---

// Fix #5: Verify boardId exists before creating column
function createColumn(boardId, title) {
  const board = db.prepare('SELECT id FROM boards WHERE id = ?').get(boardId);
  if (!board) return null;
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM columns WHERE board_id = ?').get(boardId).m;
  const result = db.prepare('INSERT INTO columns (board_id, title, position) VALUES (?, ?, ?)').run(boardId, title, maxPos + 1);
  logActivity(boardId, 'column_created', { title });
  return db.prepare('SELECT * FROM columns WHERE id = ?').get(result.lastInsertRowid);
}

function updateColumn(id, title) {
  db.prepare('UPDATE columns SET title = ? WHERE id = ?').run(title, id);
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(id);
  if (col) logActivity(col.board_id, 'column_updated', { columnId: id, title });
  return col;
}

// Fix #6: deleteColumn resequences sibling positions after delete
function deleteColumn(id) {
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(id);
  if (col) {
    db.prepare('DELETE FROM columns WHERE id = ?').run(id);
    db.prepare('UPDATE columns SET position = position - 1 WHERE board_id = ? AND position > ?').run(col.board_id, col.position);
    logActivity(col.board_id, 'column_deleted', { title: col.title });
  }
  return col;
}

// Fix #9: moveColumn — reorder a column within its board
function moveColumn(id, newPosition) {
  const move = db.transaction(() => {
    const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(id);
    if (!col) return null;

    const maxPos = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM columns WHERE board_id = ?').get(col.board_id).m;
    newPosition = Math.min(Math.max(0, parseInt(newPosition) || 0), maxPos);

    const oldPosition = col.position;
    if (oldPosition === newPosition) return col;

    if (oldPosition < newPosition) {
      // Moving right: shift columns between old+1 and newPosition left by 1
      db.prepare('UPDATE columns SET position = position - 1 WHERE board_id = ? AND position > ? AND position <= ?').run(col.board_id, oldPosition, newPosition);
    } else {
      // Moving left: shift columns between newPosition and old-1 right by 1
      db.prepare('UPDATE columns SET position = position + 1 WHERE board_id = ? AND position >= ? AND position < ?').run(col.board_id, newPosition, oldPosition);
    }

    db.prepare('UPDATE columns SET position = ? WHERE id = ?').run(newPosition, id);
    logActivity(col.board_id, 'column_moved', { columnId: id, from: oldPosition, to: newPosition });
    return db.prepare('SELECT * FROM columns WHERE id = ?').get(id);
  });
  return move();
}

// --- Cards ---

function createCard(columnId, text) {
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
  if (!col) return null;
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM cards WHERE column_id = ?').get(columnId).m;
  const result = db.prepare('INSERT INTO cards (column_id, text, position) VALUES (?, ?, ?)').run(columnId, text, maxPos + 1);
  logActivity(col.board_id, 'card_created', { text, columnTitle: col.title });
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(result.lastInsertRowid);
  card.checklist = [];
  card.attachments = [];
  return card;
}

function updateCard(id, updates) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!card) return null;

  const text = updates.text !== undefined ? updates.text : card.text;
  const description = updates.description !== undefined ? updates.description : card.description;

  db.prepare("UPDATE cards SET text = ?, description = ?, updated_at = datetime('now') WHERE id = ?").run(text, description, id);

  const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(updated.column_id);
  if (col) logActivity(col.board_id, 'card_updated', { cardId: id, text });
  return updated;
}

// Fix #6: deleteCard resequences sibling positions after delete
function deleteCard(id) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (card) {
    const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(card.column_id);
    db.prepare('DELETE FROM cards WHERE id = ?').run(id);
    db.prepare('UPDATE cards SET position = position - 1 WHERE column_id = ? AND position > ?').run(card.column_id, card.position);
    if (col) logActivity(col.board_id, 'card_deleted', { text: card.text });
  }
  return card;
}

// Fix #1: same-column moves use range-based updates
// Fix #2: clamp targetPosition to valid range
// Fix #3: validate targetColumnId exists
function moveCard(cardId, targetColumnId, targetPosition) {
  const move = db.transaction(() => {
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
    if (!card) return null;

    // Fix #3: verify target column exists
    const tgtCol = db.prepare('SELECT * FROM columns WHERE id = ?').get(targetColumnId);
    if (!tgtCol) return null;

    const sourceColumnId = card.column_id;

    // Fix #2: clamp targetPosition to valid range (0..card count in target column)
    const targetCount = db.prepare('SELECT COUNT(*) AS c FROM cards WHERE column_id = ?').get(targetColumnId).c;
    // When moving within the same column the card itself is counted, so max is targetCount - 1;
    // when moving across columns the card will be inserted so max is targetCount.
    const maxPos = (sourceColumnId === targetColumnId) ? targetCount - 1 : targetCount;
    targetPosition = Math.min(Math.max(0, parseInt(targetPosition) || 0), maxPos);

    if (sourceColumnId === targetColumnId) {
      // Fix #1: same-column move — use range-based position updates to avoid double-shifting
      const oldPosition = card.position;
      if (oldPosition === targetPosition) return card;

      if (oldPosition < targetPosition) {
        // Moving down: shift cards between old+1 and targetPosition up by -1
        db.prepare('UPDATE cards SET position = position - 1 WHERE column_id = ? AND position > ? AND position <= ?')
          .run(sourceColumnId, oldPosition, targetPosition);
      } else {
        // Moving up: shift cards between targetPosition and old-1 down by +1
        db.prepare('UPDATE cards SET position = position + 1 WHERE column_id = ? AND position >= ? AND position < ?')
          .run(sourceColumnId, targetPosition, oldPosition);
      }

      db.prepare("UPDATE cards SET position = ?, updated_at = datetime('now') WHERE id = ?").run(targetPosition, cardId);
    } else {
      // Cross-column move
      // Remove from source: shift positions down
      db.prepare('UPDATE cards SET position = position - 1 WHERE column_id = ? AND position > ?').run(sourceColumnId, card.position);

      // Make space in target: shift positions up
      db.prepare('UPDATE cards SET position = position + 1 WHERE column_id = ? AND position >= ?').run(targetColumnId, targetPosition);

      // Move card
      db.prepare("UPDATE cards SET column_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?").run(targetColumnId, targetPosition, cardId);
    }

    const srcCol = db.prepare('SELECT * FROM columns WHERE id = ?').get(sourceColumnId);
    if (srcCol) {
      logActivity(srcCol.board_id, 'card_moved', {
        text: card.text,
        from: srcCol.title,
        to: tgtCol.title
      });
    }
    return db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  });
  return move();
}

// --- Checklist ---

function getChecklist(cardId) {
  return db.prepare('SELECT * FROM checklist_items WHERE card_id = ? ORDER BY position').all(cardId);
}

function createChecklistItem(cardId, text) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) return null;
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM checklist_items WHERE card_id = ?').get(cardId).m;
  const result = db.prepare('INSERT INTO checklist_items (card_id, text, position) VALUES (?, ?, ?)').run(cardId, text, maxPos + 1);
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(card.column_id);
  if (col) logActivity(col.board_id, 'checklist_item_added', { cardText: card.text, itemText: text });
  return db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(result.lastInsertRowid);
}

// Fix #10: atomic single UPDATE combining text and checked changes
function updateChecklistItem(id, updates) {
  const item = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id);
  if (!item) return null;

  const newText    = updates.text    !== undefined ? updates.text              : item.text;
  const newChecked = updates.checked !== undefined ? (updates.checked ? 1 : 0) : item.checked;

  db.prepare('UPDATE checklist_items SET text = ?, checked = ? WHERE id = ?').run(newText, newChecked, id);

  const updated = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id);
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(item.card_id);
  if (card) {
    const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(card.column_id);
    if (col) logActivity(col.board_id, 'checklist_item_updated', { cardText: card.text, itemText: updated.text, checked: updated.checked });
  }
  return updated;
}

// Fix #6: deleteChecklistItem resequences sibling positions after delete
function deleteChecklistItem(id) {
  const item = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id);
  if (item) {
    db.prepare('DELETE FROM checklist_items WHERE id = ?').run(id);
    db.prepare('UPDATE checklist_items SET position = position - 1 WHERE card_id = ? AND position > ?').run(item.card_id, item.position);
  }
  return item;
}

// --- Attachments ---

// Fix #8: store file.filename (multer-generated name) instead of file.path
function createAttachment(cardId, file) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) return null;
  const result = db.prepare('INSERT INTO attachments (card_id, filename, filepath, mimetype, size) VALUES (?, ?, ?, ?, ?)').run(
    cardId, file.originalname, file.filename, file.mimetype, file.size
  );
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(card.column_id);
  if (col) logActivity(col.board_id, 'file_uploaded', { cardText: card.text, filename: file.originalname });
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(result.lastInsertRowid);
}

function getAttachment(id) {
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
}

function deleteAttachment(id) {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  if (att) db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  return att;
}

// --- Labels ---

function getLabels(boardId) {
  return db.prepare('SELECT * FROM labels WHERE board_id = ? ORDER BY name').all(boardId);
}

function createLabel(boardId, name, color) {
  const result = db.prepare('INSERT INTO labels (board_id, name, color) VALUES (?, ?, ?)').run(boardId, name, color || '#2563eb');
  return db.prepare('SELECT * FROM labels WHERE id = ?').get(result.lastInsertRowid);
}

function updateLabel(id, updates) {
  const label = db.prepare('SELECT * FROM labels WHERE id = ?').get(id);
  if (!label) return null;
  const name = updates.name !== undefined ? updates.name : label.name;
  const color = updates.color !== undefined ? updates.color : label.color;
  db.prepare('UPDATE labels SET name = ?, color = ? WHERE id = ?').run(name, color, id);
  return db.prepare('SELECT * FROM labels WHERE id = ?').get(id);
}

function deleteLabel(id) {
  const label = db.prepare('SELECT * FROM labels WHERE id = ?').get(id);
  if (label) db.prepare('DELETE FROM labels WHERE id = ?').run(id);
  return label;
}

function addLabelToCard(cardId, labelId) {
  try {
    db.prepare('INSERT OR IGNORE INTO card_labels (card_id, label_id) VALUES (?, ?)').run(cardId, labelId);
    return true;
  } catch { return false; }
}

function removeLabelFromCard(cardId, labelId) {
  db.prepare('DELETE FROM card_labels WHERE card_id = ? AND label_id = ?').run(cardId, labelId);
  return true;
}

function getCardLabels(cardId) {
  return db.prepare('SELECT l.* FROM labels l JOIN card_labels cl ON l.id = cl.id WHERE cl.card_id = ? ORDER BY l.name').all(cardId);
}

// --- Activity ---

// Fix #11: cap limit to max 500
function getActivity(boardId, limit = 50) {
  limit = Math.min(Math.max(1, parseInt(limit) || 50), 500);
  return db.prepare('SELECT * FROM activity_log WHERE board_id = ? ORDER BY created_at DESC LIMIT ?').all(boardId, limit);
}

module.exports = {
  createBoard, getBoard, updateBoard, deleteBoard, getBoards,
  createColumn, updateColumn, deleteColumn, moveColumn,
  createCard, updateCard, deleteCard, moveCard,
  getChecklist, createChecklistItem, updateChecklistItem, deleteChecklistItem,
  createAttachment, getAttachment, deleteAttachment,
  getLabels, createLabel, updateLabel, deleteLabel, addLabelToCard, removeLabelFromCard, getCardLabels,
  getActivity
};
