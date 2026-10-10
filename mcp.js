'use strict';

// MCP (Model Context Protocol) server for the Kanban board.
//
// Transport: Streamable HTTP, stateless, JSON responses only (POST /mcp).
// Auth:      "Authorization: Bearer kbn_..." – API tokens are managed in the
//            admin area and are bound to a user, so a token can only see and
//            change what that user can see and change.
//
// Write tools don't touch the database directly: they call the regular REST
// API over loopback with the same token. That way e-mails, push
// notifications, live updates (SSE), webhooks and validation behave exactly
// as if the change had been made in the web UI.

const express = require('express');

const SERVER_NAME = 'kanban';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const INSTRUCTIONS = [
  'Kanban-Board-Server. Typischer Ablauf: list_boards → get_board (liefert Spalten- und Karten-IDs) → Karten anlegen/ändern/verschieben.',
  'Karten-Titel heißen in der API "title", Prioritäten sind low|medium|high, Fälligkeiten YYYY-MM-DD.',
  'Labels und Benutzer werden über ihre IDs zugeordnet (list_labels, list_board_members).',
].join(' ');

// --- JSON Schema helpers ---
const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });
const nullable = (schema) => ({ ...schema, type: [schema.type, 'null'] });
const PRIORITY = { type: ['string', 'null'], enum: ['low', 'medium', 'high', null], description: 'Priorität (low, medium, high) oder null zum Entfernen' };
const DUE_DATE = nullable(str('Fälligkeitsdatum YYYY-MM-DD oder null zum Entfernen'));
const COLOR = nullable(str('Kartenfarbe als Hex (#rrggbb) oder null'));

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

// --- Tool definitions ---
// read: true  → allowed for read-only tokens
const TOOLS = [
  {
    name: 'list_boards',
    title: 'Boards auflisten',
    description: 'Listet alle Boards, auf die der Token-Benutzer Zugriff hat (ID, Titel, Anzahl Spalten/Karten).',
    inputSchema: schema({}),
    read: true,
  },
  {
    name: 'get_board',
    title: 'Board anzeigen',
    description: 'Liefert ein Board mit allen Spalten und den (nicht archivierten) Karten inkl. Labels, Zuständigen, Checklisten-Fortschritt und Fälligkeit.',
    inputSchema: schema({
      board_id: str('Board-ID'),
      include_descriptions: bool('Vollständige Kartenbeschreibungen mitliefern (Standard: gekürzt auf 200 Zeichen)'),
    }, ['board_id']),
    read: true,
  },
  {
    name: 'get_card',
    title: 'Karte anzeigen',
    description: 'Liefert alle Details einer Karte: Beschreibung, Checkliste, Kommentare, Labels, Zuständige, Abhängigkeiten.',
    inputSchema: schema({ card_id: int('Karten-ID') }, ['card_id']),
    read: true,
  },
  {
    name: 'search_cards',
    title: 'Karten suchen',
    description: 'Volltextsuche in Titel, Beschreibung und Kommentaren der Karten eines Boards (mind. 2 Zeichen).',
    inputSchema: schema({ board_id: str('Board-ID'), query: str('Suchbegriff') }, ['board_id', 'query']),
    read: true,
  },
  {
    name: 'list_labels',
    title: 'Labels auflisten',
    description: 'Listet die Labels eines Boards (ID, Name, Farbe).',
    inputSchema: schema({ board_id: str('Board-ID') }, ['board_id']),
    read: true,
  },
  {
    name: 'list_board_members',
    title: 'Board-Mitglieder auflisten',
    description: 'Listet die Benutzer, denen Karten dieses Boards zugewiesen werden können (Mitglieder und Admins).',
    inputSchema: schema({ board_id: str('Board-ID') }, ['board_id']),
    read: true,
  },
  {
    name: 'list_archived_cards',
    title: 'Archivierte Karten',
    description: 'Listet die archivierten Karten eines Boards.',
    inputSchema: schema({ board_id: str('Board-ID') }, ['board_id']),
    read: true,
  },
  {
    name: 'create_board',
    title: 'Board anlegen',
    description: 'Legt ein neues Board an (mit den Standard-Spalten).',
    inputSchema: schema({ title: str('Titel des Boards') }, ['title']),
  },
  {
    name: 'create_column',
    title: 'Spalte anlegen',
    description: 'Legt eine neue Spalte am Ende des Boards an.',
    inputSchema: schema({ board_id: str('Board-ID'), title: str('Spaltentitel') }, ['board_id', 'title']),
  },
  {
    name: 'update_column',
    title: 'Spalte ändern',
    description: 'Benennt eine Spalte um und/oder setzt das WIP-Limit (0 = kein Limit).',
    inputSchema: schema({ column_id: int('Spalten-ID'), title: str('Neuer Titel'), wip_limit: int('WIP-Limit, 0 = aus') }, ['column_id']),
  },
  {
    name: 'create_card',
    title: 'Karte anlegen',
    description: 'Legt eine Karte in einer Spalte an. Optional direkt mit Beschreibung, Fälligkeit, Priorität, Farbe, Labels und Zuständigen.',
    inputSchema: schema({
      column_id: int('Spalten-ID (aus get_board)'),
      title: str('Kartentitel (max. 1000 Zeichen)'),
      description: str('Beschreibung (Markdown, max. 5000 Zeichen)'),
      due_date: DUE_DATE,
      priority: PRIORITY,
      color: COLOR,
      label_ids: { type: 'array', items: { type: 'integer' }, description: 'Label-IDs (aus list_labels)' },
      assignee_ids: { type: 'array', items: { type: 'integer' }, description: 'Benutzer-IDs (aus list_board_members)' },
    }, ['column_id', 'title']),
  },
  {
    name: 'update_card',
    title: 'Karte ändern',
    description: 'Ändert Felder einer Karte. Nur übergebene Felder werden geändert.',
    inputSchema: schema({
      card_id: int('Karten-ID'),
      title: str('Neuer Titel'),
      description: str('Neue Beschreibung (ersetzt die alte)'),
      due_date: DUE_DATE,
      priority: PRIORITY,
      color: COLOR,
    }, ['card_id']),
  },
  {
    name: 'move_card',
    title: 'Karte verschieben',
    description: 'Verschiebt eine Karte in eine (andere) Spalte. Ohne Position landet sie am Ende.',
    inputSchema: schema({
      card_id: int('Karten-ID'),
      column_id: int('Ziel-Spalten-ID'),
      position: int('Position in der Zielspalte, 0 = oben'),
    }, ['card_id', 'column_id']),
  },
  {
    name: 'archive_card',
    title: 'Karte archivieren',
    description: 'Archiviert eine Karte (wiederherstellbar mit restore_card).',
    inputSchema: schema({ card_id: int('Karten-ID') }, ['card_id']),
  },
  {
    name: 'restore_card',
    title: 'Karte wiederherstellen',
    description: 'Holt eine archivierte Karte zurück aufs Board.',
    inputSchema: schema({ card_id: int('Karten-ID') }, ['card_id']),
  },
  {
    name: 'delete_card',
    title: 'Karte löschen',
    description: 'Löscht eine Karte endgültig inkl. Kommentaren, Checkliste und Anhängen. Im Zweifel lieber archive_card verwenden.',
    inputSchema: schema({ card_id: int('Karten-ID') }, ['card_id']),
    destructive: true,
  },
  {
    name: 'add_comment',
    title: 'Kommentar schreiben',
    description: 'Schreibt einen Kommentar an eine Karte (als Token-Benutzer). @benutzername erwähnt jemanden.',
    inputSchema: schema({ card_id: int('Karten-ID'), text: str('Kommentartext (max. 5000 Zeichen)') }, ['card_id', 'text']),
  },
  {
    name: 'add_checklist_item',
    title: 'Checklisten-Punkt hinzufügen',
    description: 'Fügt der Checkliste einer Karte einen Punkt hinzu.',
    inputSchema: schema({ card_id: int('Karten-ID'), text: str('Text des Punkts') }, ['card_id', 'text']),
  },
  {
    name: 'update_checklist_item',
    title: 'Checklisten-Punkt ändern',
    description: 'Hakt einen Checklisten-Punkt ab/auf oder ändert seinen Text.',
    inputSchema: schema({ item_id: int('Checklisten-Punkt-ID (aus get_card)'), checked: bool('Erledigt?'), text: str('Neuer Text') }, ['item_id']),
  },
  {
    name: 'create_label',
    title: 'Label anlegen',
    description: 'Legt ein neues Label auf einem Board an.',
    inputSchema: schema({ board_id: str('Board-ID'), name: str('Label-Name'), color: str('Farbe als Hex (#rrggbb), Standard #2563eb') }, ['board_id', 'name']),
  },
  {
    name: 'set_card_label',
    title: 'Label setzen/entfernen',
    description: 'Fügt einer Karte ein Label hinzu oder entfernt es.',
    inputSchema: schema({ card_id: int('Karten-ID'), label_id: int('Label-ID'), remove: bool('true = Label entfernen') }, ['card_id', 'label_id']),
  },
  {
    name: 'set_card_assignee',
    title: 'Zuständigen setzen/entfernen',
    description: 'Weist einer Karte einen Benutzer zu oder entfernt die Zuweisung.',
    inputSchema: schema({ card_id: int('Karten-ID'), user_id: int('Benutzer-ID'), remove: bool('true = Zuweisung entfernen') }, ['card_id', 'user_id']),
  },
];

const TOOL_MAP = new Map(TOOLS.map(t => [t.name, t]));

function publicToolList(readOnly) {
  return TOOLS
    .filter(t => !readOnly || t.read)
    .map(t => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: {
        title: t.title,
        readOnlyHint: !!t.read,
        destructiveHint: !!t.destructive,
        idempotentHint: !!t.read,
        openWorldHint: false,
      },
    }));
}

class ToolError extends Error {}

function createMcpRouter({ db }) {
  const router = express.Router();

  // --- Auth ---
  function authenticate(req) {
    if (db.getSetting('mcp_enabled') !== '1') return { status: 403, error: 'MCP-Server ist deaktiviert (Admin → MCP).' };
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(\S+)$/i);
    if (!m) return { status: 401, error: 'Authorization: Bearer <token> erforderlich' };
    const tok = db.getApiTokenUser(m[1]);
    if (!tok) return { status: 401, error: 'Ungültiger API-Token' };
    return {
      token: m[1],
      user: { id: tok.user_id, username: tok.username, is_admin: !!tok.is_admin },
      readOnly: !!tok.read_only,
    };
  }

  // --- Access helpers ---
  function canAccessBoard(ctx, boardId) {
    if (!boardId) return false;
    if (ctx.user.is_admin) return true;
    return db.isBoardMember(boardId, ctx.user.id);
  }

  function assertBoard(ctx, boardId) {
    if (typeof boardId !== 'string' || !boardId) throw new ToolError('board_id fehlt');
    const exists = db.getDb().prepare('SELECT 1 FROM boards WHERE id = ?').get(boardId);
    if (!exists || !canAccessBoard(ctx, boardId)) throw new ToolError(`Board ${boardId} nicht gefunden oder kein Zugriff`);
    return boardId;
  }

  function assertId(val, field) {
    const n = Number(val);
    if (!Number.isInteger(n) || n <= 0) throw new ToolError(`${field} muss eine positive Ganzzahl sein`);
    return n;
  }

  function boardOfCard(ctx, cardId) {
    const id = assertId(cardId, 'card_id');
    const boardId = db.getCardBoardId(id);
    if (!boardId || !canAccessBoard(ctx, boardId)) throw new ToolError(`Karte ${id} nicht gefunden oder kein Zugriff`);
    return boardId;
  }

  function boardOfColumn(ctx, columnId) {
    const id = assertId(columnId, 'column_id');
    const boardId = db.getColumnBoardId(id);
    if (!boardId || !canAccessBoard(ctx, boardId)) throw new ToolError(`Spalte ${id} nicht gefunden oder kein Zugriff`);
    return boardId;
  }

  function boardOfChecklistItem(ctx, itemId) {
    const id = assertId(itemId, 'item_id');
    const row = db.getDb().prepare('SELECT card_id FROM checklist_items WHERE id = ?').get(id);
    const boardId = row ? db.getCardBoardId(row.card_id) : null;
    if (!boardId || !canAccessBoard(ctx, boardId)) throw new ToolError(`Checklisten-Punkt ${id} nicht gefunden oder kein Zugriff`);
    return boardId;
  }

  // --- Loopback call into the REST API with the caller's token ---
  async function api(ctx, method, path, body) {
    const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${ctx.token}`,
        'Content-Type': 'application/json',
        'X-Requested-With': 'kanban-mcp',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new ToolError((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  // --- Output shaping ---
  function cardSummary(card, fullDescription) {
    const desc = card.description || '';
    const out = {
      id: card.id,
      title: card.text,
      priority: card.priority || null,
      due_date: card.due_date || null,
      labels: (card.labels || []).map(l => ({ id: l.id, name: l.name })),
      assignees: (card.assignees || []).map(a => ({ id: a.id, username: a.username })),
    };
    if (desc) out.description = fullDescription || desc.length <= 200 ? desc : desc.slice(0, 200) + '…';
    const cl = card.checklist || [];
    if (cl.length) out.checklist = `${cl.filter(i => i.checked).length}/${cl.length}`;
    const comments = card.comments || [];
    if (comments.length) out.comment_count = comments.length;
    if (card.color) out.color = card.color;
    if (card.recurrence) out.recurrence = card.recurrence;
    return out;
  }

  function cardDetails(cardId) {
    const d = db.getDb();
    const card = d.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
    if (!card) throw new ToolError(`Karte ${cardId} nicht gefunden`);
    const col = d.prepare('SELECT id, title, board_id FROM columns WHERE id = ?').get(card.column_id);
    const deps = db.getCardDependencies(cardId);
    return {
      id: card.id,
      title: card.text,
      description: card.description || '',
      board_id: col ? col.board_id : null,
      column: col ? { id: col.id, title: col.title } : null,
      position: card.position,
      archived: !!card.archived,
      priority: card.priority || null,
      due_date: card.due_date || null,
      color: card.color || null,
      recurrence: card.recurrence || null,
      time_estimate_minutes: card.time_estimate ?? null,
      time_logged_minutes: card.time_logged ?? null,
      created_by: card.created_by || null,
      created_at: card.created_at,
      updated_at: card.updated_at,
      labels: db.getCardLabels(cardId).map(l => ({ id: l.id, name: l.name, color: l.color })),
      assignees: db.getCardAssignees(cardId).map(a => ({ id: a.id, username: a.username })),
      checklist: db.getChecklist(cardId).map(i => ({ id: i.id, text: i.text, checked: !!i.checked, checked_by: i.checked_by || null })),
      comments: db.getComments(cardId, 50, 0).map(c => ({ id: c.id, author: c.author, text: c.text, created_at: c.created_at })),
      comment_count: db.getCardCommentCount(cardId),
      dependencies: deps,
    };
  }

  // --- Tool implementations ---
  const handlers = {
    async list_boards(ctx) {
      const boards = ctx.user.is_admin ? db.getAllBoards() : db.getBoardsForUser(ctx.user.id);
      return boards.map(b => ({ id: b.id, title: b.title, column_count: b.column_count, card_count: b.card_count }));
    },

    async get_board(ctx, a) {
      const boardId = assertBoard(ctx, a.board_id);
      const board = db.getBoard(boardId);
      return {
        id: board.id,
        title: board.title,
        labels: (board.labels || []).map(l => ({ id: l.id, name: l.name, color: l.color })),
        columns: board.columns.map(col => ({
          id: col.id,
          title: col.title,
          wip_limit: col.wip_limit || 0,
          cards: col.cards.map(c => cardSummary(c, !!a.include_descriptions)),
        })),
        blocked_card_ids: board.blockedCardIds || [],
      };
    },

    async get_card(ctx, a) {
      boardOfCard(ctx, a.card_id);
      return cardDetails(Number(a.card_id));
    },

    async search_cards(ctx, a) {
      const boardId = assertBoard(ctx, a.board_id);
      const q = typeof a.query === 'string' ? a.query.trim() : '';
      if (q.length < 2) throw new ToolError('query muss mindestens 2 Zeichen lang sein');
      return db.searchCards(boardId, q).map(c => ({
        id: c.id, title: c.text, column_id: c.column_id, column: c.column_title,
        priority: c.priority || null, due_date: c.due_date || null,
      }));
    },

    async list_labels(ctx, a) {
      const boardId = assertBoard(ctx, a.board_id);
      return db.getLabels(boardId).map(l => ({ id: l.id, name: l.name, color: l.color }));
    },

    async list_board_members(ctx, a) {
      const boardId = assertBoard(ctx, a.board_id);
      const seen = new Map();
      for (const m of db.getBoardMembers(boardId)) seen.set(m.id, { id: m.id, username: m.username, is_admin: !!m.is_admin });
      for (const u of db.getUsers()) if (u.is_admin && !seen.has(u.id)) seen.set(u.id, { id: u.id, username: u.username, is_admin: true });
      return [...seen.values()].sort((x, y) => x.username.localeCompare(y.username));
    },

    async list_archived_cards(ctx, a) {
      const boardId = assertBoard(ctx, a.board_id);
      const cols = new Map(db.getDb().prepare('SELECT id, title FROM columns WHERE board_id = ?').all(boardId).map(c => [c.id, c.title]));
      return db.getArchivedCards(boardId).map(c => ({ id: c.id, title: c.text, column_id: c.column_id, column: cols.get(c.column_id) || null, archived_at: c.updated_at }));
    },

    async create_board(ctx, a) {
      const board = await api(ctx, 'POST', '/api/boards', { title: a.title });
      return { id: board.id, title: board.title };
    },

    async create_column(ctx, a) {
      const boardId = assertBoard(ctx, a.board_id);
      const col = await api(ctx, 'POST', `/api/boards/${encodeURIComponent(boardId)}/columns`, { title: a.title });
      return { id: col.id, title: col.title, board_id: boardId };
    },

    async update_column(ctx, a) {
      boardOfColumn(ctx, a.column_id);
      const body = {};
      if (a.title !== undefined) body.title = a.title;
      if (a.wip_limit !== undefined) body.wip_limit = a.wip_limit;
      if (!Object.keys(body).length) throw new ToolError('title oder wip_limit angeben');
      const col = await api(ctx, 'PATCH', `/api/columns/${Number(a.column_id)}`, body);
      return { id: col.id, title: col.title, wip_limit: col.wip_limit || 0 };
    },

    async create_card(ctx, a) {
      boardOfColumn(ctx, a.column_id);
      const card = await api(ctx, 'POST', `/api/columns/${Number(a.column_id)}/cards`, { text: a.title });
      const updates = {};
      for (const f of ['description', 'due_date', 'priority', 'color']) if (a[f] !== undefined) updates[f] = a[f];
      const warnings = [];
      if (Object.keys(updates).length) {
        try { await api(ctx, 'PATCH', `/api/cards/${card.id}`, updates); }
        catch (e) { warnings.push(`Felder nicht gesetzt: ${e.message}`); }
      }
      for (const labelId of a.label_ids || []) {
        try { await setLabel(ctx, card.id, labelId, false); }
        catch (e) { warnings.push(`Label ${labelId}: ${e.message}`); }
      }
      for (const userId of a.assignee_ids || []) {
        try { await api(ctx, 'POST', `/api/cards/${card.id}/assignees/${assertId(userId, 'assignee_ids')}`); }
        catch (e) { warnings.push(`Zuständiger ${userId}: ${e.message}`); }
      }
      const result = cardDetails(card.id);
      if (warnings.length) result.warnings = warnings;
      return result;
    },

    async update_card(ctx, a) {
      boardOfCard(ctx, a.card_id);
      const body = {};
      if (a.title !== undefined) body.text = a.title;
      for (const f of ['description', 'due_date', 'priority', 'color']) if (a[f] !== undefined) body[f] = a[f];
      if (!Object.keys(body).length) throw new ToolError('Keine Änderungen angegeben');
      await api(ctx, 'PATCH', `/api/cards/${Number(a.card_id)}`, body);
      return cardDetails(Number(a.card_id));
    },

    async move_card(ctx, a) {
      const sourceBoard = boardOfCard(ctx, a.card_id);
      const targetBoard = boardOfColumn(ctx, a.column_id);
      if (sourceBoard !== targetBoard) throw new ToolError('Karten können nur innerhalb desselben Boards verschoben werden');
      const columnId = Number(a.column_id);
      let position = a.position;
      if (position === undefined || position === null) {
        const row = db.getDb().prepare('SELECT COUNT(*) AS n FROM cards WHERE column_id = ? AND archived = 0 AND id != ?').get(columnId, Number(a.card_id));
        position = row.n;
      }
      await api(ctx, 'PUT', `/api/cards/${Number(a.card_id)}/move`, { columnId, position });
      const d = cardDetails(Number(a.card_id));
      return { id: d.id, title: d.title, column: d.column, position: d.position };
    },

    async archive_card(ctx, a) {
      boardOfCard(ctx, a.card_id);
      await api(ctx, 'PUT', `/api/cards/${Number(a.card_id)}/archive`);
      return { ok: true, card_id: Number(a.card_id), archived: true };
    },

    async restore_card(ctx, a) {
      boardOfCard(ctx, a.card_id);
      await api(ctx, 'PUT', `/api/cards/${Number(a.card_id)}/restore`);
      return { ok: true, card_id: Number(a.card_id), archived: false };
    },

    async delete_card(ctx, a) {
      boardOfCard(ctx, a.card_id);
      await api(ctx, 'DELETE', `/api/cards/${Number(a.card_id)}`);
      return { ok: true, card_id: Number(a.card_id), deleted: true };
    },

    async add_comment(ctx, a) {
      boardOfCard(ctx, a.card_id);
      const c = await api(ctx, 'POST', `/api/cards/${Number(a.card_id)}/comments`, { text: a.text });
      return { id: c.id, card_id: Number(a.card_id), author: c.author, text: c.text, created_at: c.created_at };
    },

    async add_checklist_item(ctx, a) {
      boardOfCard(ctx, a.card_id);
      const item = await api(ctx, 'POST', `/api/cards/${Number(a.card_id)}/checklist`, { text: a.text });
      return { id: item.id, card_id: item.card_id, text: item.text, checked: !!item.checked };
    },

    async update_checklist_item(ctx, a) {
      boardOfChecklistItem(ctx, a.item_id);
      const body = {};
      if (a.checked !== undefined) body.checked = !!a.checked;
      if (a.text !== undefined) body.text = a.text;
      if (!Object.keys(body).length) throw new ToolError('checked oder text angeben');
      const item = await api(ctx, 'PATCH', `/api/checklist/${Number(a.item_id)}`, body);
      return { id: item.id, card_id: item.card_id, text: item.text, checked: !!item.checked };
    },

    async create_label(ctx, a) {
      const boardId = assertBoard(ctx, a.board_id);
      if (a.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(a.color)) throw new ToolError('color muss #rrggbb sein');
      const label = await api(ctx, 'POST', `/api/boards/${encodeURIComponent(boardId)}/labels`, { name: a.name, color: a.color });
      return { id: label.id, name: label.name, color: label.color, board_id: boardId };
    },

    async set_card_label(ctx, a) {
      await setLabel(ctx, a.card_id, a.label_id, !!a.remove);
      return { ok: true, card_id: Number(a.card_id), labels: db.getCardLabels(Number(a.card_id)).map(l => ({ id: l.id, name: l.name })) };
    },

    async set_card_assignee(ctx, a) {
      boardOfCard(ctx, a.card_id);
      const userId = assertId(a.user_id, 'user_id');
      await api(ctx, a.remove ? 'DELETE' : 'POST', `/api/cards/${Number(a.card_id)}/assignees/${userId}`);
      return { ok: true, card_id: Number(a.card_id), assignees: db.getCardAssignees(Number(a.card_id)).map(u => ({ id: u.id, username: u.username })) };
    },
  };

  async function setLabel(ctx, cardIdRaw, labelIdRaw, remove) {
    const boardId = boardOfCard(ctx, cardIdRaw);
    const labelId = assertId(labelIdRaw, 'label_id');
    const label = db.getDb().prepare('SELECT board_id FROM labels WHERE id = ?').get(labelId);
    if (!label || label.board_id !== boardId) throw new ToolError(`Label ${labelId} gehört nicht zu diesem Board`);
    await api(ctx, remove ? 'DELETE' : 'POST', `/api/cards/${Number(cardIdRaw)}/labels/${labelId}`);
  }

  // --- JSON-RPC dispatch ---
  function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  }

  async function callTool(ctx, params) {
    const name = params && params.name;
    const tool = TOOL_MAP.get(name);
    if (!tool) return { _rpcError: [-32602, `Unbekanntes Tool: ${name}`] };
    if (ctx.readOnly && !tool.read) {
      return { content: [{ type: 'text', text: 'Dieser Token ist nur lesend – schreibende Tools sind nicht erlaubt.' }], isError: true };
    }
    const args = (params.arguments && typeof params.arguments === 'object') ? params.arguments : {};
    try {
      const result = await handlers[name](ctx, args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false };
    } catch (e) {
      if (!(e instanceof ToolError)) console.error('[MCP] tool error', name, e);
      return { content: [{ type: 'text', text: `Fehler: ${e.message}` }], isError: true };
    }
  }

  async function handleMessage(ctx, msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      // Responses from the client (no method) need no answer
      if (msg && msg.jsonrpc === '2.0' && msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) return null;
      return rpcError(msg && msg.id, -32600, 'Invalid Request');
    }
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) return null;

    const { id, method, params } = msg;
    switch (method) {
      case 'initialize': {
        const requested = params && params.protocolVersion;
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, title: 'Kanban', version: SERVER_VERSION },
            instructions: INSTRUCTIONS,
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: publicToolList(ctx.readOnly) } };
      case 'tools/call': {
        const result = await callTool(ctx, params);
        if (result._rpcError) return rpcError(id, ...result._rpcError);
        return { jsonrpc: '2.0', id, result };
      }
      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: [] } };
      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: [] } };
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  router.post('/', async (req, res) => {
    const auth = authenticate(req);
    if (auth.error) {
      if (auth.status === 401) res.set('WWW-Authenticate', 'Bearer realm="kanban-mcp"');
      return res.status(auth.status).json(rpcError(null, -32001, auth.error));
    }
    const ctx = { ...auth, port: req.socket.localPort };
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json(rpcError(null, -32700, 'Parse error: JSON body expected'));
    }

    if (Array.isArray(body)) {
      const responses = (await Promise.all(body.map(m => handleMessage(ctx, m)))).filter(Boolean);
      if (!responses.length) return res.status(202).end();
      return res.json(responses);
    }
    const response = await handleMessage(ctx, body);
    if (!response) return res.status(202).end();
    res.json(response);
  });

  // Stateless server: no server-initiated SSE stream and no sessions to delete.
  router.all('/', (req, res) => {
    res.set('Allow', 'POST').status(405).json(rpcError(null, -32000, 'Method not allowed – use POST'));
  });

  return router;
}

module.exports = { createMcpRouter, TOOLS: TOOLS.map(t => ({ name: t.name, title: t.title, description: t.description, read: !!t.read })) };
