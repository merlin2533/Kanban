const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- Multer for file uploads ---
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads'),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max

// --- Board page route ---
app.get('/board/:boardId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'board.html'));
});

// === API Routes ===

// --- Boards ---
app.post('/api/boards', (req, res) => {
  const board = db.createBoard(req.body.title);
  res.status(201).json(board);
});

app.get('/api/boards/:boardId', (req, res) => {
  const board = db.getBoard(req.params.boardId);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  res.json(board);
});

// --- Columns ---
app.post('/api/boards/:boardId/columns', (req, res) => {
  const col = db.createColumn(req.params.boardId, req.body.title || 'New Column');
  res.status(201).json(col);
});

app.patch('/api/columns/:columnId', (req, res) => {
  const col = db.updateColumn(Number(req.params.columnId), req.body.title);
  if (!col) return res.status(404).json({ error: 'Column not found' });
  res.json(col);
});

app.delete('/api/columns/:columnId', (req, res) => {
  const col = db.deleteColumn(Number(req.params.columnId));
  if (!col) return res.status(404).json({ error: 'Column not found' });
  res.json({ ok: true });
});

// --- Cards ---
app.post('/api/columns/:columnId/cards', (req, res) => {
  const card = db.createCard(Number(req.params.columnId), req.body.text || 'New Card');
  if (!card) return res.status(404).json({ error: 'Column not found' });
  res.status(201).json(card);
});

app.patch('/api/cards/:cardId', (req, res) => {
  const card = db.updateCard(Number(req.params.cardId), req.body.text);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json(card);
});

app.delete('/api/cards/:cardId', (req, res) => {
  const card = db.deleteCard(Number(req.params.cardId));
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json({ ok: true });
});

app.put('/api/cards/:cardId/move', (req, res) => {
  const { columnId, position } = req.body;
  const card = db.moveCard(Number(req.params.cardId), Number(columnId), Number(position));
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json(card);
});

// --- Checklist ---
app.get('/api/cards/:cardId/checklist', (req, res) => {
  res.json(db.getChecklist(Number(req.params.cardId)));
});

app.post('/api/cards/:cardId/checklist', (req, res) => {
  const item = db.createChecklistItem(Number(req.params.cardId), req.body.text || '');
  if (!item) return res.status(404).json({ error: 'Card not found' });
  res.status(201).json(item);
});

app.patch('/api/checklist/:itemId', (req, res) => {
  const item = db.updateChecklistItem(Number(req.params.itemId), req.body);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json(item);
});

app.delete('/api/checklist/:itemId', (req, res) => {
  const item = db.deleteChecklistItem(Number(req.params.itemId));
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json({ ok: true });
});

// --- Attachments ---
app.post('/api/cards/:cardId/attachments', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const att = db.createAttachment(Number(req.params.cardId), req.file);
  if (!att) return res.status(404).json({ error: 'Card not found' });
  res.status(201).json(att);
});

app.get('/api/attachments/:id', (req, res) => {
  const att = db.getAttachment(Number(req.params.id));
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  res.download(att.filepath, att.filename);
});

app.delete('/api/attachments/:id', (req, res) => {
  const att = db.deleteAttachment(Number(req.params.id));
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  // Remove file from disk
  try { fs.unlinkSync(att.filepath); } catch (e) { /* file may already be gone */ }
  res.json({ ok: true });
});

// --- Activity ---
app.get('/api/boards/:boardId/activity', (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json(db.getActivity(req.params.boardId, limit));
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Kanban board running at http://localhost:${PORT}`);
});
