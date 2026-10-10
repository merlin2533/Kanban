'use strict';

// Non-admin users (and access links) must only reach cards, columns, labels,
// checklists, comments, … of boards they have access to.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer, loginAsAdmin, request, extractSessionCookie,
  authGet, authPost, authPut, authPatch, authDelete,
  createBoard, createCard,
} = require('./helpers');

let base, admin, close;

async function login(username, password) {
  const res = await request('POST', `${base}/api/auth/login`, {
    body: { username, password }, headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return extractSessionCookie(res.headers);
}

describe('Board access checks', () => {
  let user;          // session cookie of a non-admin member of board A only
  let A, B;          // boards
  let cardA, cardB, colA, colB, labelA, labelB, itemB, commentB, attB, tmplB;

  before(async () => {
    const srv = await startServer();
    base = srv.baseUrl;
    close = srv.closeServer;
    admin = await loginAsAdmin(base);
    const db = require('../db');

    A = await createBoard(base, admin, 'Board A');
    B = await createBoard(base, admin, 'Board B');
    colA = A.columns[0].id;
    colB = B.columns[0].id;
    cardA = (await createCard(base, admin, colA, 'Karte A')).id;
    cardB = (await createCard(base, admin, colB, 'Karte B')).id;
    labelA = (await authPost(base, `/api/boards/${A.id}/labels`, { name: 'LA' }, admin)).body.id;
    labelB = (await authPost(base, `/api/boards/${B.id}/labels`, { name: 'LB' }, admin)).body.id;
    itemB = (await authPost(base, `/api/cards/${cardB}/checklist`, { text: 'Punkt' }, admin)).body.id;
    commentB = (await authPost(base, `/api/cards/${cardB}/comments`, { text: 'Geheim' }, admin)).body.id;
    attB = db.createAttachment(cardB, { originalname: 'x.txt', mimetype: 'text/plain', size: 3, buffer: Buffer.from('abc') }).id;
    tmplB = (await authPost(base, `/api/boards/${B.id}/card-templates`, { name: 'T', text_template: 'x' }, admin)).body.id;

    const u = await authPost(base, '/api/admin/users', { username: 'member', password: 'secret12' }, admin);
    await authPost(base, `/api/boards/${A.id}/members`, { user_id: u.body.id }, admin);
    user = await login('member', 'secret12');
  });

  after(async () => { await close(); });

  it('member can still work on their own board', async () => {
    assert.equal((await authPatch(base, `/api/cards/${cardA}`, { text: 'A neu' }, user)).status, 200);
    assert.equal((await authGet(base, `/api/cards/${cardA}/comments`, user)).status, 200);
    assert.equal((await authPost(base, `/api/cards/${cardA}/labels/${labelA}`, {}, user)).status, 200);
    assert.equal((await authPost(base, `/api/columns/${colA}/cards`, { text: 'Neu' }, user)).status, 201);
    assert.equal((await authPost(base, `/api/boards/${A.id}/columns`, { title: 'Spalte' }, user)).status, 201);
  });

  const forbidden = [
    ['GET card comments',      () => authGet(base, `/api/cards/${cardB}/comments`, user)],
    ['GET card checklist',     () => authGet(base, `/api/cards/${cardB}/checklist`, user)],
    ['GET card dependencies',  () => authGet(base, `/api/cards/${cardB}/dependencies`, user)],
    ['GET card watchers',      () => authGet(base, `/api/cards/${cardB}/watchers`, user)],
    ['PATCH card',             () => authPatch(base, `/api/cards/${cardB}`, { text: 'gehackt' }, user)],
    ['DELETE card',            () => authDelete(base, `/api/cards/${cardB}`, user)],
    ['PUT card move',          () => authPut(base, `/api/cards/${cardB}/move`, { columnId: colB, position: 0 }, user)],
    ['POST log-time',          () => authPost(base, `/api/cards/${cardB}/log-time`, { minutes: 5 }, user)],
    ['POST comment',           () => authPost(base, `/api/cards/${cardB}/comments`, { text: 'x' }, user)],
    ['POST checklist item',    () => authPost(base, `/api/cards/${cardB}/checklist`, { text: 'x' }, user)],
    ['PATCH checklist item',   () => authPatch(base, `/api/checklist/${itemB}`, { checked: true }, user)],
    ['DELETE checklist item',  () => authDelete(base, `/api/checklist/${itemB}`, user)],
    ['PATCH comment',          () => authPatch(base, `/api/comments/${commentB}`, { text: 'x' }, user)],
    ['DELETE comment',         () => authDelete(base, `/api/comments/${commentB}`, user)],
    ['POST column card',       () => authPost(base, `/api/columns/${colB}/cards`, { text: 'x' }, user)],
    ['PATCH column',           () => authPatch(base, `/api/columns/${colB}`, { title: 'x' }, user)],
    ['DELETE column',          () => authDelete(base, `/api/columns/${colB}`, user)],
    ['POST board column',      () => authPost(base, `/api/boards/${B.id}/columns`, { title: 'x' }, user)],
    ['POST board label',       () => authPost(base, `/api/boards/${B.id}/labels`, { name: 'x' }, user)],
    ['PATCH label',            () => authPatch(base, `/api/labels/${labelB}`, { name: 'x' }, user)],
    ['DELETE label',           () => authDelete(base, `/api/labels/${labelB}`, user)],
    ['label from other board', () => authPost(base, `/api/cards/${cardA}/labels/${labelB}`, {}, user)],
    ['GET attachment',         () => authGet(base, `/api/attachments/${attB}`, user)],
    ['DELETE attachment',      () => authDelete(base, `/api/attachments/${attB}`, user)],
    ['GET card templates',     () => authGet(base, `/api/boards/${B.id}/card-templates`, user)],
    ['DELETE card template',   () => authDelete(base, `/api/card-templates/${tmplB}`, user)],
    ['card from foreign tmpl', () => authPost(base, `/api/columns/${colA}/cards/from-template`, { templateId: tmplB }, user)],
    ['dependency on foreign',  () => authPost(base, `/api/cards/${cardA}/dependencies`, { blocking_card_id: cardB }, user)],
  ];

  for (const [name, call] of forbidden) {
    it(`denies ${name} on a foreign board`, async () => {
      const res = await call();
      assert.ok(res.status === 403 || res.status === 400, `${name}: expected 403/400, got ${res.status}`);
    });
  }

  it('bulk actions ignore cards of other boards', async () => {
    const res = await authPost(base, `/api/boards/${A.id}/bulk`, { action: 'priority', priority: 'high', cardIds: [cardB] }, user);
    assert.equal(res.status, 400);
    const card = await authGet(base, `/api/boards/${B.id}`, admin);
    assert.notEqual(card.body.columns[0].cards.find(c => c.id === cardB).priority, 'high');
  });

  it('foreign board data is unchanged', async () => {
    const board = await authGet(base, `/api/boards/${B.id}`, admin);
    const card = board.body.columns[0].cards.find(c => c.id === cardB);
    assert.equal(card.text, 'Karte B');
    assert.equal(card.checklist.length, 1);
    assert.equal(card.checklist[0].checked, 0);
    assert.equal(card.comments.length, 1);
    assert.equal(board.body.labels.length, 1);
    assert.equal(board.body.columns.length, 3);
  });

  it('access links are limited to their own board', async () => {
    const link = await authPost(base, `/api/boards/${A.id}/access-links`, { permission: 'edit', label: 'Gast' }, admin);
    assert.equal(link.status, 201, JSON.stringify(link.body));
    const token = link.body.id;
    const own = await request('PATCH', `${base}/api/cards/${cardA}?token=${token}`, { body: { text: 'Gast war hier' } });
    assert.equal(own.status, 200);
    const foreign = await request('PATCH', `${base}/api/cards/${cardB}?token=${token}`, { body: { text: 'x' } });
    assert.equal(foreign.status, 403);
  });

  it('admins keep access to every board', async () => {
    assert.equal((await authPatch(base, `/api/cards/${cardB}`, { text: 'Karte B' }, admin)).status, 200);
    assert.equal((await authGet(base, `/api/attachments/${attB}`, admin)).status, 200);
  });
});
