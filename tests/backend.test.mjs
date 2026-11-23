import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { localUrl } from '../lib/controller.mjs';
import { GPT_DOMAINS } from '../lib/regions.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const group = '通用选择 🚀';
const nodeA = '🇯🇵日本-2';
const nodeB = '🇺🇸美国西雅图-1';
const outsider = '组外节点 🚫';
const fixtureToken = 'fixture-controller-key-do-not-export';
const hidden = ['fixture-node-password', 'fixture-private-server.example',
  'fixture-private-uuid', 'fixture-process-path', 'fixture-provider-secret',
  'fixture-ciphertext', fixtureToken];
let temp, mock, child, base, controllerUrl, csrf, selected = nodeA;
let refuseSwitch = false;
let switchGate = null;
let reconnectFixture = null;
const calls = [];

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
function proxies() {
  return {
    GLOBAL: { type: 'Selector', now: group, all: [group, 'DIRECT'] },
    [group]: { type: 'Selector', now: selected, all: [nodeA, nodeB, 'DIRECT'] },
    [nodeA]: { type: 'Trojan', server: hidden[1], password: hidden[0], uuid: hidden[2],
      history: [{ time: '2026-11-15T21:00:00Z', delay: 499 }] },
    [nodeB]: { type: 'Trojan', password: hidden[0], history: [{ delay: 2021 }] },
    [outsider]: { type: 'Trojan', password: hidden[0], history: [] },
    DIRECT: { type: 'Direct' },
    ...(reconnectFixture ? { ChatGPT: { type: 'Selector', now: nodeB, all: [nodeA, nodeB] } } : {})
  };
}
async function reservePort() {
  const s = http.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const port = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return port;
}
async function panel(endpoint, { method = 'GET', data, headers = {} } = {}) {
  const response = await fetch(base + endpoint, {
    method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(20000),
  });
  return { code: response.status, body: await response.json() };
}
function mutationHeaders(origin = base) {
  return { Origin: origin, 'X-Panel-Request': '1', 'X-CSRF-Token': csrf };
}
function writeCalls() { return calls.filter(c => c.method !== 'GET'); }

before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'network-panel-test-'));
  mock = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    calls.push({ method: req.method, pathname, body, authorization: req.headers.authorization });
    if (req.headers.authorization !== 'Bearer ' + fixtureToken) return json(res, 401, { error: 'fixture auth required' });
    if (req.method === 'GET' && pathname === '/version') return json(res, 200, { version: 'fixture-legacy-1.0', meta: false });
    if (req.method === 'GET' && pathname === '/configs') return json(res, 200, { port: 1975, mode: 'rule', secret: fixtureToken });
    if (req.method === 'GET' && pathname === '/proxies') return json(res, 200, { proxies: proxies(), private: hidden[4] });
    if (req.method === 'GET' && pathname === '/rules') return json(res, 200, {
      rules: reconnectFixture ? GPT_DOMAINS.map(payload => ({ type: 'DomainSuffix', payload, proxy: 'ChatGPT' })) :
        [{ type: 'DomainSuffix', payload: 'chatgpt.com', proxy: nodeA }]
    });
    if (req.method === 'GET' && pathname === '/connections') return json(res, 200, {
      uploadTotal: 10000, downloadTotal: 20000,
      connections: reconnectFixture ? [...reconnectFixture.values()] : [{ metadata: { host: 'chatgpt.com', processPath: hidden[3], password: hidden[0] },
        id: 'fixture-private-connection-id', chains: [nodeA, group], rulePayload: 'chatgpt.com' }],
    });
    if (reconnectFixture && pathname.startsWith('/connections/') && req.method === 'DELETE') {
      const id = pathname.slice('/connections/'.length);
      const connection = reconnectFixture.get(id);
      if (!connection || id === 'already-ended') {
        reconnectFixture.delete(id);
        return json(res, 404, { error: 'ended before deletion' });
      }
      reconnectFixture.delete(id);
      reconnectFixture.set(id + '-new', { ...connection, id: id + '-new', chains: [nodeB, 'ChatGPT'] });
      res.writeHead(204); return res.end();
    }
    if (pathname === '/proxies/' + group && req.method === 'PUT') {
      const input = JSON.parse(body);
      if (switchGate) await switchGate;
      if (!refuseSwitch) selected = input.name;
      res.writeHead(204); return res.end();
    }
    if (pathname === '/proxies/' + group && req.method === 'GET') return json(res, 200, proxies()[group]);
    if (req.method === 'GET' && pathname.startsWith('/proxies/') && pathname.endsWith('/delay')) {
      const name = pathname.slice('/proxies/'.length, -'/delay'.length);
      if (!proxies()[name] || proxies()[name].all) return json(res, 400, { error: 'fixture leaf only' });
      assert.equal(url.searchParams.get('url'), 'https://chatgpt.com/cdn-cgi/trace');
      return json(res, 200, { delay: 321 });
    }
    return json(res, 404, { error: 'fixture unsupported path' });
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  controllerUrl = `http://127.0.0.1:${mock.address().port}`;
  const state = path.join(temp, 'state');
  await fs.mkdir(state);
  await fs.writeFile(path.join(state, 'settings.json'), JSON.stringify({ controllerUrl, encryptedToken: hidden[5] }));
  const panelPort = await reservePort();
  base = `http://127.0.0.1:${panelPort}`;
  const overrides = {
    PANEL_PORT: String(panelPort), PANEL_STATE_DIR: state, PANEL_CONTROLLER_TOKEN: fixtureToken,
    USERPROFILE: path.join(temp, 'profile'), APPDATA: path.join(temp, 'appdata'),
    LOCALAPPDATA: path.join(temp, 'localappdata'), ProgramFiles: path.join(temp, 'programs'),
    'ProgramFiles(x86)': path.join(temp, 'programs-x86'), ProgramData: path.join(temp, 'programdata'),
  };
  const overridden = new Set(Object.keys(overrides).map(k => k.toLowerCase()));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !overridden.has(k.toLowerCase())));
  let output = '';
  child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root, env: { ...env, ...overrides }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const deadline = Date.now() + 15000;
  while (true) {
    try { const r = await panel('/api/health'); assert.equal(r.code, 200); break; }
    catch (e) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error('Test panel did not start: ' + output, { cause: e });
      await new Promise(resolve => setTimeout(resolve, 75));
    }
  }
  const status = await panel('/api/status');
  assert.equal(status.code, 200); assert.equal(status.body.controller.connected, true);
  csrf = status.body.csrfToken; assert.equal(typeof csrf, 'string');
}, { timeout: 30000 });

after(async () => {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (mock) {
    mock.closeAllConnections();
    await new Promise(resolve => mock.close(resolve));
  }
  if (temp) await fs.rm(temp, { recursive: true, force: true });
});

test('controller URL is limited to local HTTP without credentials or extra URL components', () => {
  for (const accepted of ['http://127.0.0.1:1978', 'http://localhost:9090/', 'http://[::1]:9090']) assert.doesNotThrow(() => localUrl(accepted));
  for (const rejected of ['https://127.0.0.1:1978', 'http://192.168.1.1:1978', 'http://8.8.8.8',
    'http://example.com', 'http://localhost.evil.example', 'http://user:secret@127.0.0.1:1978',
    'http://127.0.0.1:1978/path', 'http://127.0.0.1:1978/?secret=x', 'http://127.0.0.1:1978/#fragment']) {
    assert.throws(() => localUrl(rejected), undefined, rejected);
  }
});

test('status presents connection and Chinese node names without exporting raw secrets', async () => {
  const { code, body } = await panel('/api/status');
  assert.equal(code, 200); assert.equal(body.controller.connected, true);
  assert.equal(body.general.group, group); assert.equal(body.general.effectiveNode, selected);
  assert(body.nodes.some(n => n.name === nodeA && n.delay === 499));
  assert(!body.nodes.some(n => n.name === 'DIRECT'));
  assert.deepEqual(body.openai.live, [{ node: nodeA, count: 1 }]);
  assert.equal(body.settings.tokenConfigured, true);
  const text = JSON.stringify(body);
  for (const value of hidden) assert(!text.includes(value), `Status leaked ${value}`);
  assert(!text.includes('fixture-private-connection-id'));
  assert(calls.some(c => c.authorization === 'Bearer ' + fixtureToken));
});

test('hostile origins and missing CSRF are rejected before system-proxy or settings operations', async () => {
  const beforeWrites = writeCalls().length;
  const hostile = await panel('/api/system-proxy', {
    method: 'POST', data: { enabled: false }, headers: mutationHeaders('https://hostile.example'),
  });
  assert.equal(hostile.code, 403);
  const noCsrf = await panel('/api/settings', { method: 'POST', data: { controllerUrl } });
  assert.equal(noCsrf.code, 403);
  assert.equal(writeCalls().length, beforeWrites);
});

test('unknown nodes and existing non-members cannot produce a controller PUT', async () => {
  const beforeWrites = writeCalls().length;
  for (const node of ['不存在的线路', outsider]) {
    const r = await panel('/api/select', { method: 'POST', data: { scope: 'general', node }, headers: mutationHeaders() });
    assert.equal(r.code, 400);
  }
  assert.equal(writeCalls().length, beforeWrites);
});

test('general switch URL-encodes the Chinese/emoji selector and verifies the chosen member', async () => {
  const r = await panel('/api/select', { method: 'POST', data: { scope: 'general', node: nodeB }, headers: mutationHeaders() });
  assert.equal(r.code, 200); assert.equal(r.body.ok, true); assert.equal(selected, nodeB);
  const put = writeCalls().at(-1);
  assert.equal(put.pathname, '/proxies/' + group); assert.deepEqual(JSON.parse(put.body), { name: nodeB });
  const status = await panel('/api/status'); assert.equal(status.body.general.effectiveNode, nodeB);
});

test('a controller that does not confirm the change is reported as failure', async () => {
  refuseSwitch = true;
  try {
    const r = await panel('/api/select', { method: 'POST', data: { scope: 'general', node: nodeA }, headers: mutationHeaders() });
    assert.equal(r.code, 400); assert.match(r.body.error, /没有确认/); assert.equal(selected, nodeB);
  } finally { refuseSwitch = false; }
});

test('two requests that start streaming together cannot overlap controller mutations', async () => {
  let release;
  switchGate = new Promise(resolve => { release = resolve; });
  const openRequest = () => {
    const payload = JSON.stringify({ scope: 'general', node: nodeB });
    let request;
    const result = new Promise((resolve, reject) => {
      request = http.request(base + '/api/select', {
        method: 'POST', headers: { ...mutationHeaders(), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, res => {
        let bytes = '';
        res.on('data', chunk => { bytes += chunk; });
        res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(bytes) }));
      });
      request.on('error', reject);
      request.write(payload.slice(0, 1));
    });
    return { request, result, finish: () => request.end(payload.slice(1)) };
  };
  const start = writeCalls().length;
  const first = openRequest();
  await new Promise(resolve => setTimeout(resolve, 40));
  const second = openRequest();
  await new Promise(resolve => setTimeout(resolve, 40));
  try {
    first.finish();
    const deadline = Date.now() + 3000;
    while (writeCalls().length === start && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(writeCalls().length, start + 1, 'first mock mutation reached the held controller');
    second.finish();
    await new Promise(resolve => setTimeout(resolve, 100));
  } finally { switchGate = null; release(); }
  const results = await Promise.all([first.result, second.result]);
  assert.deepEqual(results.map(r => r.code), [200, 409]);
  assert.equal(writeCalls().length, start + 1, 'only one controller write was allowed');
});

test('leaf latency testing encodes emoji names and never invokes the mutable group-delay endpoint', async () => {
  const start = calls.length;
  const r = await panel('/api/test', { method: 'POST', data: { nodes: [nodeA, nodeB] }, headers: mutationHeaders() });
  assert.equal(r.code, 200); assert.equal(r.body.results.length, 2);
  assert(r.body.results.every(n => n.delay === 321));
  assert(!calls.slice(start).some(c => c.pathname.startsWith('/group/')));
  assert.deepEqual(calls.slice(start).filter(c => c.pathname.endsWith('/delay')).map(c => c.pathname).sort(),
    [nodeA, nodeB].map(n => '/proxies/' + n + '/delay').sort());
});

test('settings reject public URLs, embedded passwords, and malformed tokens without persisting', async () => {
  const settingsPath = path.join(temp, 'state/settings.json');
  const original = await fs.readFile(settingsPath, 'utf8');
  for (const input of [
    { controllerUrl: 'http://8.8.8.8:9090' },
    { controllerUrl: 'http://user:password@127.0.0.1:9090' },
    { controllerUrl, token: 'invalid\r\nheader' },
    { controllerUrl, token: 'x'.repeat(4097) },
  ]) {
    const r = await panel('/api/settings', { method: 'POST', data: input, headers: mutationHeaders() });
    assert.equal(r.code, 400);
    assert.equal(await fs.readFile(settingsPath, 'utf8'), original);
  }
});

test('empty token leaves the configured token intact and exposes only tokenConfigured', async () => {
  const r = await panel('/api/settings', { method: 'POST', data: { controllerUrl, token: '' }, headers: mutationHeaders() });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.settings, { controllerUrl, tokenConfigured: true });
  const stored = JSON.parse(await fs.readFile(path.join(temp, 'state/settings.json'), 'utf8'));
  assert.equal(stored.encryptedToken, hidden[5]);
  assert(!JSON.stringify(stored).includes(fixtureToken));
  for (const value of hidden) assert(!JSON.stringify(r.body).includes(value));
});

test('immediate switch closes only eligible old ChatGPT connections and tolerates natural expiry', async () => {
  const old = (id, host, extra = {}) => [id, { id, metadata: { host, ...extra }, chains: [nodeA, 'ChatGPT'] }];
  reconnectFixture = new Map([
    old('chat-old', 'WS.CHATGPT.COM.'),
    old('gpt-asset-old', 'cdn.oaistatic.com'),
    old('already-ended', 'chatgpt.com'),
    old('onedrive', 'tenant-my.sharepoint.com', { process: 'OneDrive.exe' }),
    old('outlook', 'outlook.office.com', { process: 'OUTLOOK.EXE' }),
    old('office-with-gpt-host', 'chatgpt.com', { processPath: 'C:\\Apps\\olk.exe' }),
    old('suffix-lookalike', 'chatgpt.com.example.test'),
    old('unsafe-id/..', 'chatgpt.com'),
    ['connected-to-new', { id: 'connected-to-new', metadata: { host: 'chatgpt.com' }, chains: [nodeB, 'ChatGPT'] }],
    ['missing-route', { id: 'missing-route', metadata: { host: 'chatgpt.com' } }],
  ]);
  try {
    const before = await panel('/api/status');
    assert.equal(before.body.openai.oldConnectionCount, 3);
    assert.equal(before.body.openai.reconnectAvailable, true);
    const call = (expectedNode, headers = mutationHeaders()) =>
      panel('/api/reconnect-chatgpt', { method: 'POST', data: { expectedNode }, headers });
    const mark = writeCalls().length;
    assert.equal((await call(nodeA)).code, 409);
    assert.equal((await call(nodeB, {})).code, 403);
    assert.equal(writeCalls().length, mark);
    const result = await call(nodeB);
    assert.equal(result.code, 200);
    assert.deepEqual(result.body, { ok: true, requested: 3, accepted: 2, unconfirmed: 1 });
    const writes = writeCalls().slice(mark);
    assert(writes.every(entry => entry.method === 'DELETE'));
    assert.deepEqual(writes.map(entry => entry.pathname).sort(),
      ['/connections/already-ended', '/connections/chat-old', '/connections/gpt-asset-old']);
    assert(reconnectFixture.has('onedrive') && reconnectFixture.has('outlook') && reconnectFixture.has('connected-to-new'));
    const after = await panel('/api/status');
    assert.equal(after.body.openai.oldConnectionCount, 0);
    assert(after.body.openai.live.some(entry => entry.node === nodeB && entry.count === 3));
    assert.deepEqual((await call(nodeB)).body, { ok: true, requested: 0, accepted: 0, unconfirmed: 0 });
    assert.equal(writeCalls().length, mark + 3);
  } finally {
    reconnectFixture = null;
  }
});
