'use strict';

const $ = (id) => document.getElementById(id);
const app = { status: null, loading: false, csrf: '', testResults: new Map(), testing: new Set(), testingAll: false, action: false, reconnecting: false, traffic: { up: [], down: [] }, toastTimer: null };
const setText = (id, value) => { $(id).textContent = value == null ? '—' : String(value); };
const show = (id, visible) => $(id).classList.toggle('hidden', !visible);
function element(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = String(text); return el; }
function toast(message, error = false) { clearTimeout(app.toastTimer); const el = $('toast'); el.textContent = message; el.className = 'toast' + (error ? ' error' : ''); app.toastTimer = setTimeout(() => el.classList.add('hidden'), error ? 6500 : 4200); }
async function api(path, body) {
  const options = { credentials: 'same-origin', headers: { 'Accept': 'application/json' } };
  if (body !== undefined) { options.method = 'POST'; options.headers['Content-Type'] = 'application/json'; options.headers['X-Panel-Request'] = '1'; if (app.csrf) options.headers['X-CSRF-Token'] = app.csrf; options.body = JSON.stringify(body); }
  const response = await fetch(path, options);
  let result; try { result = await response.json(); } catch { throw new Error('控制台暂时没有响应，请稍后刷新。'); }
  if (!response.ok || result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || '操作未完成，请稍后重试。');
  return result;
}
function currentGeneral(status) { return status?.general?.effectiveNode || status?.general?.selection || '未选择'; }
function connected(status) { return Boolean(status?.controller?.connected); }
function fixedSupported(status) { return Boolean(status?.capabilities?.fixedRoute || status?.openai?.fixedSupported); }
function humanTraffic(value) { if (value == null) return '—'; const n = Number(value); if (!Number.isFinite(n) || n < 0) return '—'; const mb = n / 1048576; return mb >= 100 ? mb.toFixed(0) : mb >= 10 ? mb.toFixed(1) : mb.toFixed(2); }
function setTraffic(id, value) { const el = $(id); el.replaceChildren(document.createTextNode(humanTraffic(value)), element('small', '', 'MB/s')); }
function drawSparkline(type, value) {
  const values = app.traffic[type]; values.push(Math.max(0, Number(value) || 0)); if (values.length > 36) values.shift();
  const max = Math.max(1, ...values); const step = 180 / Math.max(1, values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(33 - v / max * 27).toFixed(1)}`);
  const d = points.length ? 'M' + points.join(' L') : '';
  $(type === 'up' ? 'upload-line' : 'download-line').setAttribute('d', d);
  $(type === 'up' ? 'upload-area' : 'download-area').setAttribute('d', d ? d + ' L180,36 L0,36 Z' : '');
}
function nodeDelay(node) { const saved = app.testResults.get(node.name); return saved ? saved.delay : node.delay ?? node.delayMs ?? null; }
function renderLive(status) {
  const total = (status.openai?.live || []).reduce((sum, item) => sum + (Number(item.count) || 0), 0);
  const old = status.openai?.oldConnectionCount || 0;
  const button = $('reconnect-chatgpt');
  button.disabled = !connected(status) || !status.openai?.reconnectAvailable || !old || app.action || app.testingAll;
  setText('reconnect-chatgpt', app.reconnecting ? '正在换线…' : '立即换线');
  setText('live-note', old ? `${old} 条 ChatGPT 连接仍走旧线` : total ? `${total} 条 ChatGPT 活动连接` : '暂无 ChatGPT 活动连接');
}
function renderStatus(status) {
  setText('direct-routing-status', status.directRouting?.ok ? '国内直连保护已开启' : status.directRouting?.enabled ? '正在核对国内直连保护' : '按代理核心规则分流');
  app.status = status; if (status.csrfToken) app.csrf = status.csrfToken;
  const online = connected(status); const capabilities = status.capabilities || {};
  $('controller-pill').className = 'status-pill ' + (online ? 'connected' : 'offline'); setText('controller-label', online ? '代理核心在线' : '代理核心未连接');
  show('offline-banner', !online); setText('offline-message', status.controller?.error || '启动已安装的代理后台，或在连接设置中填写本机控制端口。');
  show('engine-start', Boolean(capabilities.engineStart)); $('engine-start').disabled = app.action;
  const configured = status.openai?.configured;
  setText('openai-node', online ? configured || '由规则决定' : '尚未连接');
  const automatic = status.automatic;
  $('auto-line').hidden = !automatic?.available && !automatic?.enabled;
  $('auto-chatgpt').checked = !!automatic?.enabled;
  $('auto-chatgpt').disabled = !online || app.action || (!automatic?.available && !automatic?.enabled);
  const measurements = [automatic?.delay ? `${automatic.delay} ms` : null,
    automatic?.downloadMbps !== null && automatic?.downloadMbps !== undefined ? `${automatic.downloadMbps} Mbps` : null].filter(Boolean);
  setText('auto-status', automatic?.enabled
    ? automatic.message || (measurements.length ? measurements.join(' · ') : '等待测速')
    : '持续高延迟或低速时换线');
  setText('version', status.version ? `版本 ${status.version}` : '');
  const network = status.network;
  const region = network?.region === 'HK' ? '直连出口：香港' : network?.region ? `直连出口：${network.region}` : '直连地区待确认';
  setText('region-status', !online ? '等待代理核心' : network?.available ? region :
    status.region?.coreExcluded ? '代理候选已排除香港' : '正在核对代理核心');
  renderLive(status);
  const traffic = status.traffic || {}; const up = traffic.upBps ?? traffic.up ?? 0; const down = traffic.downBps ?? traffic.down ?? 0;
  setTraffic('download-value', online ? down : null); setTraffic('upload-value', online ? up : null); if (online) { drawSparkline('up', up); drawSparkline('down', down); }
  const enabled = Boolean(status.systemProxy?.enabled); $('proxy-dot').className = 'status-dot' + (enabled ? ' connected' : ''); setText('proxy-state', enabled ? '代理已连接' : '代理未连接');
  setText('proxy-toggle', enabled ? '断开代理' : '连接代理'); $('proxy-toggle').disabled = (!online && !enabled) || !capabilities.systemProxy || app.action;
  show('proxy-toggle', Boolean(capabilities.systemProxy));
  show('route-resume', Boolean(capabilities.routeControl)); show('route-pause', Boolean(capabilities.routeControl)); $('route-resume').disabled = app.action; $('route-pause').disabled = app.action;
  const routeStatus = status.route?.status; const routeText = { running: '专用通道运行中', ready: '专用通道运行中', paused: '专用通道已暂停', 'paused-or-app-closed': '专用通道暂停或应用未打开', 'waiting-for-existing-proxy': '等待本机代理连接', retrying: '专用通道正在恢复', stopped: '专用通道已停止' };
  setText('route-caption', capabilities.routeControl ? (routeText[routeStatus] || '可在此恢复专用连接通道') : online ? '由本机代理核心提供网络连接' : '请先启动代理后台');
  const general = currentGeneral(status);
  const selection = status.general?.selection;
  setText('general-node', !online ? '—' : status.general?.direct ? '直连' : selection && selection !== general ? `${selection} → ${general}` : general);
  renderGeneralPicker(status);
  $('test-all').disabled = !online || app.testingAll || app.action; setText('test-all-label', app.testingAll ? '测速中…' : '测速全部');
  setText('last-update', `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
  renderNodes();
}
function renderGeneralPicker(status) {
  const select = $('general-select');
  const leafNames = new Set((status.nodes || []).map(node => node.name));
  const names = (status.general?.options || []).filter(name => !leafNames.has(name) && !['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE'].includes(name));
  const selection = status.general?.selection || '';
  if (JSON.stringify(names) !== select.dataset.options) {
    const placeholder = element('option', '', '选择线路组');
    placeholder.value = '';
    select.replaceChildren(placeholder, ...names.map(name => {
      const option = element('option', '', name);
      option.value = name;
      return option;
    }));
    select.dataset.options = JSON.stringify(names);
  }
  select.value = !status.general?.direct && names.includes(selection) ? selection : '';
  select.disabled = !connected(status) || !names.length || app.action || app.testingAll;
  show('group-picker', names.length > 0);
  const network = status.network;
  show('auto-ordinary', !!network?.available);
  $('auto-ordinary').disabled = !connected(status) || network?.auto || app.action || app.testingAll;
  setText('auto-ordinary', network?.auto ? '已按网络自动' : '恢复按网络自动');
  setText('ai-note', status.automatic?.enabled ? '手动选线会关闭自动换线' : '手动选择一条专用线路');
}
function renderNodes() {
  const status = app.status || {};
  const query = $('node-search').value.trim().toLocaleLowerCase();
  for (const [id, scope] of [['ai', 'openai'], ['ordinary', 'general']]) {
    const ai = scope === 'openai';
    const list = $(id + '-node-list');
    const picked = ai ? status.openai?.configured : status.general?.direct ? null : status.general?.selection;
    const pinned = ai ? !status.automatic?.enabled : !status.network?.available || !status.network.auto;
    const eligible = (status.nodes || []).filter(node => ai ? (status.openai?.managed ? status.openai.options.includes(node.name) : fixedSupported(status)) :
      status.general?.options?.includes(node.name));
    const visible = eligible.filter(node => node.name.toLocaleLowerCase().includes(query));
    const latency = node => Number(nodeDelay(node)) > 0 ? Number(nodeDelay(node)) : Infinity;
    visible.sort((a, b) => Number(b.name === picked) - Number(a.name === picked) ||
      (latency(a) === latency(b) ? 0 : latency(a) - latency(b)));
    setText(id + '-node-count', query ? `${visible.length} / ${eligible.length}` : eligible.length);
    const locked = !connected(status) || app.action || app.testingAll;
    const rows = visible.map(node => ({ name: node.name, delay: Number(nodeDelay(node)), tested: app.testing.has(node.name),
      error: app.testResults.get(node.name)?.error, selected: node.name === picked }));
    const signature = JSON.stringify({ rows, locked, pinned, query });
    if (signature === list.dataset.signature) continue;
    list.dataset.signature = signature;
    list.replaceChildren();
    if (!rows.length) list.append(element('li', 'empty-inline choice-empty', query ? '没有匹配线路' : '暂无可选线路'));
    for (const item of rows) {
      const row = element('li', 'choice-row' + (item.selected ? ' is-selected' : ''));
      const route = element('button', 'choice-node');
      route.type = 'button';
      route.disabled = locked || (item.selected && pinned);
      route.setAttribute('aria-label', `${ai ? 'ChatGPT / Claude' : '普通代理'}使用 ${item.name}`);
      route.append(element('span', 'node-label', item.name));
      if (item.selected) route.append(element('span', 'tag blue', '当前'));
      route.addEventListener('click', () => selectNode(scope, item.name));
      const delay = item.tested ? '测速中…' : item.error ? '不可用' : item.delay > 0 ? `${Math.round(item.delay)} ms` : '测速';
      const test = element('button', 'choice-test' + (item.error ? ' failed' : ''), delay);
      test.type = 'button';
      test.disabled = locked || item.tested;
      test.title = '测试此线路的延迟';
      test.setAttribute('aria-label', `测试 ${item.name} · ${delay}`);
      test.addEventListener('click', () => testNodes([item.name]));
      row.append(route, test);
      list.append(row);
    }
  }
}
async function refresh(manual = false, discover = false) {
  if (app.loading) return; app.loading = true; $('refresh-icon').classList.add('spinning');
  try { const result = manual || discover ? await api('/api/refresh', { discover }) : await api('/api/status'); renderStatus(result.status || result); if (manual) toast(discover ? '已重新寻找本机代理核心' : '连接状态已更新'); }
  catch (error) { if (manual) toast(error.message, true); if (!app.status) { setText('controller-label', '控制台未连接'); $('controller-pill').className = 'status-pill offline'; show('offline-banner', true); setText('offline-message', error.message); setText('openai-node', '暂时无法读取'); } }
  finally { app.loading = false; $('refresh-icon').classList.remove('spinning'); }
}
async function testNodes(names) {
  if (app.testingAll) return; const all = !names; app.testingAll = all;
  const requested = names || (app.status?.nodes || []).map((n) => n.name); requested.forEach((name) => app.testing.add(name)); renderNodes(); if (app.status) renderGeneralPicker(app.status); $('test-all').disabled = true; setText('test-all-label', all ? '测速中…' : '测速全部');
  try { const result = await api('/api/test', names ? { nodes: names } : {}); for (const item of result.results || []) { const name = item.name || item.node; if (name) app.testResults.set(name, { delay: item.delay ?? item.delayMs, error: item.error }); } const success = (result.results || []).filter((n) => !n.error && Number(n.delay ?? n.delayMs) > 0).length; toast(all ? `测速完成，${success} 条线路可用` : success ? '测速完成' : '这条线路暂时没有响应', !success); }
  catch (error) { toast(error.message, true); }
  finally { requested.forEach((name) => app.testing.delete(name)); app.testingAll = false; if (app.status) renderStatus(app.status); }
}
async function selectNode(scope, node) {
  if (app.action || app.testingAll) return; app.action = true; renderNodes();
  if (app.status) { renderGeneralPicker(app.status); renderLive(app.status); }
  try { const result = await api('/api/select', { scope, node }); toast(result.message || (scope === 'openai' ? 'ChatGPT 新连接已切换，已有会话可重新连接以使用新线路。' : '普通流量线路已切换')); await refresh(); }
  catch (error) { toast(error.message, true); }
  finally { app.action = false; if (app.status) renderStatus(app.status); }
}
async function reconnectChatGpt() {
  const { openai } = app.status || {};
  if (app.action || app.testingAll || !openai?.reconnectAvailable || !openai.oldConnectionCount) return;
  app.action = true;
  app.reconnecting = true;
  renderStatus(app.status);
  try {
    const result = await api('/api/reconnect-chatgpt', { expectedNode: openai.configured });
    if (result.unconfirmed) toast(`已断开 ${result.accepted} 条旧连接，另有 ${result.unconfirmed} 条关闭未确认。请查看已有连接。`, true);
    else toast(result.accepted ? `已断开 ${result.accepted} 条 ChatGPT 旧连接，重连后走新线路。` : '当前没有需要切换的 ChatGPT 连接。');
  } catch (error) {
    toast(error.message, true);
  } finally {
    app.action = false;
    app.reconnecting = false;
    if (app.status) renderStatus(app.status);
    await refresh();
    setTimeout(() => refresh(), 1300);
  }
}
async function action(path, body, message) {
  if (app.action) return; app.action = true; if (app.status) renderStatus(app.status);
  try { const result = await api(path, body); toast(result.message || message); await refresh(); setTimeout(() => refresh(), 2200); }
  catch (error) { toast(error.message, true); }
  finally { app.action = false; if (app.status) renderStatus(app.status); }
}
function openSettings() { const settings = app.status?.settings || {}; $('controller-url').value = settings.controllerUrl || app.status?.controller?.url || 'http://127.0.0.1:1978'; $('controller-token').value = ''; $('clear-token').checked = false; setText('token-note', settings.tokenConfigured ? '已保存控制密码，留空会继续使用。' : '未设置时留空即可。'); setText('settings-status', ''); $('settings-dialog').showModal(); }
function closeSettings() { $('settings-dialog').close(); $('controller-token').value = ''; }
$('refresh').addEventListener('click', () => refresh(true));
$('test-all').addEventListener('click', () => testNodes());
$('reconnect-chatgpt').addEventListener('click', reconnectChatGpt);
$('auto-chatgpt').addEventListener('change', event => action('/api/automatic-chatgpt', { enabled: event.target.checked }));
$('auto-ordinary').addEventListener('click', () => action('/api/auto-ordinary', {}));
$('node-search').addEventListener('input', renderNodes);
$('general-select').addEventListener('change', (event) => { const node = event.target.value; if (node) selectNode('general', node); });
for (const id of ['open-settings', 'offline-settings', 'footer-settings']) $(id).addEventListener('click', openSettings);
for (const id of ['close-settings', 'cancel-settings']) $(id).addEventListener('click', closeSettings);
$('settings-dialog').addEventListener('click', (event) => { if (event.target === $('settings-dialog')) { const box = $('settings-dialog').getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeSettings(); } });
$('settings-dialog').addEventListener('close', () => { $('controller-token').value = ''; });
$('discover').addEventListener('click', async () => { $('discover').disabled = true; setText('settings-status', '正在寻找本机代理核心…'); try { const result = await api('/api/refresh', { discover: true }); const status = result.status || result; renderStatus(status); $('controller-url').value = status.settings?.controllerUrl || status.controller?.url || $('controller-url').value; setText('settings-status', connected(status) ? '已找到代理核心，可以保存并连接。' : '暂未找到。请先启动本机代理后台，或手动填写控制地址。'); } catch (error) { setText('settings-status', error.message); } finally { $('discover').disabled = false; } });
$('settings-form').addEventListener('submit', async (event) => { event.preventDefault(); $('save-settings').disabled = true; setText('settings-status', '正在连接…'); const body = { controllerUrl: $('controller-url').value.trim() }; if ($('controller-token').value) body.token = $('controller-token').value; if ($('clear-token').checked) body.clearToken = true; try { await api('/api/settings', body); await refresh(); closeSettings(); toast('连接设置已保存'); } catch (error) { setText('settings-status', error.message); } finally { $('save-settings').disabled = false; } });
$('proxy-toggle').addEventListener('click', () => { const enabled = !app.status?.systemProxy?.enabled; action('/api/system-proxy', { enabled }, enabled ? '本机代理已连接' : '本机代理已断开'); });
$('route-resume').addEventListener('click', () => action('/api/route', { mode: 'Resume' }, '已请求恢复专用通道'));
$('route-pause').addEventListener('click', () => action('/api/route', { mode: 'Pause' }, '已请求暂停专用通道'));
$('engine-start').addEventListener('click', () => action('/api/engine/start', {}, '已请求启动代理后台，正在等待就绪'));
refresh(); setInterval(() => { if (!document.hidden && !$('settings-dialog').open) refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
