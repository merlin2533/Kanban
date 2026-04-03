'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');

/**
 * Start the Kanban server on a random free port using its own temp database.
 * Returns { baseUrl, closeServer }.
 */
async function startServer() {
  const dbId = crypto.randomBytes(6).toString('hex');
  const tmpDb = `/tmp/kanban-test-${dbId}.db`;

  process.env.DB_PATH = tmpDb;
  process.env.ADMIN_USER = 'admin';
  process.env.ADMIN_PASSWORD = 'adminpass';
  process.env.DEBUG_AUTH = '0';

  _clearModuleCache();

  let capturedServer = null;
  const origListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    capturedServer = this;
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
    return origListen.call(this, 0, cb || undefined);
  };

  require('../server');
  net.Server.prototype.listen = origListen;

  await new Promise((resolve, reject) => {
    if (!capturedServer) return reject(new Error('server.js did not call listen()'));
    if (capturedServer.listening) return resolve();
    capturedServer.once('listening', resolve);
    capturedServer.once('error', reject);
  });

  const { port } = capturedServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function closeServer() {
    await new Promise((resolve) => capturedServer.close(resolve));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch {}
    }
    _clearModuleCache();
  }

  return { baseUrl, closeServer };
}

function _clearModuleCache() {
  for (const key of Object.keys(require.cache)) {
    if (
      key.includes('/server') ||
      key.includes('/db') ||
      key.includes('/email') ||
      key.includes('better-sqlite3') ||
      key.includes('nanoid')
    ) {
      delete require.cache[key];
    }
  }
}

function request(method, url, { body, headers = {}, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqHeaders = { 'Content-Type': 'application/json', ...headers };
    if (cookie) reqHeaders['Cookie'] = cookie;

    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    if (payload) reqHeaders['Content-Length'] = Buffer.byteLength(payload);

    const opts = {
      method: method.toUpperCase(),
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: reqHeaders,
    };

    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        const ct = res.headers['content-type'] || '';
        let parsedBody;
        if (ct.includes('application/json')) {
          try { parsedBody = JSON.parse(raw); } catch { parsedBody = raw; }
        } else {
          parsedBody = raw;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsedBody });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function loginAsAdmin(baseUrl) {
  const res = await request('POST', `${baseUrl}/api/auth/login`, {
    body: { username: 'admin', password: 'adminpass' },
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (res.status !== 200) {
    throw new Error(`Admin login failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return extractSessionCookie(res.headers);
}

function extractSessionCookie(headers) {
  const setCookie = headers['set-cookie'];
  if (!setCookie) throw new Error('No Set-Cookie header in login response');
  const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
  const match = cookieStr.match(/kanban_session=([^;]+)/);
  if (!match) throw new Error('kanban_session cookie not found');
  return `kanban_session=${match[1]}`;
}

const CSRF = { 'X-Requested-With': 'XMLHttpRequest' };

const authGet = (base, path, cookie) =>
  request('GET', `${base}${path}`, { cookie });

const authPost = (base, path, body, cookie) =>
  request('POST', `${base}${path}`, { body, cookie, headers: CSRF });

const authPatch = (base, path, body, cookie) =>
  request('PATCH', `${base}${path}`, { body, cookie, headers: CSRF });

const authPut = (base, path, body, cookie) =>
  request('PUT', `${base}${path}`, { body, cookie, headers: CSRF });

const authDelete = (base, path, cookie) =>
  request('DELETE', `${base}${path}`, { cookie, headers: CSRF });

async function createBoard(base, cookie, title = 'Test Board') {
  const res = await authPost(base, '/api/boards', { title }, cookie);
  if (res.status !== 201) throw new Error(`createBoard failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function createCard(base, cookie, columnId, text = 'Test Card') {
  const res = await authPost(base, `/api/columns/${columnId}/cards`, { text }, cookie);
  if (res.status !== 201) throw new Error(`createCard failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

module.exports = {
  startServer,
  request,
  loginAsAdmin,
  extractSessionCookie,
  authGet,
  authPost,
  authPatch,
  authPut,
  authDelete,
  createBoard,
  createCard,
};
