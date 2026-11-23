import { portHints, controllerPorts } from './windows.mjs';
import http from 'node:http';
import { GPT_DOMAINS, GPT_GROUP, containsHongKong, hongKongExcluded, isGptHost, isHongKong } from './regions.mjs';
export function localUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('只支持本机 HTTP 控制接口，例如 http://127.0.0.1:1978');
  return u.origin;
}
export async function api(url, token, suffix, method = 'GET', body, timeout = 4500) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(localUrl(url) + suffix, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) } }, res => {
      res.setEncoding('utf8');
      let text = ''; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) req.destroy(new Error('后台返回内容过大')); else text += chunk; });
      res.on('end', () => {
        if ([401, 403].includes(res.statusCode)) return reject(new Error('控制接口需要密钥，请在设置中填写。'));
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('后台接口返回 ' + res.statusCode));
        if (res.statusCode === 204) return resolve({});
        try { resolve(JSON.parse(text)); } catch { reject(new Error('后台接口返回格式不兼容')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('后台响应超时')), timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject); if (payload !== null) req.write(payload); req.end();
  });
}
export async function discover(settings, token, exhaustive = false) {
  const hints = await portHints();
  const urls = [...new Set([settings.controllerUrl, hints?.[2] && `http://127.0.0.1:${hints[2]}`, 'http://127.0.0.1:1978', 'http://127.0.0.1:9090', 'http://127.0.0.1:54614'].filter(Boolean))];
  let lastError = '没有发现正在运行的代理后台';
  const tryOne = async url => {
    try {
      const v = await api(url, token, '/version', 'GET', undefined, 1000);
      if (typeof v.version !== 'string') return null;
      const [config, proxies] = await Promise.all([api(url, token, '/configs'), api(url, token, '/proxies')]);
      if (!proxies.proxies) return null;
      return { url, version: v.version, config, proxies: proxies.proxies };
    } catch (e) { if (settings.controllerUrl === url) lastError = e.message; return null; }
  };
  for (const url of (settings.controllerUrl && !exhaustive ? [settings.controllerUrl] : urls)) { const result = await tryOne(url); if (result) return result; }
  if (exhaustive) for (const port of await controllerPorts()) { const url = `http://127.0.0.1:${port}`; if (!urls.includes(url)) { const result = await tryOne(url); if (result) return result; } }
  throw new Error(lastError);
}
export function effective(proxies, name, seen = new Set()) {
  if (!name || seen.has(name)) return name || null;
  seen.add(name); const p = proxies[name];
  return p?.now ? effective(proxies, p.now, seen) : name;
}
const officeProcess = /(?:^|[\\/])(?:onedrive|outlook|olk)(?:\.exe)?$/i;

function chatGptConnection(connection) {
  const meta = connection.metadata;
  const host = String(meta?.host || '').toLowerCase().replace(/\.$/, '');
  return isGptHost(host) && ![meta?.process, meta?.processPath].some(value => officeProcess.test(String(value || '')));
}

export function oldChatGptConnections(connections, target) {
  if (!target) return [];
  return (connections.connections || []).filter(connection =>
    chatGptConnection(connection) && typeof connection.id === 'string' &&
    /^[a-z\d_-]{1,128}$/i.test(connection.id) && Array.isArray(connection.chains) &&
    typeof connection.chains[0] === 'string' && connection.chains[0] && connection.chains[0] !== target);
}

export function summarize(found, rules, connections, routeFile) {
  const proxies = found.proxies;
  const groups = Object.entries(proxies).filter(([, p]) => p.type === 'Selector' && Array.isArray(p.all));
  const general = groups.find(([name]) => name === 'SELECT') || groups.find(([name]) => name !== 'GLOBAL') || groups[0];
  const leaves = Object.entries(proxies).filter(([name, p]) => !isHongKong(name) && !p.all && !['DIRECT', 'REJECT', 'COMPATIBLE', 'PASS'].includes(name) && !['Direct', 'Reject', 'Compatible', 'Pass'].includes(p.type));
  const relevant = (connections.connections || []).filter(chatGptConnection);
  const live = new Map(); for (const c of relevant) { const node = c.chains?.[0] || '未知'; live.set(node, (live.get(node) || 0) + 1); }
  const routes = rules.rules || [];
  const rule = routes.find(r => r.payload === 'chatgpt.com' && /domain/i.test(r.type));
  const gpt = proxies[GPT_GROUP];
  const managed = found.config?.mode === 'rule' && gpt?.type === 'Selector'
    && GPT_DOMAINS.every(domain => routes.find(rule => rule.payload === domain && /domain/i.test(rule.type))?.proxy === GPT_GROUP);
  const options = (general?.[1]?.all || []).filter(name => !containsHongKong(proxies, name));
  const target = found.config?.mode === 'global' ? 'GLOBAL' : found.config?.mode === 'direct' ? 'DIRECT' : rule?.proxy || routeFile?.proxy;
  const followsGeneral = managed ? gpt.now === general?.[0] : target === general?.[0];
  const gptOptions = managed ? gpt.all.filter(name => !containsHongKong(proxies, name)) : [];
  const configured = effective(proxies, target);
  const reconnectAvailable = managed && leaves.some(([name]) => name === configured)
    && !containsHongKong(proxies, GPT_GROUP);
  return {
    general: { group: general?.[0] || null, selection: general?.[1]?.now || null, effectiveNode: effective(proxies, general?.[1]?.now), members: options, options },
    openai: {
      configured,
      source: followsGeneral ? '通用线路' : managed || routeFile?.proxy ? '专用线路' : '运行中的路由规则',
      followsGeneral, managed, selection: managed ? gpt.now : null, options: gptOptions,
      live: [...live].map(([node, count]) => ({ node, count })),
      reconnectAvailable,
      oldConnectionCount: reconnectAvailable ? oldChatGptConnections(connections, configured).length : 0
    },
    region: { coreExcluded: hongKongExcluded(proxies), liveHongKong: (connections.connections || []).filter(c => c.chains?.some(isHongKong)).length },
    nodes: leaves.map(([name, p]) => ({ name, type: p.type, delay: p.history?.at(-1)?.delay || null })),
    totals: { upload: connections.uploadTotal || 0, download: connections.downloadTotal || 0 }
  };
}
export async function testNodes(found, token, names) {
  const queue = [...names], results = [];
  const worker = async () => { while (queue.length) { const name = queue.shift(); try { const r = await api(found.url, token, '/proxies/' + encodeURIComponent(name) + '/delay?timeout=5000&url=' + encodeURIComponent('https://chatgpt.com/cdn-cgi/trace'), 'GET', undefined, 6500); results.push({ name, delay: r.delay ?? null }); } catch { results.push({ name, delay: null, error: '超时或线路不可用' }); } } };
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker)); return results;
}
