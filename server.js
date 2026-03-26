const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// --- Middleware ---
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// --- Multer for file uploads ---
const ALLOWED_MIME = new Set(['image/jpeg','image/png','image/gif','image/webp','application/pdf','text/plain']);
const ALLOWED_EXT = new Set(['.jpg','.jpeg','.png','.gif','.webp','.pdf','.txt']);

const storage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads'),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_MIME.has(file.mimetype) && ALLOWED_EXT.has(ext)) {
      cb(null, true);
    } else {
      const err = new Error('File type not allowed');
      err.status = 400;
      cb(err, false);
    }
  }
});

// Multer upload middleware with inline error handling
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File exceeds 10 MB limit' });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  });
}

// --- Input validation helpers ---
function validId(val) {
  const n = Number(val);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function validString(val, max) {
  if (typeof val !== 'string') return null;
  const t = val.trim();
  if (t.length === 0 || t.length > max) return null;
  return t;
}

// --- Cookie parsing ---
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  header.split(';').forEach(c => {
    const [key, ...val] = c.trim().split('=');
    if (key) cookies[key.trim()] = decodeURIComponent(val.join('='));
  });
  return cookies;
}

// --- Auth middleware ---
function authMiddleware(req, res, next) {
  const accessToken = req.query.token;
  if (accessToken) {
    const link = db.getBoardAccessLink(accessToken);
    if (link) {
      req.accessLink = link;
      req.permission = link.permission;
      return next();
    }
  }
  const cookies = parseCookies(req);
  const sessionId = cookies.kanban_session;
  if (sessionId) {
    const session = db.getSession(sessionId);
    if (session) {
      req.user = { id: session.user_id, username: session.username, is_admin: session.is_admin, password_changed_at: session.password_changed_at };
      req.permission = 'admin';
      return next();
    }
  }
  return res.status(401).json({ error: 'Authentication required' });
}

function requireEdit(req, res, next) {
  if (req.permission === 'admin' || req.permission === 'edit') return next();
  return res.status(403).json({ error: 'Edit permission required' });
}

// --- Auth Routes ---
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.authenticateUser(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const session = db.createSession(user.id);
  res.setHeader('Set-Cookie', `kanban_session=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*60*60}`);
  const pwAge = user.password_changed_at ? (Date.now() - new Date(user.password_changed_at + 'Z').getTime()) / 86400000 : 999;
  res.json({ user: { id: user.id, username: user.username, is_admin: user.is_admin }, passwordReminder: pwAge >= 14 });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.kanban_session) db.deleteSession(cookies.kanban_session);
  res.setHeader('Set-Cookie', 'kanban_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const cookies = parseCookies(req);
  const sessionId = cookies.kanban_session;
  if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });
  const session = db.getSession(sessionId);
  if (!session) return res.status(401).json({ error: 'Session expired' });
  const pwAge = session.password_changed_at ? (Date.now() - new Date(session.password_changed_at + 'Z').getTime()) / 86400000 : 999;
  res.json({ user: { id: session.user_id, username: session.username, is_admin: session.is_admin }, passwordReminder: pwAge >= 14 });
});

app.post('/api/auth/change-password', authMiddleware, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
  const user = db.authenticateUser(req.user.username, currentPassword);
  if (!user) return res.status(401).json({ error: 'Current password incorrect' });
  db.changePassword(req.user.id, newPassword);
  res.json({ ok: true });
});

// --- Admin ---
app.get('/api/admin/users', authMiddleware, (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin required' });
  res.json(db.getUsers());
});

app.post('/api/admin/users', authMiddleware, (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin required' });
  const username = validString(req.body.username, 100);
  if (!username) return res.status(400).json({ error: 'username required' });
  if (!req.body.password || req.body.password.length < 6) return res.status(400).json({ error: 'password min 6 chars' });
  try {
    const user = db.createUser(username, req.body.password, !!req.body.is_admin);
    res.status(201).json(user);
  } catch { res.status(409).json({ error: 'Username already exists' }); }
});

app.delete('/api/admin/users/:id', authMiddleware, (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin required' });
  const id = validId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  if (req.user.id === id) return res.status(400).json({ error: 'Cannot delete yourself' });
  const user = db.deleteUser(id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// --- Board Access Links ---
app.get('/api/boards/:boardId/access-links', authMiddleware, (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin required' });
  res.json(db.getBoardAccessLinks(req.params.boardId));
});

app.post('/api/boards/:boardId/access-links', authMiddleware, (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin required' });
  const permission = req.body.permission === 'edit' ? 'edit' : 'view';
  const label = validString(req.body.label, 200) || '';
  const link = db.createBoardAccessLink(req.params.boardId, permission, label);
  res.status(201).json(link);
});

app.delete('/api/access-links/:id', authMiddleware, (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin required' });
  const link = db.deleteBoardAccessLink(req.params.id);
  if (!link) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});


// --- Cookie parsing ---
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  header.split(';').forEach(c => {
    const [key, ...val] = c.trim().split('=');
    cookies[key] = decodeURIComponent(val.join('='));
  });
  return cookies;
}

// --- Auth middleware ---
function authMiddleware(req, res, next) {
  // Check for access link token in query
  const accessToken = req.query.token;
  if (accessToken) {
    const link = db.getBoardAccessLink(accessToken);
    if (link) {
      req.accessLink = link;
      req.permission = link.permission;
      return next();
    }
  }

  // Check session cookie
  const cookies = parseCookies(req);
  const sessionId = cookies.kanban_session;
  if (sessionId) {
    const session = db.getSession(sessionId);
    if (session) {
      req.user = { id: session.user_id, username: session.username, is_admin: session.is_admin, password_changed_at: session.password_changed_at };
      req.permission = 'admin';
      return next();
    }
  }

  return res.status(401).json({ error: 'Authentication required' });
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireEdit(req, res, next) {
  if (req.permission === 'admin' || req.permission === 'edit') {
    return next();
  }
  return res.status(403).json({ error: 'Edit permission required' });
}

// --- SSE ---
const sseClients = new Map(); // boardId -> Set of response objects

app.get('/api/boards/:boardId/events', authMiddleware, (req, res) => {
  const boardId = req.params.boardId;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('data: {"type":"connected"}\n\n');

  if (!sseClients.has(boardId)) sseClients.set(boardId, new Set());
  sseClients.get(boardId).add(res);

  // SSE keepalive every 30s to prevent proxy timeouts
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { clearInterval(keepalive); }
  }, 30000);

  req.on('close', () => {
    clearInterval(keepalive);
    const clients = sseClients.get(boardId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(boardId);
    }
  });
});

function broadcast(boardId, event) {
  const clients = sseClients.get(boardId);
  if (!clients || !boardId) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try { client.write(data); } catch { clients.delete(client); }
  }
}

// --- Board page route ---
app.get('/board/:boardId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'board.html'));
});

// === API Routes ===

// --- Boards ---
app.get('/api/boards', authMiddleware, (req, res) => {
  if (req.user) {
    res.json(db.getBoards());
  } else if (req.accessLink) {
    const board = db.getBoard(req.accessLink.board_id);
    res.json(board ? [{ id: board.id, title: board.title, created_at: board.created_at }] : []);
  } else {
    res.json([]);
  }
});

app.post('/api/boards', authMiddleware, requireEdit, (req, res) => {
  let title = req.body.title;
  if (title !== undefined) {
    title = validString(title, 200);
    if (title === null) return res.status(400).json({ error: 'title must be a non-empty string max 200 chars' });
  }
  const board = db.createBoard(title);
  res.status(201).json(board);
});

app.get('/api/boards/:boardId', authMiddleware, (req, res) => {
  const id = req.params.boardId;
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const board = db.getBoard(id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  res.json(board);
});

app.patch('/api/boards/:boardId', authMiddleware, requireEdit, (req, res) => {
  const id = req.params.boardId;
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const title = validString(req.body.title, 200);
  if (title === null) return res.status(400).json({ error: 'title must be a non-empty string max 200 chars' });
  const board = db.updateBoard(id, title);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  broadcast(id, { type: 'update', action: 'board_updated' });
  res.json(board);
});

app.delete('/api/boards/:boardId', authMiddleware, requireEdit, (req, res) => {
  const id = req.params.boardId;
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const board = db.deleteBoard(id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  broadcast(id, { type: 'update', action: 'board_deleted' });
  res.json({ ok: true });
});

// --- Export / Import ---
app.get('/api/boards/:boardId/export', authMiddleware, (req, res) => {
  const boardId = req.params.boardId;
  const data = db.exportBoard(boardId);
  if (!data) return res.status(404).json({ error: 'Board not found' });
  const safeTitle = (data.title || 'board').replace(/[^\w\s-]/g, '_').slice(0, 100);
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.json"`);
  res.json(data);
});

app.post('/api/boards/import', authMiddleware, requireEdit, (req, res) => {
  if (!req.body || !req.body.title) return res.status(400).json({ error: 'Invalid board data' });
  const board = db.importBoard(req.body);
  res.status(201).json(board);
});

// --- Archived cards ---
app.get('/api/boards/:boardId/archived', authMiddleware, (req, res) => {
  const boardId = req.params.boardId;
  res.json(db.getArchivedCards(boardId));
});

// --- Columns ---
app.post('/api/boards/:boardId/columns', authMiddleware, requireEdit, (req, res) => {
  const boardId = req.params.boardId;
  if (!boardId) return res.status(400).json({ error: 'Invalid ID' });
  let title = req.body.title;
  if (title !== undefined) {
    title = validString(title, 1000);
    if (title === null) return res.status(400).json({ error: 'title must be a non-empty string max 1000 chars' });
  } else {
    title = 'New Column';
  }
  const col = db.createColumn(boardId, title);
  if (!col) return res.status(404).json({ error: 'Board not found' });
  broadcast(boardId, { type: 'update', action: 'column_created' });
  res.status(201).json(col);
});

app.patch('/api/columns/:columnId', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.columnId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const title = validString(req.body.title, 1000);
  if (title === null) return res.status(400).json({ error: 'title must be a non-empty string max 1000 chars' });
  const col = db.updateColumn(id, title);
  if (!col) return res.status(404).json({ error: 'Column not found' });
  broadcast(col.board_id, { type: 'update', action: 'column_updated' });
  res.json(col);
});

app.delete('/api/columns/:columnId', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.columnId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const col = db.deleteColumn(id);
  if (!col) return res.status(404).json({ error: 'Column not found' });
  broadcast(col.board_id, { type: 'update', action: 'column_deleted' });
  res.json({ ok: true });
});

app.put('/api/columns/:columnId/move', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.columnId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const position = Number(req.body.position);
  if (!Number.isInteger(position) || position < 0) return res.status(400).json({ error: 'position must be a non-negative integer' });
  const col = db.moveColumn(id, position);
  if (!col) return res.status(404).json({ error: 'Column not found' });
  broadcast(col.board_id, { type: 'update', action: 'column_moved' });
  res.json(col);
});

// --- Cards ---
app.post('/api/columns/:columnId/cards', authMiddleware, requireEdit, (req, res) => {
  const columnId = validId(req.params.columnId);
  if (!columnId) return res.status(400).json({ error: 'Invalid ID' });
  let text = req.body.text;
  if (text !== undefined) {
    text = validString(text, 1000);
    if (text === null) return res.status(400).json({ error: 'text must be a non-empty string max 1000 chars' });
  } else {
    text = 'New Card';
  }
  const card = db.createCard(columnId, text);
  if (!card) return res.status(404).json({ error: 'Column not found' });
  const boardId = db.getColumnBoardId(columnId);
  if (boardId) broadcast(boardId, { type: 'update', action: 'card_created' });
  res.status(201).json(card);
});

app.patch('/api/cards/:cardId', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const updates = {};
  if (req.body.text !== undefined) {
    const text = validString(req.body.text, 1000);
    if (text === null) return res.status(400).json({ error: 'text must be a non-empty string max 1000 chars' });
    updates.text = text;
  }
  if (req.body.description !== undefined) {
    updates.description = typeof req.body.description === 'string' ? req.body.description.slice(0, 5000) : '';
  }
  if (req.body.due_date !== undefined) {
    if (req.body.due_date === null || req.body.due_date === '') {
      updates.due_date = null;
    } else if (typeof req.body.due_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(req.body.due_date)) {
      updates.due_date = req.body.due_date;
    } else {
      return res.status(400).json({ error: 'due_date must be ISO date string or null' });
    }
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updates provided' });
  const card = db.updateCard(id, updates);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const boardId = db.getCardBoardId(id);
  if (boardId) broadcast(boardId, { type: 'update', action: 'card_updated' });
  res.json(card);
});

app.delete('/api/cards/:cardId', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  // Fetch boardId before deletion since the card will be gone after
  const boardId = db.getCardBoardId(id);
  const card = db.deleteCard(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  if (boardId) broadcast(boardId, { type: 'update', action: 'card_deleted' });
  res.json({ ok: true });
});

app.put('/api/cards/:cardId/move', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const columnId = Number(req.body.columnId);
  if (!Number.isInteger(columnId) || columnId <= 0) return res.status(400).json({ error: 'columnId must be a positive integer' });
  const position = Number(req.body.position);
  if (!Number.isInteger(position) || position < 0) return res.status(400).json({ error: 'position must be a non-negative integer' });
  const card = db.moveCard(id, columnId, position);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  // After move, card.column_id is the target column; look up boardId from there
  const boardId = db.getColumnBoardId(card.column_id);
  if (boardId) broadcast(boardId, { type: 'update', action: 'card_moved' });
  res.json(card);
});

// --- Archive ---
app.put('/api/cards/:cardId/archive', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const card = db.archiveCard(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const boardId = db.getColumnBoardId(card.column_id);
  if (boardId) broadcast(boardId, { type: 'update', action: 'card_archived' });
  res.json(card);
});

app.put('/api/cards/:cardId/restore', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const card = db.restoreCard(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const boardId = db.getColumnBoardId(card.column_id);
  if (boardId) broadcast(boardId, { type: 'update', action: 'card_restored' });
  res.json(card);
});

// --- Checklist ---
app.get('/api/cards/:cardId/checklist', authMiddleware, (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  res.json(db.getChecklist(id));
});

app.post('/api/cards/:cardId/checklist', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const text = validString(req.body.text, 1000);
  if (text === null) return res.status(400).json({ error: 'text must be a non-empty string max 1000 chars' });
  const item = db.createChecklistItem(id, text);
  if (!item) return res.status(404).json({ error: 'Card not found' });
  const boardId = db.getCardBoardId(id);
  if (boardId) broadcast(boardId, { type: 'update', action: 'checklist_item_created' });
  res.status(201).json(item);
});

app.patch('/api/checklist/:itemId', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.itemId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const item = db.updateChecklistItem(id, req.body);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const boardId = db.getCardBoardId(item.card_id);
  if (boardId) broadcast(boardId, { type: 'update', action: 'checklist_item_updated' });
  res.json(item);
});

app.delete('/api/checklist/:itemId', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.itemId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const item = db.deleteChecklistItem(id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const boardId = db.getCardBoardId(item.card_id);
  if (boardId) broadcast(boardId, { type: 'update', action: 'checklist_item_deleted' });
  res.json({ ok: true });
});

// --- Comments ---
app.get('/api/cards/:cardId/comments', authMiddleware, (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  res.json(db.getComments(id));
});

app.post('/api/cards/:cardId/comments', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const text = validString(req.body.text, 5000);
  if (!text) return res.status(400).json({ error: 'text required' });
  const comment = db.createComment(id, text);
  if (!comment) return res.status(404).json({ error: 'Card not found' });
  const boardId = db.getCardBoardId(id);
  if (boardId) broadcast(boardId, { type: 'update', action: 'comment_created' });
  res.status(201).json(comment);
});

app.delete('/api/comments/:commentId', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.commentId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const comment = db.deleteComment(id);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  res.json({ ok: true });
});

// --- Labels ---
app.get('/api/boards/:boardId/labels', authMiddleware, (req, res) => {
  const boardId = req.params.boardId;
  res.json(db.getLabels(boardId));
});

app.post('/api/boards/:boardId/labels', authMiddleware, requireEdit, (req, res) => {
  const boardId = req.params.boardId;
  const name = validString(req.body.name, 100);
  if (!name) return res.status(400).json({ error: 'name required, max 100 chars' });
  const color = req.body.color || '#2563eb';
  const label = db.createLabel(boardId, name, color);
  broadcast(boardId, { type: 'update', action: 'label_created' });
  res.status(201).json(label);
});

app.patch('/api/labels/:labelId', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.labelId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const label = db.updateLabel(id, req.body);
  if (!label) return res.status(404).json({ error: 'Label not found' });
  broadcast(label.board_id, { type: 'update', action: 'label_updated' });
  res.json(label);
});

app.delete('/api/labels/:labelId', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.labelId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const label = db.deleteLabel(id);
  if (!label) return res.status(404).json({ error: 'Label not found' });
  broadcast(label.board_id, { type: 'update', action: 'label_deleted' });
  res.json({ ok: true });
});

app.post('/api/cards/:cardId/labels/:labelId', authMiddleware, requireEdit, (req, res) => {
  const cardId = validId(req.params.cardId);
  const labelId = validId(req.params.labelId);
  if (!cardId || !labelId) return res.status(400).json({ error: 'Invalid ID' });
  db.addLabelToCard(cardId, labelId);
  const boardId = db.getCardBoardId(cardId);
  if (boardId) broadcast(boardId, { type: 'update', action: 'card_label_added' });
  res.json({ ok: true });
});

app.delete('/api/cards/:cardId/labels/:labelId', authMiddleware, requireEdit, (req, res) => {
  const cardId = validId(req.params.cardId);
  const labelId = validId(req.params.labelId);
  if (!cardId || !labelId) return res.status(400).json({ error: 'Invalid ID' });
  db.removeLabelFromCard(cardId, labelId);
  const boardId = db.getCardBoardId(cardId);
  if (boardId) broadcast(boardId, { type: 'update', action: 'card_label_removed' });
  res.json({ ok: true });
});

// --- Attachments ---
app.post('/api/cards/:cardId/attachments', authMiddleware, requireEdit, uploadSingle, (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const att = db.createAttachment(id, req.file);
  if (!att) return res.status(404).json({ error: 'Card not found' });
  const boardId = db.getCardBoardId(id);
  if (boardId) broadcast(boardId, { type: 'update', action: 'attachment_created' });
  res.status(201).json(att);
});

app.get('/api/attachments/:id', authMiddleware, (req, res) => {
  const id = validId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const att = db.getAttachment(id);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  const safePath = path.join(__dirname, 'uploads', path.basename(att.filepath));
  const safeFilename = path.basename(att.filename);
  res.download(safePath, safeFilename, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: 'Download failed' });
  });
});

app.delete('/api/attachments/:id', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const att = db.deleteAttachment(id);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  const safePath = path.join(__dirname, 'uploads', path.basename(att.filepath));
  try { fs.unlinkSync(safePath); } catch (e) { /* file may already be gone */ }
  const boardId = db.getCardBoardId(att.card_id);
  if (boardId) broadcast(boardId, { type: 'update', action: 'attachment_deleted' });
  res.json({ ok: true });
});

// --- Activity ---
app.get('/api/boards/:boardId/activity', authMiddleware, (req, res) => {
  const id = req.params.boardId;
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const rawLimit = Number(req.query.limit) || 50;
  const limit = Math.min(rawLimit, 200);
  res.json(db.getActivity(id, limit));
});

// --- Board access links ---
app.get('/api/boards/:boardId/access-links', authMiddleware, requireAdmin, (req, res) => {
  res.json(db.getBoardAccessLinks(req.params.boardId));
});

app.post('/api/boards/:boardId/access-links', authMiddleware, requireAdmin, (req, res) => {
  const permission = req.body.permission === 'edit' ? 'edit' : 'view';
  const label = validString(req.body.label, 200) || '';
  const link = db.createBoardAccessLink(req.params.boardId, permission, label);
  res.status(201).json(link);
});

app.delete('/api/access-links/:id', authMiddleware, requireAdmin, (req, res) => {
  const link = db.deleteBoardAccessLink(req.params.id);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  res.json({ ok: true });
});

// --- Global error handler ---
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// --- Start ---
const server = app.listen(PORT, () => {
  console.log(`Kanban board running at http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(); });
process.on('SIGINT', () => { server.close(); });
