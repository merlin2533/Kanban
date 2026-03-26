const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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

// --- Board page route ---
app.get('/board/:boardId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'board.html'));
});

// === API Routes ===

// --- Boards ---
app.get('/api/boards', (req, res) => {
  res.json(db.getBoards());
});

app.post('/api/boards', (req, res) => {
  let title = req.body.title;
  if (title !== undefined) {
    title = validString(title, 200);
    if (title === null) return res.status(400).json({ error: 'title must be a non-empty string max 200 chars' });
  }
  const board = db.createBoard(title);
  res.status(201).json(board);
});

app.get('/api/boards/:boardId', (req, res) => {
  const id = req.params.boardId;
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const board = db.getBoard(id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  res.json(board);
});

app.patch('/api/boards/:boardId', (req, res) => {
  const id = req.params.boardId;
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const title = validString(req.body.title, 200);
  if (title === null) return res.status(400).json({ error: 'title must be a non-empty string max 200 chars' });
  const board = db.updateBoard(id, title);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  res.json(board);
});

app.delete('/api/boards/:boardId', (req, res) => {
  const id = req.params.boardId;
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const board = db.deleteBoard(id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  res.json({ ok: true });
});

// --- Columns ---
app.post('/api/boards/:boardId/columns', (req, res) => {
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
  res.status(201).json(col);
});

app.patch('/api/columns/:columnId', (req, res) => {
  const id = validId(req.params.columnId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const title = validString(req.body.title, 1000);
  if (title === null) return res.status(400).json({ error: 'title must be a non-empty string max 1000 chars' });
  const col = db.updateColumn(id, title);
  if (!col) return res.status(404).json({ error: 'Column not found' });
  res.json(col);
});

app.delete('/api/columns/:columnId', (req, res) => {
  const id = validId(req.params.columnId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const col = db.deleteColumn(id);
  if (!col) return res.status(404).json({ error: 'Column not found' });
  res.json({ ok: true });
});

app.put('/api/columns/:columnId/move', (req, res) => {
  const id = validId(req.params.columnId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const position = Number(req.body.position);
  if (!Number.isInteger(position) || position < 0) return res.status(400).json({ error: 'position must be a non-negative integer' });
  const col = db.moveColumn(id, position);
  if (!col) return res.status(404).json({ error: 'Column not found' });
  res.json(col);
});

// --- Cards ---
app.post('/api/columns/:columnId/cards', (req, res) => {
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
  res.status(201).json(card);
});

app.patch('/api/cards/:cardId', (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const text = validString(req.body.text, 1000);
  if (text === null) return res.status(400).json({ error: 'text must be a non-empty string max 1000 chars' });
  const card = db.updateCard(id, text);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json(card);
});

app.delete('/api/cards/:cardId', (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const card = db.deleteCard(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json({ ok: true });
});

app.put('/api/cards/:cardId/move', (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const columnId = Number(req.body.columnId);
  if (!Number.isInteger(columnId) || columnId <= 0) return res.status(400).json({ error: 'columnId must be a positive integer' });
  const position = Number(req.body.position);
  if (!Number.isInteger(position) || position < 0) return res.status(400).json({ error: 'position must be a non-negative integer' });
  const card = db.moveCard(id, columnId, position);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json(card);
});

// --- Checklist ---
app.get('/api/cards/:cardId/checklist', (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  res.json(db.getChecklist(id));
});

app.post('/api/cards/:cardId/checklist', (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const text = validString(req.body.text, 1000);
  if (text === null) return res.status(400).json({ error: 'text must be a non-empty string max 1000 chars' });
  const item = db.createChecklistItem(id, text);
  if (!item) return res.status(404).json({ error: 'Card not found' });
  res.status(201).json(item);
});

app.patch('/api/checklist/:itemId', (req, res) => {
  const id = validId(req.params.itemId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const item = db.updateChecklistItem(id, req.body);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json(item);
});

app.delete('/api/checklist/:itemId', (req, res) => {
  const id = validId(req.params.itemId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const item = db.deleteChecklistItem(id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json({ ok: true });
});

// --- Attachments ---
app.post('/api/cards/:cardId/attachments', uploadSingle, (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const att = db.createAttachment(id, req.file);
  if (!att) return res.status(404).json({ error: 'Card not found' });
  res.status(201).json(att);
});

app.get('/api/attachments/:id', (req, res) => {
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

app.delete('/api/attachments/:id', (req, res) => {
  const id = validId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const att = db.deleteAttachment(id);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  const safePath = path.join(__dirname, 'uploads', path.basename(att.filepath));
  try { fs.unlinkSync(safePath); } catch (e) { /* file may already be gone */ }
  res.json({ ok: true });
});

// --- Activity ---
app.get('/api/boards/:boardId/activity', (req, res) => {
  const id = req.params.boardId;
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const rawLimit = Number(req.query.limit) || 50;
  const limit = Math.min(rawLimit, 200);
  res.json(db.getActivity(id, limit));
});

// --- Global error handler ---
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Kanban board running at http://localhost:${PORT}`);
});
