'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer, loginAsAdmin, request,
  authGet, authPost, authPut, authDelete,
  createBoard,
} = require('./helpers');

let base, cookie, close;

function mcpCall(token, body) {
  return request('POST', `${base}/mcp`, {
    body,
    headers: token ? { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream' } : {},
  });
}

let rpcId = 0;
async function callTool(token, name, args = {}) {
  const res = await mcpCall(token, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const result = res.body.result;
  const text = result.content[0].text;
  let data = text;
  try { data = JSON.parse(text); } catch {}
  return { isError: result.isError, data, text };
}

describe('MCP server', () => {
  let adminToken, userToken, readToken, boardId, otherBoardId, todoColumnId, doneColumnId, userId;

  before(async () => {
    const srv = await startServer();
    base = srv.baseUrl;
    close = srv.closeServer;
    cookie = await loginAsAdmin(base);

    const board = await createBoard(base, cookie, 'MCP Board');
    boardId = board.id;
    todoColumnId = board.columns[0].id;
    doneColumnId = board.columns[2].id;
    otherBoardId = (await createBoard(base, cookie, 'Geheim')).id;

    const u = await authPost(base, '/api/admin/users', { username: 'mcpuser', password: 'secret12' }, cookie);
    userId = u.body.id;
    await authPost(base, `/api/boards/${boardId}/members`, { user_id: userId }, cookie);
  });

  after(async () => { await close(); });

  it('is disabled by default', async () => {
    const res = await authPost(base, '/api/admin/mcp/tokens', { name: 'Claude Code' }, cookie);
    assert.equal(res.status, 201);
    adminToken = res.body.token;
    assert.match(adminToken, /^kbn_/);
    const call = await mcpCall(adminToken, { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(call.status, 403);
  });

  it('admin can enable MCP and list tokens without exposing them', async () => {
    const res = await authPut(base, '/api/admin/mcp', { enabled: true }, cookie);
    assert.equal(res.status, 200);
    const info = await authGet(base, '/api/admin/mcp', cookie);
    assert.equal(info.body.enabled, true);
    assert.equal(info.body.tokens.length, 1);
    assert.equal(info.body.tokens[0].token, undefined);
    assert.equal(info.body.tokens[0].token_hash, undefined);
    assert.ok(info.body.tools.some(t => t.name === 'create_card'));

    userToken = (await authPost(base, '/api/admin/mcp/tokens', { name: 'User', user_id: userId }, cookie)).body.token;
    readToken = (await authPost(base, '/api/admin/mcp/tokens', { name: 'Read', read_only: true }, cookie)).body.token;
  });

  it('rejects missing and invalid tokens', async () => {
    const none = await mcpCall(null, { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(none.status, 401);
    assert.ok(none.headers['www-authenticate']);
    const bad = await mcpCall('kbn_invalid', { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(bad.status, 401);
  });

  it('handles initialize, notifications and tools/list', async () => {
    const init = await mcpCall(adminToken, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.ok(init.body.result.capabilities.tools);

    const notif = await mcpCall(adminToken, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notif.status, 202);

    const list = await mcpCall(adminToken, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.body.result.tools.map(t => t.name);
    assert.ok(names.includes('get_board'));
    assert.ok(names.includes('move_card'));

    const roList = await mcpCall(readToken, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.ok(roList.body.result.tools.every(t => t.annotations.readOnlyHint));

    const unknown = await mcpCall(adminToken, { jsonrpc: '2.0', id: 4, method: 'foo/bar' });
    assert.equal(unknown.body.error.code, -32601);

    const get = await request('GET', `${base}/mcp`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(get.status, 405);
  });

  it('creates, updates, moves and comments on cards', async () => {
    const created = await callTool(adminToken, 'create_card', {
      column_id: todoColumnId, title: 'Von Claude', description: 'Details', priority: 'high', due_date: '2026-12-01',
    });
    assert.equal(created.isError, false, created.text);
    assert.equal(created.data.title, 'Von Claude');
    assert.equal(created.data.priority, 'high');
    assert.equal(created.data.description, 'Details');
    const cardId = created.data.id;

    const upd = await callTool(adminToken, 'update_card', { card_id: cardId, title: 'Umbenannt', priority: null });
    assert.equal(upd.data.title, 'Umbenannt');
    assert.equal(upd.data.priority, null);

    const moved = await callTool(adminToken, 'move_card', { card_id: cardId, column_id: doneColumnId });
    assert.equal(moved.isError, false, moved.text);
    assert.equal(moved.data.column.id, doneColumnId);

    const comment = await callTool(adminToken, 'add_comment', { card_id: cardId, text: 'Erledigt' });
    assert.equal(comment.data.author, 'admin');

    const item = await callTool(adminToken, 'add_checklist_item', { card_id: cardId, text: 'Schritt 1' });
    const checked = await callTool(adminToken, 'update_checklist_item', { item_id: item.data.id, checked: true });
    assert.equal(checked.data.checked, true);

    const board = await callTool(adminToken, 'get_board', { board_id: boardId });
    const done = board.data.columns.find(c => c.id === doneColumnId);
    const card = done.cards.find(c => c.id === cardId);
    assert.equal(card.checklist, '1/1');
    assert.equal(card.comment_count, 1);

    const found = await callTool(adminToken, 'search_cards', { board_id: boardId, query: 'Umbenannt' });
    assert.ok(found.data.some(c => c.id === cardId));

    const archived = await callTool(adminToken, 'archive_card', { card_id: cardId });
    assert.equal(archived.isError, false);
    const list = await callTool(adminToken, 'list_archived_cards', { board_id: boardId });
    assert.ok(list.data.some(c => c.id === cardId));
  });

  it('manages labels and assignees', async () => {
    const label = await callTool(adminToken, 'create_label', { board_id: boardId, name: 'Bug', color: '#ff0000' });
    assert.equal(label.isError, false, label.text);
    const card = await callTool(adminToken, 'create_card', {
      column_id: todoColumnId, title: 'Mit Label', label_ids: [label.data.id], assignee_ids: [userId],
    });
    assert.equal(card.data.warnings, undefined, JSON.stringify(card.data.warnings));
    assert.deepEqual(card.data.labels.map(l => l.name), ['Bug']);
    assert.deepEqual(card.data.assignees.map(a => a.username), ['mcpuser']);

    const members = await callTool(adminToken, 'list_board_members', { board_id: boardId });
    assert.ok(members.data.some(m => m.username === 'mcpuser'));

    const removed = await callTool(adminToken, 'set_card_assignee', { card_id: card.data.id, user_id: userId, remove: true });
    assert.deepEqual(removed.data.assignees, []);
  });

  it("a user's token only sees that user's boards", async () => {
    const boards = await callTool(userToken, 'list_boards');
    assert.deepEqual(boards.data.map(b => b.id), [boardId]);

    const denied = await callTool(userToken, 'get_board', { board_id: otherBoardId });
    assert.equal(denied.isError, true);

    const ok = await callTool(userToken, 'create_card', { column_id: todoColumnId, title: 'Von mcpuser' });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(ok.data.created_by, 'mcpuser');
  });

  it('read-only tokens cannot write', async () => {
    const res = await callTool(readToken, 'create_card', { column_id: todoColumnId, title: 'Nope' });
    assert.equal(res.isError, true);
    const read = await callTool(readToken, 'get_board', { board_id: boardId });
    assert.equal(read.isError, false);

    const rest = await request('POST', `${base}/api/boards`, { body: { title: 'x' }, headers: { Authorization: `Bearer ${readToken}` } });
    assert.equal(rest.status, 403);
  });

  it('tokens cannot reach admin endpoints', async () => {
    const res = await request('GET', `${base}/api/admin/users`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(res.status, 403);
  });

  it('revoked tokens stop working', async () => {
    const info = await authGet(base, '/api/admin/mcp', cookie);
    const t = info.body.tokens.find(x => x.name === 'User');
    const del = await authDelete(base, `/api/admin/mcp/tokens/${t.id}`, cookie);
    assert.equal(del.status, 200);
    const call = await mcpCall(userToken, { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(call.status, 401);
  });
});
