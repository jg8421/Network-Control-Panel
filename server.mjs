import { startDirectGuard } from './lib/direct-guard.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { api, discover, localUrl, summarize, testNodes } from './lib/controller.mjs';
import { GPT_GROUP, containsHongKong } from './lib/regions.mjs';
import { exists, jsonFile, atomicWrite, systemProxy, saturnPaths, setSystemProxy, startEngine, bridgePaths, routeStatus, controlRoute, setFixedRoute, protectToken, unprotectToken } from './lib/windows.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = Number(portArg >= 0 ? args[portArg + 1] : process.env.PANEL_PORT || 18791);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('Invalid local panel port');
const STATE = process.env.PANEL_STATE_DIR || path.join(process.env.LOCALAPPDATA || ROOT, 'JerryNetworkPanel');
const settingsPath = path.join(STATE, 'settings.json');
const csrf = crypto.randomBytes(32).toString('hex');
let settings = await jsonFile(settingsPath) || {};
let token = process.env.PANEL_CONTROLLER_TOKEN || '';
if (!token && settings.encryptedToken) { try { token = await unprotectToken(settings.encryptedToken); } catch { token = ''; } }
if (settings.controllerUrl) { try { settings.controllerUrl = localUrl(settings.controllerUrl); } catch { delete settings.controllerUrl; } }
let found = null, statusPromise = null, lastDiscovery = 0, mutation = false, trafficSample = null;
const directGuard = startDirectGuard(STATE, { canRun: () => !mutation, preferredGpt: () => settings.gptSelection });
const delays = new Map();

function publicSettings() { return { controllerUrl: settings.controllerUrl || found?.url || '', tokenConfigured: !!token }; }
async function saveSettings(next) { await atomicWrite(settingsPath, JSON.stringify(next, null, 2) + '\n'); settings = next; }
async function refresh(discoverMore = false) {
  if (discoverMore) found = null;
  if (!found) {
    if (!discoverMore && Date.now() - lastDiscovery < 3500) throw new Error('后台未连接，点击自动查找或启动后台。');
    lastDiscovery = Date.now(); found = await discover(settings, token, discoverMore);
  }
  return found;
}
async function status(force = false) {
  if (statusPromise) return statusPromise;
  statusPromise = (async () => {
    const [sys, route, saturn, routeFile, hasGuard] = await Promise.all([systemProxy(force), routeStatus(), saturnPaths(), jsonFile(bridgePaths.routeFile), exists(bridgePaths.guard)]);
    const base = { directRouting: directGuard.health, version: VERSION, csrfToken: csrf, settings: publicSettings(), systemProxy: { enabled: sys.enabled, server: (sys.server || '').replace(/[^;\s]*@/g, '***@'), available: sys.available }, route, capabilities: { fixedRoute: hasGuard && !!routeFile, routeControl: route.available, engineStart: !!saturn, systemProxy: !!saturn?.sysproxy }, traffic: { upBps: 0, downBps: 0 }, nodes: [], general: {}, openai: { configured: routeFile?.proxy || null, source: '后台未连接', live: [], fixedSupported: hasGuard && !!routeFile } };
    try {
      const f = await refresh();
      const [config, proxyData, rules, connections] = await Promise.all([api(f.url, token, '/configs'), api(f.url, token, '/proxies'), api(f.url, token, '/rules'), api(f.url, token, '/connections')]);
      found = { ...f, config, proxies: proxyData.proxies };
      const clean = summarize(found, rules, connections, hasGuard ? routeFile : null);
      const now = Date.now();
      if (trafficSample && trafficSample.url === f.url) { const secs = (now - trafficSample.at) / 1000; if (secs > 0) base.traffic = { upBps: Math.max(0, (clean.totals.upload - trafficSample.upload) / secs), downBps: Math.max(0, (clean.totals.download - trafficSample.download) / secs) }; }
      trafficSample = { ...clean.totals, at: now, url: f.url };
      delete clean.totals;
      clean.nodes = clean.nodes.map(n => ({ ...n, delay: delays.has(n.name) ? delays.get(n.name) : n.delay }));
      return { ...base, ...clean, openai: { ...clean.openai, fixedSupported: clean.openai.managed || base.capabilities.fixedRoute }, controller: { connected: true, url: f.url, version: f.version }, settings: publicSettings(), updatedAt: new Date().toISOString() };
    } catch (e) {
      found = null;
      return { ...base, controller: { connected: false, url: settings.controllerUrl || '', error: e.message || '后台不可用' }, updatedAt: new Date().toISOString() };
    }
  })();
  try { return await statusPromise; } finally { statusPromise = null; }
}
function send(res, code, object) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(JSON.stringify(object));
}
async function body(req) {
  let bytes = 0, chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new Error('提交内容过大'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new Error('提交格式无效'); }
}
function requireMutation(req) {
  const origin = req.headers.origin;
  if (origin && ![`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(origin)) throw new Error('请在本机面板中操作');
  if (req.headers['x-panel-request'] !== '1' || req.headers['x-csrf-token'] !== csrf) throw new Error('页面已失效，请刷新后再试');
}
const server = http.createServer(async (req, res) => {
  const host = req.headers.host;
  if (![ `127.0.0.1:${PORT}`, `localhost:${PORT}` ].includes(host)) return send(res, 403, { error: 'Only the local panel address is accepted' });
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { app: 'jerry-network-panel', ok: true, version: VERSION });
    if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, await status());
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      try { requireMutation(req); } catch (e) { return send(res, 403, { error: e.message }); }
      if (mutation) return send(res, 409, { error: '上一个操作仍在进行，请稍候' });
      mutation = true;
      try {
        const input = await body(req);
        if (url.pathname === '/api/settings') {
          const next = { ...settings };
          if (typeof input.controllerUrl !== 'string' || input.controllerUrl.length > 200) throw new Error('控制接口地址无效');
          next.controllerUrl = input.controllerUrl.trim() ? localUrl(input.controllerUrl.trim()) : '';
          let nextToken = token;
          if (input.clearToken === true) { next.encryptedToken = ''; nextToken = ''; }
          else if (typeof input.token === 'string' && input.token) { if (input.token.length > 4096 || /[\r\n]/.test(input.token)) throw new Error('密钥格式无效'); next.encryptedToken = await protectToken(input.token); nextToken = input.token; }
          await saveSettings(next); token = nextToken; found = null; lastDiscovery = 0;
          return send(res, 200, { ok: true, message: '设置已保存', settings: publicSettings() });
        }
        if (url.pathname === '/api/refresh') { if (input.discover) { found = null; lastDiscovery = 0; try { await refresh(true); } catch {} } return send(res, 200, { ok: true, status: await status(true) }); }
        if (url.pathname === '/api/engine/start') { await startEngine(); found = null; lastDiscovery = 0; return send(res, 200, { ok: true, message: '已请求启动后台，稍候刷新即可' }); }
        if (url.pathname === '/api/route') { await controlRoute(input.mode); return send(res, 200, { ok: true, message: input.mode === 'Resume' ? '已提交恢复请求，请等待状态刷新' : '已提交暂停请求' }); }
        if (url.pathname === '/api/system-proxy') { if (typeof input.enabled !== 'boolean') throw new Error('连接选项无效'); const f = input.enabled ? await refresh() : null; await setSystemProxy(input.enabled, f?.config.port || f?.config['mixed-port'] || 0); return send(res, 200, { ok: true, message: input.enabled ? '系统代理已连接' : '系统代理已断开；专用远程通道单独控制' }); }
        if (url.pathname === '/api/shutdown') { send(res, 200, { ok: true }); setTimeout(() => { server.close(); setTimeout(() => process.exit(0), 300).unref(); }, 150); return; }
        const f = await refresh();
        if (url.pathname === '/api/test') {
          const valid = summarize(f, {}, {}, null).nodes.map(n => n.name);
          const names = input.nodes === undefined ? valid : input.nodes;
          if (!Array.isArray(names) || names.length > 100 || names.some(n => typeof n !== 'string' || !valid.includes(n))) throw new Error('请选择现有线路进行测速');
          const results = await testNodes(f, token, [...new Set(names)]);
          for (const r of results) delays.set(r.name, r.delay);
          return send(res, 200, { ok: true, results });
        }
        if (url.pathname === '/api/select') {
          const { node, scope } = input;
          await directGuard.wait();
          const current = await api(f.url, token, '/proxies'); f.proxies = current.proxies;
          if (typeof node !== 'string' || !Object.hasOwn(f.proxies, node) || !['openai', 'general'].includes(scope)) throw new Error('线路选择无效');
          if (containsHongKong(f.proxies, node)) throw new Error('香港线路及包含香港的线路组已禁用');
          const [rules, config] = await Promise.all([api(f.url,token,'/rules'), api(f.url,token,'/configs')]);
          const selected = summarize({ ...f, config }, rules, {}, null);
          const group = scope === 'general' ? selected.general.group : selected.openai.managed ? GPT_GROUP : null;
          if (group) {
            if (!f.proxies[group]?.all?.includes(node)) throw new Error('这条线路不属于当前选择组');
            const key = '/proxies/' + encodeURIComponent(group);
            await api(f.url, token, key, 'PUT', { name: node });
            const confirmed = await api(f.url, token, key);
            if (confirmed.now !== node) throw new Error('后台没有确认线路切换');
            if (group === GPT_GROUP && f.url === directGuard.health.controllerUrl) await saveSettings({ ...settings, gptSelection: node });
          } else if (scope === 'openai') {
            if (f.proxies[node].all || ['DIRECT','REJECT','COMPATIBLE','PASS'].includes(node)) throw new Error('ChatGPT 专用线路需要具体节点');
            await setFixedRoute(node, async () => {
              const rules = await api(f.url, token, '/rules');
              const domains = ['openai.com','chatgpt.com','oaistatic.com','oaiusercontent.com','oaistatsig.com'];
              if (!domains.every(d => rules.rules.find(r => r.payload === d)?.proxy === node)) throw new Error('后台规则尚未全部更新');
            });
          } else throw new Error('未找到普通线路选择组');
          return send(res, 200, { ok: true, message: '已更新新连接的线路。正在使用的连接会保留原线路，直到重新建立。' });
        }
        return send(res, 404, { error: '没有这个操作' });
      } finally { mutation = false; }
    }
    const assets = { '/': ['index.html','text/html; charset=utf-8'], '/index.html': ['index.html','text/html; charset=utf-8'], '/app.js': ['app.js','text/javascript; charset=utf-8'], '/styles.css': ['styles.css','text/css; charset=utf-8'] };
    const asset = assets[url.pathname];
    if (req.method === 'GET' && asset) {
      const data = await fs.readFile(path.join(ROOT, 'public', asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'" }); return res.end(data);
    }
    send(res, 404, { error: '页面不存在' });
  } catch (e) { send(res, 400, { error: e.message || '操作未完成，请刷新重试' }); }
});
server.requestTimeout = 180000;
server.headersTimeout = 15000;
server.listen(PORT, '127.0.0.1', () => console.log(`线路控制台 http://127.0.0.1:${PORT}`));
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '面板端口已被使用，请从一键启动入口打开。' : '无法启动本机面板'); process.exitCode = 1; });
