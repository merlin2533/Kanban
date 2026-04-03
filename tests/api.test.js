'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer, loginAsAdmin,
  authGet, authPost, authPut, authPatch, authDelete,
  createBoard, createCard,
} = require('./helpers');

let base, cookie, close;

describe('Kanban API', () => {

  before(async () => {
    const srv = await startServer();
    base = srv.baseUrl;
    close = srv.closeServer;
    cookie = await loginAsAdmin(base);
  });

  after(async () => {
    await close();
  });

  // ── Auth ──────────────────────────────────────────────────────

  describe('Auth', () => {
    it('GET /api/auth/me returns user when logged in', async () => {
      const res = await authGet(base, '/api/auth/me', cookie);
      assert.equal(res.status, 200);
      assert.equal(res.body.user.username, 'admin');
    });

    it('GET /api/auth/me returns 401 without cookie', async () => {
      const res = await authGet(base, '/api/auth/me', null);
      assert.equal(res.status, 401);
    });

    it('POST /api/auth/login fails with wrong password', async () => {
      const res = await authPost(base, '/api/auth/login', { username: 'admin', password: 'wrong' }, null);
      assert.equal(res.status, 401);
    });

    it('POST /api/auth/login succeeds with correct password', async () => {
      const res = await authPost(base, '/api/auth/login', { username: 'admin', password: 'adminpass' }, null);
      assert.equal(res.status, 200);
      assert.ok(res.body.user);
    });
  });

  // ── Boards ────────────────────────────────────────────────────

  describe('Boards', () => {
    let boardId;

    it('POST /api/boards creates a board', async () => {
      const res = await authPost(base, '/api/boards', { title: 'Test Board' }, cookie);
      assert.equal(res.status, 201);
      assert.ok(res.body.id);
      boardId = res.body.id;
    });

    it('GET /api/boards lists boards', async () => {
      const res = await authGet(base, '/api/boards', cookie);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.length >= 1);
    });

    it('GET /api/boards/:id returns board with columns', async () => {
      const res = await authGet(base, `/api/boards/${boardId}`, cookie);
      assert.equal(res.status, 200);
      assert.equal(res.body.id, boardId);
      assert.ok(Array.isArray(res.body.columns));
    });

    it('PATCH /api/boards/:id updates title', async () => {
      const res = await authPatch(base, `/api/boards/${boardId}`, { title: 'Updated Title' }, cookie);
      assert.equal(res.status, 200);
    });

    it('DELETE /api/boards/:id deletes board', async () => {
      const b = await createBoard(base, cookie, 'To Delete');
      const res = await authDelete(base, `/api/boards/${b.id}`, cookie);
      assert.equal(res.status, 200);
    });
  });

  // ── Columns ───────────────────────────────────────────────────

  describe('Columns', () => {
    let boardId, colId;

    before(async () => {
      const b = await createBoard(base, cookie, 'Col Test');
      boardId = b.id;
    });

    it('POST /api/boards/:id/columns creates a column', async () => {
      const res = await authPost(base, `/api/boards/${boardId}/columns`, { title: 'New Col' }, cookie);
      assert.equal(res.status, 201);
      assert.ok(res.body.id);
      colId = res.body.id;
    });

    it('PATCH /api/columns/:id updates column', async () => {
      const res = await authPatch(base, `/api/columns/${colId}`, { title: 'Renamed' }, cookie);
      assert.equal(res.status, 200);
    });

    it('DELETE /api/columns/:id deletes column', async () => {
      const res2 = await authPost(base, `/api/boards/${boardId}/columns`, { title: 'Temp' }, cookie);
      const res = await authDelete(base, `/api/columns/${res2.body.id}`, cookie);
      assert.equal(res.status, 200);
    });
  });

  // ── Cards ─────────────────────────────────────────────────────

  describe('Cards', () => {
    let boardId, colId, cardId;

    before(async () => {
      const b = await createBoard(base, cookie, 'Card Test');
      boardId = b.id;
      const board = await authGet(base, `/api/boards/${boardId}`, cookie);
      colId = board.body.columns[0].id;
    });

    it('POST /api/columns/:id/cards creates a card', async () => {
      const res = await authPost(base, `/api/columns/${colId}/cards`, { text: 'Card 1' }, cookie);
      assert.equal(res.status, 201);
      cardId = res.body.id || res.body.card?.id;
      assert.ok(cardId);
    });

    it('PATCH /api/cards/:id updates card text', async () => {
      const res = await authPatch(base, `/api/cards/${cardId}`, { text: 'Updated Card' }, cookie);
      assert.equal(res.status, 200);
    });

    it('PUT /api/cards/:id/archive archives card', async () => {
      const c = await createCard(base, cookie, colId, 'To Archive');
      const cId = c.id || c.card?.id;
      const res = await authPut(base, `/api/cards/${cId}/archive`, {}, cookie);
      assert.equal(res.status, 200);
    });

    it('DELETE /api/cards/:id deletes card', async () => {
      const c = await createCard(base, cookie, colId, 'To Delete');
      const cId = c.id || c.card?.id;
      const res = await authDelete(base, `/api/cards/${cId}`, cookie);
      assert.equal(res.status, 200);
    });
  });

  // ── Checklists ────────────────────────────────────────────────

  describe('Checklists', () => {
    let cardId, checkId;

    before(async () => {
      const b = await createBoard(base, cookie, 'Checklist Test');
      const board = await authGet(base, `/api/boards/${b.id}`, cookie);
      const c = await createCard(base, cookie, board.body.columns[0].id, 'CL Card');
      cardId = c.id || c.card?.id;
    });

    it('POST creates checklist item', async () => {
      const res = await authPost(base, `/api/cards/${cardId}/checklist`, { text: 'Item 1' }, cookie);
      assert.equal(res.status, 201);
      assert.ok(res.body.id);
      checkId = res.body.id;
    });

    it('PATCH toggles checklist item', async () => {
      const res = await authPatch(base, `/api/checklist/${checkId}`, { checked: true }, cookie);
      assert.equal(res.status, 200);
    });

    it('DELETE removes checklist item', async () => {
      const res = await authDelete(base, `/api/checklist/${checkId}`, cookie);
      assert.equal(res.status, 200);
    });
  });

  // ── Labels ────────────────────────────────────────────────────

  describe('Labels', () => {
    let boardId, labelId, cardId;

    before(async () => {
      const b = await createBoard(base, cookie, 'Label Test');
      boardId = b.id;
      const board = await authGet(base, `/api/boards/${boardId}`, cookie);
      const c = await createCard(base, cookie, board.body.columns[0].id, 'Label Card');
      cardId = c.id || c.card?.id;
    });

    it('POST creates label', async () => {
      const res = await authPost(base, `/api/boards/${boardId}/labels`, { name: 'Bug', color: '#ef4444' }, cookie);
      assert.equal(res.status, 201);
      assert.ok(res.body.id);
      labelId = res.body.id;
    });

    it('POST assigns label to card', async () => {
      const res = await authPost(base, `/api/cards/${cardId}/labels/${labelId}`, {}, cookie);
      assert.equal(res.status, 200);
    });

    it('DELETE removes label from card', async () => {
      const res = await authDelete(base, `/api/cards/${cardId}/labels/${labelId}`, cookie);
      assert.equal(res.status, 200);
    });
  });

  // ── Comments ──────────────────────────────────────────────────

  describe('Comments', () => {
    let cardId;

    before(async () => {
      const b = await createBoard(base, cookie, 'Comment Test');
      const board = await authGet(base, `/api/boards/${b.id}`, cookie);
      const c = await createCard(base, cookie, board.body.columns[0].id, 'Cmt Card');
      cardId = c.id || c.card?.id;
    });

    it('POST creates comment', async () => {
      const res = await authPost(base, `/api/cards/${cardId}/comments`, { text: 'Hello!' }, cookie);
      assert.equal(res.status, 201);
      assert.ok(res.body.id);
    });

    it('GET lists comments', async () => {
      const res = await authGet(base, `/api/cards/${cardId}/comments`, cookie);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.comments || res.body));
    });
  });

  // ── Search ────────────────────────────────────────────────────

  describe('Search', () => {
    let boardId;

    before(async () => {
      const b = await createBoard(base, cookie, 'Search Test');
      boardId = b.id;
      const board = await authGet(base, `/api/boards/${boardId}`, cookie);
      await createCard(base, cookie, board.body.columns[0].id, 'Findable Item');
    });

    it('GET /api/boards/:id/search finds cards', async () => {
      const res = await authGet(base, `/api/boards/${boardId}/search?q=Findable`, cookie);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.length >= 1);
    });

    it('GET /api/boards/:id/search returns empty for no match', async () => {
      const res = await authGet(base, `/api/boards/${boardId}/search?q=xyznonexistent`, cookie);
      assert.equal(res.status, 200);
      assert.equal(res.body.length, 0);
    });
  });

  // ── Card Dependencies ─────────────────────────────────────────

  describe('Card Dependencies', () => {
    let cardA, cardB;

    before(async () => {
      const b = await createBoard(base, cookie, 'Dep Test');
      const board = await authGet(base, `/api/boards/${b.id}`, cookie);
      const cA = await createCard(base, cookie, board.body.columns[0].id, 'Card A');
      const cB = await createCard(base, cookie, board.body.columns[0].id, 'Card B');
      cardA = cA.id || cA.card?.id;
      cardB = cB.id || cB.card?.id;
    });

    it('POST creates dependency', async () => {
      const res = await authPost(base, `/api/cards/${cardA}/dependencies`, { blocking_card_id: cardB }, cookie);
      assert.equal(res.status, 200);
      assert.ok(res.body.ok);
    });

    it('GET lists dependencies', async () => {
      const res = await authGet(base, `/api/cards/${cardA}/dependencies`, cookie);
      assert.equal(res.status, 200);
    });
  });

  // ── Audit Log ─────────────────────────────────────────────────

  describe('Audit Log', () => {
    it('GET /api/admin/audit-log returns paginated log', async () => {
      const res = await authGet(base, '/api/admin/audit-log', cookie);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.items));
      assert.ok(typeof res.body.total === 'number');
    });

    it('GET /api/admin/audit-log/export returns CSV', async () => {
      const res = await authGet(base, '/api/admin/audit-log/export', cookie);
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/csv'));
    });
  });

  // ── Notification Prefs ────────────────────────────────────────

  describe('Notification Preferences', () => {
    it('GET /api/me/notification-prefs returns prefs', async () => {
      const res = await authGet(base, '/api/me/notification-prefs', cookie);
      assert.equal(res.status, 200);
    });
  });

  // ── Board Export/Import ───────────────────────────────────────

  describe('Export/Import', () => {
    let boardId;

    before(async () => {
      const b = await createBoard(base, cookie, 'Export Test');
      boardId = b.id;
    });

    it('GET /api/boards/:id/export returns board data', async () => {
      const res = await authGet(base, `/api/boards/${boardId}/export`, cookie);
      assert.equal(res.status, 200);
      assert.ok(res.body.title);
      assert.ok(res.body.columns);
    });

    it('POST /api/boards/import creates board from exported data', async () => {
      const exp = await authGet(base, `/api/boards/${boardId}/export`, cookie);
      const res = await authPost(base, '/api/boards/import', exp.body, cookie);
      assert.equal(res.status, 201);
    });
  });

});
