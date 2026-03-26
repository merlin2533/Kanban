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
`);

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

function getBoard(id) {
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(id);
  if (!board) return null;

  const columns = db.prepare('SELECT * FROM columns WHERE board_id = ? ORDER BY position').all(id);
  for (const col of columns) {
    col.cards = db.prepare('SELECT * FROM cards WHERE column_id = ? ORDER BY position').all(col.id);
    for (const card of col.cards) {
      card.checklist = db.prepare('SELECT * FROM checklist_items WHERE card_id = ? ORDER BY position').all(card.id);
      card.attachments = db.prepare('SELECT * FROM attachments WHERE card_id = ? ORDER BY created_at').all(card.id);
    }
  }
  board.columns = columns;
  return board;
}

// --- Columns ---

function createColumn(boardId, title) {
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

function deleteColumn(id) {
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(id);
  if (col) {
    db.prepare('DELETE FROM columns WHERE id = ?').run(id);
    logActivity(col.board_id, 'column_deleted', { title: col.title });
  }
  return col;
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

function updateCard(id, text) {
  db.prepare("UPDATE cards SET text = ?, updated_at = datetime('now') WHERE id = ?").run(text, id);
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (card) {
    const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(card.column_id);
    if (col) logActivity(col.board_id, 'card_updated', { cardId: id, text });
  }
  return card;
}

function deleteCard(id) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (card) {
    const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(card.column_id);
    db.prepare('DELETE FROM cards WHERE id = ?').run(id);
    if (col) logActivity(col.board_id, 'card_deleted', { text: card.text });
  }
  return card;
}

function moveCard(cardId, targetColumnId, targetPosition) {
  const move = db.transaction(() => {
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
    if (!card) return null;

    const sourceColumnId = card.column_id;

    // Remove from source: shift positions down
    db.prepare('UPDATE cards SET position = position - 1 WHERE column_id = ? AND position > ?').run(sourceColumnId, card.position);

    // Make space in target: shift positions up
    db.prepare('UPDATE cards SET position = position + 1 WHERE column_id = ? AND position >= ?').run(targetColumnId, targetPosition);

    // Move card
    db.prepare("UPDATE cards SET column_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?").run(targetColumnId, targetPosition, cardId);

    const srcCol = db.prepare('SELECT * FROM columns WHERE id = ?').get(sourceColumnId);
    const tgtCol = db.prepare('SELECT * FROM columns WHERE id = ?').get(targetColumnId);
    if (srcCol) {
      logActivity(srcCol.board_id, 'card_moved', {
        text: card.text,
        from: srcCol.title,
        to: tgtCol ? tgtCol.title : 'Unknown'
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

function updateChecklistItem(id, updates) {
  const item = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id);
  if (!item) return null;
  if (updates.text !== undefined) {
    db.prepare('UPDATE checklist_items SET text = ? WHERE id = ?').run(updates.text, id);
  }
  if (updates.checked !== undefined) {
    db.prepare('UPDATE checklist_items SET checked = ? WHERE id = ?').run(updates.checked ? 1 : 0, id);
  }
  const updated = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id);
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(item.card_id);
  if (card) {
    const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(card.column_id);
    if (col) logActivity(col.board_id, 'checklist_item_updated', { cardText: card.text, itemText: updated.text, checked: updated.checked });
  }
  return updated;
}

function deleteChecklistItem(id) {
  const item = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id);
  if (item) db.prepare('DELETE FROM checklist_items WHERE id = ?').run(id);
  return item;
}

// --- Attachments ---

function createAttachment(cardId, file) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) return null;
  const result = db.prepare('INSERT INTO attachments (card_id, filename, filepath, mimetype, size) VALUES (?, ?, ?, ?, ?)').run(
    cardId, file.originalname, file.path, file.mimetype, file.size
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

// --- Activity ---

function getActivity(boardId, limit = 50) {
  return db.prepare('SELECT * FROM activity_log WHERE board_id = ? ORDER BY created_at DESC LIMIT ?').all(boardId, limit);
}

module.exports = {
  createBoard, getBoard,
  createColumn, updateColumn, deleteColumn,
  createCard, updateCard, deleteCard, moveCard,
  getChecklist, createChecklistItem, updateChecklistItem, deleteChecklistItem,
  createAttachment, getAttachment, deleteAttachment,
  getActivity
};
