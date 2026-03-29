const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const db = require('./db');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// --- Initialise persisted app settings from env vars (first-run defaults) ---
db.initSetting('resend_api_key',           process.env.RESEND_API_KEY           || '');
db.initSetting('email_from',               process.env.EMAIL_FROM               || 'support@yourdomain.com');
db.initSetting('reminder_interval_hours',  process.env.REMINDER_INTERVAL_HOURS  || '24');
db.initSetting('reminder_escalation_days', process.env.REMINDER_ESCALATION_DAYS || '3');
db.initSetting('api_key',                  process.env.API_KEY                  || require('crypto').randomBytes(24).toString('hex'));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// --- Middleware ---
// Trust proxy headers (X-Forwarded-Proto etc.) when behind reverse proxy
app.set('trust proxy', 1);
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

// --- Debug logging ---
const DEBUG_AUTH = process.env.DEBUG_AUTH !== '0'; // enabled by default, set DEBUG_AUTH=0 to disable
function authLog(...args) {
  if (DEBUG_AUTH) console.log('[AUTH]', new Date().toISOString(), ...args);
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
  authLog(`middleware: ${req.method} ${req.originalUrl}`);
  const accessToken = req.query.token;
  if (accessToken) {
    const link = db.getBoardAccessLink(accessToken);
    if (link) {
      authLog('middleware: access token valid, board:', link.board_id);
      req.accessLink = link;
      req.permission = link.permission;
      return next();
    }
    authLog('middleware: access token invalid');
  }
  const cookies = parseCookies(req);
  const sessionId = cookies.kanban_session;
  authLog('middleware: cookie present:', !!sessionId, sessionId ? `(${sessionId.substring(0, 8)}...)` : '');
  if (sessionId) {
    const session = db.getSession(sessionId);
    authLog('middleware: session lookup result:', session ? `user=${session.username}` : 'NULL (expired or not found)');
    if (session) {
      req.user = { id: session.user_id, username: session.username, is_admin: session.is_admin, password_changed_at: session.password_changed_at };
      req.permission = 'admin';
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        if (!req.query.token && !req.headers['x-requested-with']) {
          authLog('middleware: CSRF check failed - missing X-Requested-With');
          return res.status(403).json({ error: 'Missing X-Requested-With header' });
        }
      }
      return next();
    }
  }
  authLog('middleware: 401 - no valid auth found. Cookie header:', req.headers.cookie ? 'present' : 'MISSING');
  return res.status(401).json({ error: 'Authentication required' });
}

function requireEdit(req, res, next) {
  if (req.permission === 'admin' || req.permission === 'edit') return next();
  return res.status(403).json({ error: 'Edit permission required' });
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireBoardAccess(req, boardId) {
  // Admin users can access all boards
  if (req.user && req.user.is_admin) return true;
  // Regular users must be board members
  if (req.user) return db.isBoardMember(boardId, req.user.id);
  // Access link users can only access their linked board
  if (req.accessLink && req.accessLink.board_id === boardId) return true;
  return false;
}

// --- Login rate limiting ---
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || [];
  // Clean old attempts (older than 60s)
  const recent = attempts.filter(t => now - t < 60000);
  if (recent.length >= 5) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 1 minute.' });
  }
  loginAttempts.set(ip, recent);
  next();
}
// Clean rate limit map periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, attempts] of loginAttempts) {
    const recent = attempts.filter(t => now - t < 60000);
    if (recent.length === 0) loginAttempts.delete(ip);
    else loginAttempts.set(ip, recent);
  }
}, 60000);

// --- General mutation rate limiting ---
const mutationAttempts = new Map();
function mutationRateLimit(maxPerMinute) {
  return (req, res, next) => {
    const key = (req.user ? 'u:' + req.user.id : 'ip:' + (req.ip || req.connection.remoteAddress));
    const now = Date.now();
    const attempts = mutationAttempts.get(key) || [];
    const recent = attempts.filter(t => now - t < 60000);
    if (recent.length >= maxPerMinute) {
      return res.status(429).json({ error: 'Zu viele Anfragen. Bitte warte einen Moment.' });
    }
    recent.push(now);
    mutationAttempts.set(key, recent);
    next();
  };
}
// Clean mutation rate limit map periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, attempts] of mutationAttempts) {
    const recent = attempts.filter(t => now - t < 60000);
    if (recent.length === 0) mutationAttempts.delete(key);
    else mutationAttempts.set(key, recent);
  }
}, 60000);

// --- Auth Routes ---
app.post('/api/auth/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};
  authLog('login: attempt for user:', username);
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const ip = req.ip || req.connection.remoteAddress;
  const user = db.authenticateUser(username, password);
  if (!user) {
    authLog('login: FAILED for user:', username, 'from IP:', ip);
    const attempts = loginAttempts.get(ip) || [];
    attempts.push(Date.now());
    loginAttempts.set(ip, attempts);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const session = db.createSession(user.id);
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const secure = isHttps ? '; Secure' : '';
  const cookieStr = `kanban_session=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*60*60}${secure}`;
  authLog('login: SUCCESS user:', username, 'session:', session.id.substring(0, 8) + '...', 'isHttps:', isHttps, 'secure flag:', !!secure, 'NODE_ENV:', process.env.NODE_ENV);
  authLog('login: Set-Cookie:', cookieStr.replace(session.id, session.id.substring(0, 8) + '...'));
  res.setHeader('Set-Cookie', cookieStr);
  const pwAge = user.password_changed_at ? (Date.now() - new Date(user.password_changed_at + 'Z').getTime()) / 86400000 : 999;
  res.json({ user: { id: user.id, username: user.username, is_admin: user.is_admin }, passwordReminder: pwAge >= 14 });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  authLog('logout: session:', cookies.kanban_session ? cookies.kanban_session.substring(0, 8) + '...' : 'none');
  if (cookies.kanban_session) db.deleteSession(cookies.kanban_session);
  res.setHeader('Set-Cookie', 'kanban_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const cookies = parseCookies(req);
  const sessionId = cookies.kanban_session;
  authLog('me: cookie present:', !!sessionId, 'referer:', req.headers.referer || 'none');
  if (!sessionId) {
    authLog('me: → 401 (no cookie)');
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const session = db.getSession(sessionId);
  if (!session) {
    authLog('me: → 401 (session expired/not found)');
    return res.status(401).json({ error: 'Session expired' });
  }
  authLog('me: → OK, user:', session.username);
  const pwAge = session.password_changed_at ? (Date.now() - new Date(session.password_changed_at + 'Z').getTime()) / 86400000 : 999;
  res.json({ user: { id: session.user_id, username: session.username, is_admin: session.is_admin }, passwordReminder: pwAge >= 14 });
});

// Returns 200 always – used by login page to avoid a red 401 in the console
app.get('/api/auth/status', (req, res) => {
  const cookies = parseCookies(req);
  const sessionId = cookies.kanban_session;
  authLog('status: cookie present:', !!sessionId, sessionId ? `(${sessionId.substring(0, 8)}...)` : '', 'referer:', req.headers.referer || 'none', 'cookie-header:', req.headers.cookie ? 'present' : 'MISSING');
  if (!sessionId) {
    authLog('status: → authenticated: false (no cookie)');
    return res.json({ authenticated: false });
  }
  const session = db.getSession(sessionId);
  if (!session) {
    authLog('status: → authenticated: false (session expired/not found for', sessionId.substring(0, 8) + '...)');
    return res.json({ authenticated: false });
  }
  authLog('status: → authenticated: true, user:', session.username);
  const pwAge = session.password_changed_at ? (Date.now() - new Date(session.password_changed_at + 'Z').getTime()) / 86400000 : 999;
  res.json({ authenticated: true, user: { id: session.user_id, username: session.username, is_admin: session.is_admin }, passwordReminder: pwAge >= 14 });
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
app.get('/api/admin/users', authMiddleware, requireAdmin, (req, res) => {
  res.json(db.getUsers());
});

app.post('/api/admin/users', authMiddleware, requireAdmin, (req, res) => {
  const username = validString(req.body.username, 100);
  if (!username) return res.status(400).json({ error: 'username required' });
  const password = req.body.password;
  if (!password || password.length < 6) return res.status(400).json({ error: 'password must be at least 6 chars' });
  try {
    const user = db.createUser(username, password, req.body.is_admin || false);
    res.status(201).json(user);
  } catch (e) {
    res.status(409).json({ error: 'Username already exists' });
  }
});

app.delete('/api/admin/users/:id', authMiddleware, requireAdmin, (req, res) => {
  const id = validId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  if (req.user.id === id) return res.status(400).json({ error: 'Cannot delete yourself' });
  const user = db.deleteUser(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

// --- Board Access Links ---
app.get('/api/boards/:boardId/access-links', authMiddleware, requireAdmin, (req, res) => {
  const boardId = req.params.boardId;
  if (!requireBoardAccess(req, boardId)) return res.status(403).json({ error: 'No access to this board' });
  res.json(db.getBoardAccessLinks(boardId));
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

// --- Board Member Management (admin only) ---
app.get('/api/boards/:boardId/members', authMiddleware, requireAdmin, (req, res) => {
  res.json(db.getBoardMembers(req.params.boardId));
});

app.post('/api/boards/:boardId/members', authMiddleware, requireAdmin, (req, res) => {
  const userId = validId(req.body.user_id);
  if (!userId) return res.status(400).json({ error: 'user_id required' });
  db.addBoardMember(req.params.boardId, userId);
  res.status(201).json({ ok: true });
});

app.delete('/api/boards/:boardId/members/:userId', authMiddleware, requireAdmin, (req, res) => {
  const userId = validId(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid user ID' });
  db.removeBoardMember(req.params.boardId, userId);
  res.json({ ok: true });
});

// --- SSE ---
const sseClients = new Map(); // boardId -> Set of response objects
const boardPresence = new Map(); // boardId -> Map(username -> { username, connectedAt })

// --- Webhook trigger ---
function triggerWebhooks(boardId, event) {
  const webhooks = db.getActiveWebhooks(boardId);
  for (const wh of webhooks) {
    if (wh.events !== '*' && !wh.events.split(',').includes(event.action)) continue;
    const payload = JSON.stringify({ board_id: boardId, ...event, timestamp: new Date().toISOString() });
    try {
      const url = new URL(wh.url);
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } });
      req.on('error', () => {});
      req.write(payload);
      req.end();
    } catch {}
  }
}

app.get('/api/boards/:boardId/events', authMiddleware, (req, res) => {
  const boardId = req.params.boardId;
  if (!requireBoardAccess(req, boardId)) return res.status(403).json({ error: 'No access to this board' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('data: {"type":"connected"}\n\n');

  if (!sseClients.has(boardId)) sseClients.set(boardId, new Set());
  sseClients.get(boardId).add(res);

  // Track presence (authenticated users and guests with name)
  const presenceUser = req.user ? req.user.username : (req.query.guest || '');
  if (presenceUser) {
    if (!boardPresence.has(boardId)) boardPresence.set(boardId, new Map());
    boardPresence.get(boardId).set(presenceUser, { username: presenceUser, connectedAt: new Date().toISOString() });
    broadcast(boardId, { type: 'presence', users: [...(boardPresence.get(boardId) || new Map()).values()] });
  }
  req._presenceUser = presenceUser;

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
    if (req._presenceUser) {
      const presence = boardPresence.get(boardId);
      if (presence) {
        presence.delete(req._presenceUser);
        if (presence.size === 0) boardPresence.delete(boardId);
        else broadcast(boardId, { type: 'presence', users: [...presence.values()] });
      }
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
  triggerWebhooks(boardId, event);
}

// --- Board page route ---
app.get('/board/:boardId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'board.html'));
});

// === API Routes ===

// --- Boards ---
app.get('/api/boards', authMiddleware, (req, res) => {
  if (req.user) {
    const boards = req.user.is_admin ? db.getAllBoards() : db.getBoardsForUser(req.user.id);
    res.json(boards);
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
  const creatorUserId = req.user ? req.user.id : null;
  const board = db.createBoard(title, creatorUserId);
  // If non-admin users exist, add them as members too (admin creates board for team)
  res.status(201).json(board);
});

app.get('/api/boards/:boardId', authMiddleware, (req, res) => {
  const id = req.params.boardId;
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  if (!requireBoardAccess(req, id)) return res.status(403).json({ error: 'No access to this board' });
  const board = db.getBoard(id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  res.json(board);
});

app.patch('/api/boards/:boardId', authMiddleware, requireEdit, (req, res) => {
  const id = req.params.boardId;
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  if (!requireBoardAccess(req, id)) return res.status(403).json({ error: 'No access to this board' });
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
  if (!requireBoardAccess(req, id)) return res.status(403).json({ error: 'No access to this board' });
  const filePaths = db.getBoardAttachmentPaths(id);
  const board = db.deleteBoard(id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  for (const fp of filePaths) {
    try { fs.unlinkSync(path.join(uploadsDir, path.basename(fp))); } catch {}
  }
  broadcast(id, { type: 'update', action: 'board_deleted' });
  res.json({ ok: true });
});

// --- Export / Import ---
app.get('/api/boards/:boardId/export', authMiddleware, (req, res) => {
  const boardId = req.params.boardId;
  if (!requireBoardAccess(req, boardId)) return res.status(403).json({ error: 'No access to this board' });
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
  if (!requireBoardAccess(req, boardId)) return res.status(403).json({ error: 'No access to this board' });
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
  const updates = {};
  if (req.body.title !== undefined) {
    const title = validString(req.body.title, 1000);
    if (title === null) return res.status(400).json({ error: 'title must be a non-empty string' });
    updates.title = title;
  }
  if (req.body.wip_limit !== undefined) {
    const wl = Number(req.body.wip_limit);
    updates.wip_limit = Number.isInteger(wl) && wl >= 0 ? wl : 0;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updates' });
  const col = db.updateColumn(id, updates);
  if (!col) return res.status(404).json({ error: 'Column not found' });
  // broadcast if possible
  if (col.board_id) broadcast(col.board_id, { type: 'update', action: 'column_updated' });
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

// --- Helper: get username from request ---
function getRequestUser(req) {
  if (req.user) return req.user.username;
  // Guest name passed via header (for access-link users)
  const guest = req.headers['x-guest-name'];
  if (guest && typeof guest === 'string') return guest.trim().slice(0, 100);
  return '';
}

// --- Cards ---
app.post('/api/columns/:columnId/cards', authMiddleware, requireEdit, mutationRateLimit(60), (req, res) => {
  const columnId = validId(req.params.columnId);
  if (!columnId) return res.status(400).json({ error: 'Invalid ID' });
  let text = req.body.text;
  if (text !== undefined) {
    text = validString(text, 1000);
    if (text === null) return res.status(400).json({ error: 'text must be a non-empty string max 1000 chars' });
  } else {
    text = 'New Card';
  }
  const createdBy = getRequestUser(req);
  const card = db.createCard(columnId, text, createdBy);
  if (!card) return res.status(404).json({ error: 'Column not found' });
  const boardId = db.getColumnBoardId(columnId);
  if (boardId) broadcast(boardId, { type: 'update', action: 'card_created', user: createdBy });
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
  if (req.body.priority !== undefined) {
    const valid = [null, 'low', 'medium', 'high'];
    updates.priority = valid.includes(req.body.priority) ? req.body.priority : null;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updates provided' });
  const card = db.updateCard(id, updates);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const boardId = db.getCardBoardId(id);
  const user = getRequestUser(req);
  if (boardId) broadcast(boardId, { type: 'update', action: 'card_updated', cardId: id, user });
  res.json(card);
});

app.delete('/api/cards/:cardId', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  // Fetch boardId before deletion since the card will be gone after
  const boardId = db.getCardBoardId(id);
  const filePaths = db.getCardAttachmentPaths(id);
  const card = db.deleteCard(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  for (const fp of filePaths) {
    try { fs.unlinkSync(path.join(uploadsDir, path.basename(fp))); } catch {}
  }
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
  const user = getRequestUser(req);
  if (boardId) broadcast(boardId, { type: 'update', action: 'card_moved', cardId: id, user });
  res.json(card);
});

// --- Archive ---
app.put('/api/cards/:cardId/archive', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const boardId = db.getCardBoardId(id);
  if (!boardId) return res.status(404).json({ error: 'Card not found' });
  if (!requireBoardAccess(req, boardId)) return res.status(403).json({ error: 'Access denied' });
  const card = db.archiveCard(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  broadcast(boardId, { type: 'update', action: 'card_archived' });
  res.json(card);
});

app.put('/api/cards/:cardId/restore', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const boardId = db.getCardBoardId(id);
  if (!boardId) return res.status(404).json({ error: 'Card not found' });
  if (!requireBoardAccess(req, boardId)) return res.status(403).json({ error: 'Access denied' });
  const card = db.restoreCard(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  broadcast(boardId, { type: 'update', action: 'card_restored' });
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

app.post('/api/cards/:cardId/comments', authMiddleware, requireEdit, mutationRateLimit(100), (req, res) => {
  const id = validId(req.params.cardId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const text = validString(req.body.text, 5000);
  if (!text) return res.status(400).json({ error: 'text required' });
  const author = getRequestUser(req);
  const comment = db.createComment(id, text, author);
  if (!comment) return res.status(404).json({ error: 'Card not found' });
  const boardId = db.getCardBoardId(id);
  if (boardId) broadcast(boardId, { type: 'update', action: 'comment_created', cardId: id, user: author });
  res.status(201).json(comment);
});

app.patch('/api/comments/:commentId', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.commentId);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const text = validString(req.body.text, 5000);
  if (!text) return res.status(400).json({ error: 'text required' });
  const comment = db.updateComment(id, text);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  const boardId = db.getCardBoardId(comment.card_id);
  if (boardId) broadcast(boardId, { type: 'update', action: 'comment_updated', cardId: comment.card_id, user: getRequestUser(req) });
  res.json(comment);
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
  if (!requireBoardAccess(req, boardId)) return res.status(403).json({ error: 'No access to this board' });
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
app.post('/api/cards/:cardId/attachments', authMiddleware, requireEdit, mutationRateLimit(15), uploadSingle, (req, res) => {
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

// --- Card Assignees ---
app.post('/api/cards/:cardId/assignees/:userId', authMiddleware, requireEdit, (req, res) => {
  const cardId = validId(req.params.cardId);
  const userId = validId(req.params.userId);
  if (!cardId || !userId) return res.status(400).json({ error: 'Invalid ID' });
  db.assignCard(cardId, userId);
  const boardId = db.getCardBoardId(cardId);
  if (boardId) broadcast(boardId, { type: 'update', action: 'card_assigned' });
  res.json({ ok: true });
});

app.delete('/api/cards/:cardId/assignees/:userId', authMiddleware, requireEdit, (req, res) => {
  const cardId = validId(req.params.cardId);
  const userId = validId(req.params.userId);
  if (!cardId || !userId) return res.status(400).json({ error: 'Invalid ID' });
  db.unassignCard(cardId, userId);
  const boardId = db.getCardBoardId(cardId);
  if (boardId) broadcast(boardId, { type: 'update', action: 'card_unassigned' });
  res.json({ ok: true });
});

// --- Webhooks ---
app.get('/api/boards/:boardId/webhooks', authMiddleware, (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin required' });
  res.json(db.getWebhooks(req.params.boardId));
});

app.post('/api/boards/:boardId/webhooks', authMiddleware, (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin required' });
  const url = req.body.url;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Valid URL required' });
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Valid URL required' }); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return res.status(400).json({ error: 'Valid URL required' });
  // Block SSRF: private/loopback IP ranges
  const host = parsed.hostname;
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === '::1') {
    return res.status(400).json({ error: 'Private URLs not allowed' });
  }
  const events = typeof req.body.events === 'string' ? req.body.events : '*';
  const wh = db.createWebhook(req.params.boardId, url, events);
  res.status(201).json(wh);
});

app.delete('/api/webhooks/:id', authMiddleware, (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin required' });
  const id = validId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const wh = db.deleteWebhook(id);
  if (!wh) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// --- DB Backup ---
app.get('/api/admin/backup', authMiddleware, (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin required' });
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'kanban.db');
  try { db.getDb().pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  res.download(dbPath, 'kanban-backup.db', (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: 'Backup failed' });
  });
});

// --- Board Templates ---
app.get('/api/templates', authMiddleware, (req, res) => {
  res.json(db.getTemplates());
});

app.post('/api/templates', authMiddleware, (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin required' });
  const name = validString(req.body.name, 200);
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!req.body.columns || !Array.isArray(req.body.columns)) return res.status(400).json({ error: 'columns array required' });
  const t = db.createTemplate(name, JSON.stringify(req.body.columns));
  res.status(201).json(t);
});

app.post('/api/boards/:boardId/save-template', authMiddleware, (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin required' });
  const name = validString(req.body.name, 200);
  if (!name) return res.status(400).json({ error: 'name required' });
  const t = db.saveBoardAsTemplate(req.params.boardId, name);
  if (!t) return res.status(404).json({ error: 'Board not found' });
  res.status(201).json(t);
});

app.post('/api/templates/:id/create-board', authMiddleware, requireEdit, (req, res) => {
  const id = validId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const title = validString(req.body.title, 200) || '';
  const board = db.createBoardFromTemplate(id, title);
  if (!board) return res.status(404).json({ error: 'Template not found' });
  res.status(201).json(board);
});

app.delete('/api/templates/:id', authMiddleware, (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin required' });
  const id = validId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const t = db.deleteTemplate(id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// --- Presence ---
app.get('/api/boards/:boardId/presence', authMiddleware, (req, res) => {
  const boardId = req.params.boardId;
  if (!requireBoardAccess(req, boardId)) return res.status(403).json({ error: 'No access' });
  const presence = boardPresence.get(boardId);
  res.json(presence ? [...presence.values()] : []);
});

// --- Activity ---
app.get('/api/boards/:boardId/activity', authMiddleware, (req, res) => {
  const id = req.params.boardId;
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  if (!requireBoardAccess(req, id)) return res.status(403).json({ error: 'No access to this board' });
  const rawLimit = Number(req.query.limit) || 50;
  const limit = Math.min(rawLimit, 200);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  res.json(db.getActivity(id, limit, offset));
});

// --- Admin: App Settings ---

// GET /api/admin/settings  → returns all settings (api_key shown as masked except to admin)
app.get('/api/admin/settings', authMiddleware, requireAdmin, (req, res) => {
  const s = db.getAllSettings();
  res.json({
    resend_api_key:           s.resend_api_key           || '',
    email_from:               s.email_from               || '',
    reminder_interval_hours:  s.reminder_interval_hours  || '24',
    reminder_escalation_days: s.reminder_escalation_days || '3',
    api_key:                  s.api_key                  || '',
  });
});

// PUT /api/admin/settings  → update one or more settings
app.put('/api/admin/settings', authMiddleware, requireAdmin, (req, res) => {
  const allowed = ['resend_api_key', 'email_from', 'reminder_interval_hours', 'reminder_escalation_days'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) db.setSetting(key, req.body[key]);
  }
  res.json({ ok: true });
});

// POST /api/admin/settings/rotate-api-key  → generate a new API key and return it
app.post('/api/admin/settings/rotate-api-key', authMiddleware, requireAdmin, (req, res) => {
  const newKey = require('crypto').randomBytes(24).toString('hex');
  db.setSetting('api_key', newKey);
  res.json({ api_key: newKey });
});

// --- External API (authenticated by api_key) ---

function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  const stored = db.getSetting('api_key');
  if (!stored || !key || key !== stored) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

// POST /api/external/tickets  → create a card from an external application
//   Body: { title, description?, board_id, column_id? }
app.post('/api/external/tickets', apiKeyAuth, (req, res) => {
  const title = validString(req.body.title, 500);
  if (!title) return res.status(400).json({ error: 'title required (max 500 chars)' });

  const boardId = req.body.board_id;
  if (!boardId) return res.status(400).json({ error: 'board_id required' });

  const board = db.getBoard(boardId);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  if (!board.columns || board.columns.length === 0) return res.status(400).json({ error: 'Board has no columns' });

  let column;
  if (req.body.column_id) {
    const colId = validId(req.body.column_id);
    column = board.columns.find(c => c.id === colId);
    if (!column) return res.status(404).json({ error: 'Column not found in this board' });
  } else {
    column = board.columns[0]; // default: first column
  }

  const description = typeof req.body.description === 'string' ? req.body.description.slice(0, 5000) : '';
  const card = db.createCard(column.id, title, description);
  res.status(201).json({ ok: true, card });
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
  console.log(`[AUTH] Debug auth logging: ENABLED (set DEBUG_AUTH=0 to disable)`);
  console.log(`[AUTH] NODE_ENV=${process.env.NODE_ENV || '(not set)'}, Secure cookie: dynamic (only when actual HTTPS detected)`);
  console.log(`[AUTH] trust proxy: ${app.get('trust proxy') || 'not set'}`);
});

// Clean expired sessions hourly
setInterval(() => { try { db.cleanExpiredSessions(); } catch {} }, 60 * 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', () => { server.close(); });
process.on('SIGINT', () => { server.close(); });
