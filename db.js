const Database = require('better-sqlite3');
const path = require('path');
const { nanoid } = require('nanoid');
const crypto = require('crypto');

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

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_columns_board_id ON columns(board_id);
  CREATE INDEX IF NOT EXISTS idx_cards_column_id ON cards(column_id);
  CREATE INDEX IF NOT EXISTS idx_checklist_card_id ON checklist_items(card_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_card_id ON attachments(card_id);
  CREATE INDEX IF NOT EXISTS idx_activity_board_id ON activity_log(board_id);
  CREATE INDEX IF NOT EXISTS idx_labels_board_id ON labels(board_id);
  CREATE INDEX IF NOT EXISTS idx_card_labels_card_id ON card_labels(card_id);
  CREATE INDEX IF NOT EXISTS idx_card_labels_label_id ON card_labels(label_id);
  CREATE INDEX IF NOT EXISTS idx_comments_card_id ON comments(card_id);

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_changed_at TEXT DEFAULT (datetime('now')),
    is_admin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS board_access_links (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    permission TEXT NOT NULL DEFAULT 'view',
    label TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_board_access_board_id ON board_access_links(board_id);

  CREATE TABLE IF NOT EXISTS card_assignees (
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_card_assignees_card_id ON card_assignees(card_id);
  CREATE INDEX IF NOT EXISTS idx_card_assignees_user_id ON card_assignees(user_id);

  CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    events TEXT DEFAULT '*',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_webhooks_board_id ON webhooks(board_id);

  CREATE TABLE IF NOT EXISTS board_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    columns_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS board_members (
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'editor',
    PRIMARY KEY (board_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_board_members_user_id ON board_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_board_members_board_id ON board_members(board_id);
`);

// Migration: add description column if missing
try {
  db.prepare("SELECT description FROM cards LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE cards ADD COLUMN description TEXT DEFAULT ''");
}

// Migration: add due_date column if missing
try {
  db.prepare("SELECT due_date FROM cards LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE cards ADD COLUMN due_date TEXT DEFAULT NULL");
}

// Migration: add archived column if missing
try {
  db.prepare("SELECT archived FROM cards LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE cards ADD COLUMN archived INTEGER DEFAULT 0");
}

// Migration: add wip_limit column if missing
try {
  db.prepare("SELECT wip_limit FROM columns LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE columns ADD COLUMN wip_limit INTEGER DEFAULT 0");
}

// Migration: add priority column if missing
try {
  db.prepare("SELECT priority FROM cards LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE cards ADD COLUMN priority TEXT DEFAULT NULL");
}

const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
if (userCount === 0) {
  const adminPw = process.env.ADMIN_PASSWORD || 'admin';
  const adminSalt = crypto.randomBytes(16).toString('hex');
  const adminHash = crypto.scryptSync(adminPw, adminSalt, 64).toString('hex');
  db.prepare('INSERT INTO users (username, password_hash, password_salt, is_admin) VALUES (?, ?, ?, 1)').run(process.env.ADMIN_USER || 'admin', adminHash, adminSalt);
  console.log('Default admin created - PLEASE CHANGE PASSWORD!');
}

// --- Auth helpers ---

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
}

function createUser(username, password, isAdmin = false) {
  const { hash, salt } = hashPassword(password);
  const result = db.prepare('INSERT INTO users (username, password_hash, password_salt, is_admin) VALUES (?, ?, ?, ?)').run(username, hash, salt, isAdmin ? 1 : 0);
  return db.prepare('SELECT id, username, is_admin, password_changed_at, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
}

function authenticateUser(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash, user.password_salt)) return null;
  return { id: user.id, username: user.username, is_admin: user.is_admin, password_changed_at: user.password_changed_at };
}

function changePassword(userId, newPassword) {
  const { hash, salt } = hashPassword(newPassword);
  db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, password_changed_at = datetime('now') WHERE id = ?").run(hash, salt, userId);
}

function createSession(userId) {
  const id = nanoid();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expires);
  return { id, expires_at: expires };
}

function getSession(sessionId) {
  const session = db.prepare("SELECT s.*, u.username, u.is_admin, u.password_changed_at FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ? AND s.expires_at > datetime('now')").get(sessionId);
  return session || null;
}

function deleteSession(sessionId) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function cleanExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
}

// --- Board access links ---

function createBoardAccessLink(boardId, permission, label) {
  const id = nanoid();
  db.prepare('INSERT INTO board_access_links (id, board_id, permission, label) VALUES (?, ?, ?, ?)').run(id, boardId, permission || 'view', label || '');
  logActivity(boardId, 'access_link_created', { permission, label });
  return db.prepare('SELECT * FROM board_access_links WHERE id = ?').get(id);
}

function getBoardAccessLinks(boardId) {
  return db.prepare('SELECT * FROM board_access_links WHERE board_id = ? ORDER BY created_at').all(boardId);
}

function getBoardAccessLink(linkId) {
  return db.prepare('SELECT * FROM board_access_links WHERE id = ?').get(linkId);
}

function deleteBoardAccessLink(id) {
  const link = db.prepare('SELECT * FROM board_access_links WHERE id = ?').get(id);
  if (link) db.prepare('DELETE FROM board_access_links WHERE id = ?').run(id);
  return link;
}

function getAllBoards() {
  return db.prepare('SELECT id, title, created_at FROM boards ORDER BY created_at DESC').all();
}

function getUserBoards(userId) {
  const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
  if (user && user.is_admin) {
    // System admins see all boards
    return db.prepare('SELECT id, title, created_at FROM boards ORDER BY created_at DESC').all();
  }
  // Regular users see only boards they're a member of
  return db.prepare(`
    SELECT b.id, b.title, b.created_at FROM boards b
    JOIN board_members bm ON b.id = bm.board_id
    WHERE bm.user_id = ?
    ORDER BY b.created_at DESC
  `).all(userId);
}

function addBoardMember(boardId, userId, role) {
  db.prepare('INSERT OR REPLACE INTO board_members (board_id, user_id, role) VALUES (?, ?, ?)').run(boardId, userId, role || 'editor');
}

function removeBoardMember(boardId, userId) {
  db.prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?').run(boardId, userId);
}

function getBoardMembers(boardId) {
  return db.prepare(`
    SELECT u.id, u.username, u.is_admin as is_system_admin, bm.role
    FROM users u JOIN board_members bm ON u.id = bm.user_id
    WHERE bm.board_id = ?
    ORDER BY bm.role, u.username
  `).all(boardId);
}

function isUserBoardMember(boardId, userId) {
  return !!db.prepare('SELECT 1 FROM board_members WHERE board_id = ? AND user_id = ?').get(boardId, userId);
}

function getUsers() {
  return db.prepare('SELECT id, username, is_admin, password_changed_at, created_at FROM users').all();
}

function deleteUser(id) {
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
  if (user) db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return user;
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
    `SELECT * FROM cards WHERE column_id IN (${placeholders}) AND archived = 0 ORDER BY position`
  ).all(...columnIds);

  const cardIds = allCards.map(c => c.id);

  let allChecklist = [];
  let allAttachments = [];
  let allCardLabels = [];
  let allComments = [];
  let allAssignees = [];

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
    allComments = db.prepare(
      `SELECT * FROM comments WHERE card_id IN (${cardPlaceholders}) ORDER BY created_at ASC`
    ).all(...cardIds);
    allAssignees = db.prepare(
      `SELECT ca.card_id, u.id, u.username FROM card_assignees ca JOIN users u ON ca.user_id = u.id WHERE ca.card_id IN (${cardPlaceholders})`
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

  const commentsByCard = new Map();
  for (const c of allComments) {
    if (!commentsByCard.has(c.card_id)) commentsByCard.set(c.card_id, []);
    commentsByCard.get(c.card_id).push(c);
  }

  const assigneesByCard = new Map();
  for (const a of allAssignees) {
    if (!assigneesByCard.has(a.card_id)) assigneesByCard.set(a.card_id, []);
    assigneesByCard.get(a.card_id).push({ id: a.id, username: a.username });
  }

  const cardsByColumn = new Map();
  for (const card of allCards) {
    card.checklist = checklistByCard.get(card.id) || [];
    card.attachments = attachmentsByCard.get(card.id) || [];
    card.labels = labelsByCard.get(card.id) || [];
    card.comments = commentsByCard.get(card.id) || [];
    card.assignees = assigneesByCard.get(card.id) || [];
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

// Lightweight helper: get the board_id for a given column id (used by server.js for SSE broadcasts)
function getColumnBoardId(columnId) {
  const col = db.prepare('SELECT board_id FROM columns WHERE id = ?').get(columnId);
  return col ? col.board_id : null;
}

// Lightweight helper: get the board_id for a given card id (used by server.js for SSE broadcasts)
function getCardBoardId(cardId) {
  const row = db.prepare('SELECT columns.board_id FROM cards JOIN columns ON cards.column_id = columns.id WHERE cards.id = ?').get(cardId);
  return row ? row.board_id : null;
}

// Fix #5: Verify boardId exists before creating column
function createColumn(boardId, title) {
  const board = db.prepare('SELECT id FROM boards WHERE id = ?').get(boardId);
  if (!board) return null;
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM columns WHERE board_id = ?').get(boardId).m;
  const result = db.prepare('INSERT INTO columns (board_id, title, position) VALUES (?, ?, ?)').run(boardId, title, maxPos + 1);
  logActivity(boardId, 'column_created', { title });
  return db.prepare('SELECT * FROM columns WHERE id = ?').get(result.lastInsertRowid);
}

function updateColumn(id, updates) {
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(id);
  if (!col) return null;
  const title = updates.title !== undefined ? updates.title : col.title;
  const wip_limit = updates.wip_limit !== undefined ? updates.wip_limit : col.wip_limit;
  db.prepare('UPDATE columns SET title = ?, wip_limit = ? WHERE id = ?').run(title, wip_limit, id);
  const updated = db.prepare('SELECT * FROM columns WHERE id = ?').get(id);
  logActivity(col.board_id, 'column_updated', { columnId: id, title });
  return updated;
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
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM cards WHERE column_id = ? AND archived = 0').get(columnId).m;
  const result = db.prepare('INSERT INTO cards (column_id, text, position) VALUES (?, ?, ?)').run(columnId, text, maxPos + 1);
  logActivity(col.board_id, 'card_created', { text, columnTitle: col.title });
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(result.lastInsertRowid);
  card.checklist = [];
  card.attachments = [];
  card.comments = [];
  return card;
}

function updateCard(id, updates) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!card) return null;

  const text = updates.text !== undefined ? updates.text : card.text;
  const description = updates.description !== undefined ? updates.description : card.description;
  const due_date = updates.due_date !== undefined ? updates.due_date : card.due_date;
  const priority = updates.priority !== undefined ? updates.priority : card.priority;

  db.prepare("UPDATE cards SET text = ?, description = ?, due_date = ?, priority = ?, updated_at = datetime('now') WHERE id = ?").run(text, description, due_date, priority, id);

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

    // Fix #3: verify target column exists and is on the same board
    const tgtCol = db.prepare('SELECT * FROM columns WHERE id = ?').get(targetColumnId);
    if (!tgtCol) return null;
    const srcCol = db.prepare('SELECT board_id FROM columns WHERE id = ?').get(card.column_id);
    if (!srcCol || srcCol.board_id !== tgtCol.board_id) return null;

    const sourceColumnId = card.column_id;

    // Fix #2: clamp targetPosition to valid range (0..card count in target column)
    const targetCount = db.prepare('SELECT COUNT(*) AS c FROM cards WHERE column_id = ? AND archived = 0').get(targetColumnId).c;
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

    const sourceTitle = db.prepare('SELECT title FROM columns WHERE id = ?').get(sourceColumnId)?.title || '';
    logActivity(tgtCol.board_id, 'card_moved', {
      text: card.text,
      from: sourceTitle,
      to: tgtCol.title
    });
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

function getCardAttachmentPaths(cardId) {
  return db.prepare('SELECT filepath FROM attachments WHERE card_id = ?').all(cardId).map(a => a.filepath);
}

function getBoardAttachmentPaths(boardId) {
  return db.prepare(`
    SELECT a.filepath FROM attachments a
    JOIN cards c ON a.card_id = c.id
    JOIN columns col ON c.column_id = col.id
    WHERE col.board_id = ?
  `).all(boardId).map(a => a.filepath);
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
  const board = db.prepare('SELECT id FROM boards WHERE id = ?').get(boardId);
  if (!board) return null;
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
  return db.prepare('SELECT l.* FROM labels l JOIN card_labels cl ON l.id = cl.label_id WHERE cl.card_id = ? ORDER BY l.name').all(cardId);
}

// --- Card Assignees ---

function assignCard(cardId, userId) {
  db.prepare('INSERT OR IGNORE INTO card_assignees (card_id, user_id) VALUES (?, ?)').run(cardId, userId);
  return true;
}

function unassignCard(cardId, userId) {
  db.prepare('DELETE FROM card_assignees WHERE card_id = ? AND user_id = ?').run(cardId, userId);
  return true;
}

function getCardAssignees(cardId) {
  return db.prepare('SELECT u.id, u.username FROM users u JOIN card_assignees ca ON u.id = ca.user_id WHERE ca.card_id = ?').all(cardId);
}

// --- Archive ---

function archiveCard(id) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!card) return null;
  db.prepare("UPDATE cards SET archived = 1, updated_at = datetime('now') WHERE id = ?").run(id);
  // Resequence sibling positions
  db.prepare('UPDATE cards SET position = position - 1 WHERE column_id = ? AND position > ? AND archived = 0').run(card.column_id, card.position);
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(card.column_id);
  if (col) logActivity(col.board_id, 'card_archived', { text: card.text });
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
}

function restoreCard(id) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!card) return null;
  // Restore to end of column
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM cards WHERE column_id = ? AND archived = 0').get(card.column_id).m;
  db.prepare("UPDATE cards SET archived = 0, position = ?, updated_at = datetime('now') WHERE id = ?").run(maxPos + 1, id);
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(card.column_id);
  if (col) logActivity(col.board_id, 'card_restored', { text: card.text });
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
}

function getArchivedCards(boardId) {
  return db.prepare(`
    SELECT cards.* FROM cards
    JOIN columns ON cards.column_id = columns.id
    WHERE columns.board_id = ? AND cards.archived = 1
    ORDER BY cards.updated_at DESC
  `).all(boardId);
}

// --- Comments ---

function getComments(cardId) {
  return db.prepare('SELECT * FROM comments WHERE card_id = ? ORDER BY created_at ASC').all(cardId);
}

function createComment(cardId, text) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) return null;
  const result = db.prepare('INSERT INTO comments (card_id, text) VALUES (?, ?)').run(cardId, text);
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(card.column_id);
  if (col) logActivity(col.board_id, 'comment_added', { cardText: card.text, commentText: text.slice(0, 50) });
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(result.lastInsertRowid);
}

function deleteComment(id) {
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  if (comment) db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  return comment;
}

// --- Activity ---

// Fix #11: cap limit to max 500
function getActivity(boardId, limit = 50) {
  limit = Math.min(Math.max(1, parseInt(limit) || 50), 500);
  return db.prepare('SELECT * FROM activity_log WHERE board_id = ? ORDER BY created_at DESC LIMIT ?').all(boardId, limit);
}

// --- Export/Import ---

function exportBoard(id) {
  const board = getBoard(id);
  if (!board) return null;
  board.labels = db.prepare('SELECT * FROM labels WHERE board_id = ? ORDER BY name').all(id);
  const archivedCards = getArchivedCards(id);
  board.archivedCards = archivedCards;
  return board;
}

function importBoard(data) {
  const id = nanoid();
  const imp = db.transaction(() => {
    db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(id, data.title || 'Imported Board');

    // Import labels
    const labelMap = new Map();
    for (const label of (data.labels || [])) {
      const result = db.prepare('INSERT INTO labels (board_id, name, color) VALUES (?, ?, ?)').run(id, label.name, label.color || '#2563eb');
      labelMap.set(label.id, result.lastInsertRowid);
    }

    // Import columns
    for (const col of (data.columns || [])) {
      const colResult = db.prepare('INSERT INTO columns (board_id, title, position) VALUES (?, ?, ?)').run(id, col.title, col.position);
      const newColId = colResult.lastInsertRowid;

      for (const card of (col.cards || [])) {
        const cardResult = db.prepare('INSERT INTO cards (column_id, text, description, position, due_date) VALUES (?, ?, ?, ?, ?)').run(
          newColId, card.text, card.description || '', card.position, card.due_date || null
        );
        const newCardId = cardResult.lastInsertRowid;

        // Checklist items
        for (const item of (card.checklist || [])) {
          db.prepare('INSERT INTO checklist_items (card_id, text, checked, position) VALUES (?, ?, ?, ?)').run(newCardId, item.text, item.checked ? 1 : 0, item.position);
        }

        // Card labels
        for (const label of (card.labels || [])) {
          const newLabelId = labelMap.get(label.id);
          if (newLabelId) {
            db.prepare('INSERT OR IGNORE INTO card_labels (card_id, label_id) VALUES (?, ?)').run(newCardId, newLabelId);
          }
        }

        // Comments
        for (const comment of (card.comments || [])) {
          db.prepare('INSERT INTO comments (card_id, text) VALUES (?, ?)').run(newCardId, comment.text);
        }
      }
    }

    logActivity(id, 'board_imported', { title: data.title });
  });
  imp();
  return getBoard(id);
}

// --- Webhooks ---

function createWebhook(boardId, url, events) {
  const result = db.prepare('INSERT INTO webhooks (board_id, url, events) VALUES (?, ?, ?)').run(boardId, url, events || '*');
  return db.prepare('SELECT * FROM webhooks WHERE id = ?').get(result.lastInsertRowid);
}

function getWebhooks(boardId) {
  return db.prepare('SELECT * FROM webhooks WHERE board_id = ? ORDER BY created_at').all(boardId);
}

function deleteWebhook(id) {
  const wh = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
  if (wh) db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  return wh;
}

function getActiveWebhooks(boardId) {
  return db.prepare('SELECT * FROM webhooks WHERE board_id = ? AND active = 1').all(boardId);
}

// --- Board Templates ---

function createTemplate(name, columnsJson) {
  const result = db.prepare('INSERT INTO board_templates (name, columns_json) VALUES (?, ?)').run(name, columnsJson);
  return db.prepare('SELECT * FROM board_templates WHERE id = ?').get(result.lastInsertRowid);
}

function getTemplates() {
  return db.prepare('SELECT * FROM board_templates ORDER BY name').all();
}

function deleteTemplate(id) {
  const t = db.prepare('SELECT * FROM board_templates WHERE id = ?').get(id);
  if (t) db.prepare('DELETE FROM board_templates WHERE id = ?').run(id);
  return t;
}

function createBoardFromTemplate(templateId, title) {
  const template = db.prepare('SELECT * FROM board_templates WHERE id = ?').get(templateId);
  if (!template) return null;
  const columns = JSON.parse(template.columns_json);
  const id = nanoid();
  const create = db.transaction(() => {
    db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(id, title || template.name);
    columns.forEach((col, i) => {
      db.prepare('INSERT INTO columns (board_id, title, position, wip_limit) VALUES (?, ?, ?, ?)').run(id, col.title, i, col.wip_limit || 0);
    });
    logActivity(id, 'board_created', { title: title || template.name, template: template.name });
  });
  create();
  return getBoard(id);
}

function saveBoardAsTemplate(boardId, name) {
  const board = getBoard(boardId);
  if (!board) return null;
  const columns = board.columns.map(c => ({ title: c.title, wip_limit: c.wip_limit || 0 }));
  return createTemplate(name, JSON.stringify(columns));
}

// --- Raw DB access ---

function getDb() { return db; }

module.exports = {
  // Boards
  createBoard, getBoard, updateBoard, deleteBoard, getBoards,
  // Columns
  createColumn, updateColumn, deleteColumn, moveColumn,
  getColumnBoardId, getCardBoardId,
  // Cards
  createCard, updateCard, deleteCard, moveCard,
  // Checklist
  getChecklist, createChecklistItem, updateChecklistItem, deleteChecklistItem,
  // Attachments
  createAttachment, getAttachment, deleteAttachment, getCardAttachmentPaths, getBoardAttachmentPaths,
  // Labels
  getLabels, createLabel, updateLabel, deleteLabel, addLabelToCard, removeLabelFromCard, getCardLabels,
  // Card Assignees
  assignCard, unassignCard, getCardAssignees,
  // Activity
  getActivity,
  // Archive
  archiveCard, restoreCard, getArchivedCards,
  // Comments
  getComments, createComment, deleteComment,
  // Export/Import
  exportBoard, importBoard,
  // Auth
  hashPassword, verifyPassword, createUser, authenticateUser, changePassword,
  createSession, getSession, deleteSession, cleanExpiredSessions,
  // Board access links
  createBoardAccessLink, getBoardAccessLinks, getBoardAccessLink, deleteBoardAccessLink,
  // User management
  getAllBoards, getUsers, deleteUser,
  // Webhooks
  createWebhook, getWebhooks, deleteWebhook, getActiveWebhooks,
  // Board Templates
  createTemplate, getTemplates, deleteTemplate, createBoardFromTemplate, saveBoardAsTemplate,
  // Raw DB
  getDb,
};
