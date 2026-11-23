'use strict';

const $ = (id) => document.getElementById(id);
const app = { status: null, scope: 'openai', loading: false, csrf: '', testResults: new Map(), testing: new Set(), testingAll: false, action: false, traffic: { up: [], down: [] }, toastTimer: null };
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
  const live = Array.isArray(status.openai?.live) ? status.openai.live : [];
  const container = $('live-nodes'); container.replaceChildren(); let total = 0;
  if (!live.length) container.append(element('div', 'empty-inline', connected(status) ? '暂无 ChatGPT 活动连接' : '连接代理核心后显示实际线路'));
  for (const item of live) {
    const name = item.node || '未识别线路';
    const count = Number(item.count) || 0;
    const matches = name === status.openai?.configured;
    total += count;
    const row = element('div', 'live-node' + (matches ? ' current' : ''));
    row.append(element('span', 'node-indicator'), element('span', 'live-name', name));
    if (!matches && status.openai?.configured) row.append(element('span', 'tag neutral', '与新连接不同'));
    row.append(element('span', 'live-count', `${count} 条`));
    container.append(row);
  }
  setText('live-total', total ? `${total} 条连接` : '暂无连接');
  const old = live.some((n) => (n.node || n.name) !== status.openai?.configured);
  setText('live-note', old ? '切换线路后，已有连接会沿用原线路，直到重新建立。' : '这里按实际出口汇总 ChatGPT 和 OpenAI 的活动连接。');
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
  const follows = status.openai?.followsGeneral;
  setText('openai-detail', online ? (follows ? '普通代理换线时，ChatGPT 的新连接也会换线。' : '新打开的 ChatGPT 连接按当前规则选线。') : '连接代理核心后显示');
  setText('fixed-tag', follows ? '跟随普通代理' : status.openai?.source || '正在读取');
  setText('version', status.version ? `版本 ${status.version}` : '');
  setText('region-status', !online ? '等待代理核心' : status.region?.liveHongKong ? `仍有 ${status.region.liveHongKong} 条香港连接，等待处理` :
    status.region?.coreExcluded ? '香港线路已从代理核心中排除' : '面板已禁选香港，正在核对代理核心');
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
  setText('general-node', selection && selection !== general ? `${selection} → ${general}` : general);
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
  select.value = names.includes(selection) ? selection : '';
  select.disabled = !connected(status) || !names.length || app.action || app.testingAll;
  const gpt = app.scope === 'openai';
  show('group-picker', !gpt && names.length > 0);
  const follow = $('gpt-follow');
  const canFollow = status.openai?.managed && status.openai?.options?.includes(status.general?.group);
  show('gpt-follow', gpt && canFollow);
  follow.disabled = !connected(status) || app.action || app.testingAll || status.openai?.followsGeneral;
  setText('gpt-follow', status.openai?.followsGeneral ? '已跟随普通代理' : '改为跟随普通代理');
  setText('scope-help', gpt ? fixedSupported(status) ? '选中线路后，ChatGPT 的新连接使用它。' :
    '可在「普通代理」中换线。当前由代理核心决定 ChatGPT 线路。' : '用于匹配代理规则的网站。ChatGPT 设为跟随时也会使用这条线路。');
}
function renderNodes() {
  const status = app.status || {}; const query = $('node-search').value.trim().toLocaleLowerCase(); const sort = $('node-sort').value;
  const nodes = (Array.isArray(status.nodes) ? status.nodes : []).filter((n) => n && typeof n.name === 'string');
  const configured = status.openai?.configured; const general = currentGeneral(status);
  const visible = nodes.filter((n) => n.name.toLocaleLowerCase().includes(query));
  const rank = (n) => n.name === configured ? 0 : n.name === general ? 1 : 2;
  visible.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : sort === 'delay' ? (Number(nodeDelay(a)) > 0 ? Number(nodeDelay(a)) : Infinity) - (Number(nodeDelay(b)) > 0 ? Number(nodeDelay(b)) : Infinity) : rank(a) - rank(b));
  setText('node-count', String(nodes.length)); const tbody = $('node-rows'); tbody.replaceChildren();
  show('node-empty', !visible.length); setText('node-empty', query ? '没有找到匹配线路，换个关键词试试。' : '暂无线路。连接代理核心后，线路会自动出现在这里。');
  for (const node of visible) {
    const row = element('tr', node.name === configured ? 'selected-row' : '');
    const nameCell = element('td'); const title = element('div', 'node-title'); title.append(element('span', 'name', node.name));
    if (node.name === configured) title.append(element('span', 'tag blue', 'GPT'));
    if (node.name === general) title.append(element('span', 'tag neutral', '普通'));
    nameCell.append(title);
    const delayCell = element('td'); const delay = Number(nodeDelay(node)); const result = app.testResults.get(node.name); const testing = app.testing.has(node.name);
    const delayLabel = testing ? '测速中…' : result?.error ? '暂不可用' : delay > 0 ? `${Math.round(delay)} ms` : '未测速';
    const delayClass = testing ? '' : result?.error ? 'failed' : delay > 0 ? delay < 600 ? 'fast' : delay < 1300 ? 'medium' : 'slow' : '';
    const delayEl = element('span', `delay ${delayClass}`, delayLabel); if (result?.error) delayEl.title = result.error; delayCell.append(delayEl);
    const actionsCell = element('td'); const actions = element('div', 'row-actions');
    const test = element('button', 'table-button test', testing ? '测速中' : '测速'); test.type = 'button'; test.disabled = !connected(status) || testing || app.testingAll; test.setAttribute('aria-label', `测试 ${node.name}`); test.addEventListener('click', () => testNodes([node.name]));
    const scope = app.scope;
    const gpt = scope === 'openai';
    const picked = gpt ? (status.openai?.managed ? status.openai.selection : configured) : status.general?.selection;
    const mayPick = gpt ? (status.openai?.managed ? status.openai.options.includes(node.name) : fixedSupported(status)) :
      status.general?.options?.includes(node.name);
    const choice = element('button', 'table-button' + (node.name === picked ? ' active-choice' : ''), node.name === picked ? '已选' : '使用此线路');
    choice.type = 'button';
    choice.disabled = !connected(status) || !mayPick || app.action || app.testingAll || node.name === picked;
    choice.setAttribute('aria-label', `${gpt ? 'ChatGPT' : '普通代理'}使用 ${node.name}`);
    choice.addEventListener('click', () => selectNode(scope, node.name));
    actions.append(test, choice); actionsCell.append(actions); row.append(nameCell, delayCell, actionsCell); tbody.append(row);
  }
}
async function refresh(manual = false, discover = false) {
  if (app.loading) return; app.loading = true; $('refresh-icon').classList.add('spinning');
  try { const result = manual || discover ? await api('/api/refresh', { discover }) : await api('/api/status'); renderStatus(result.status || result); if (manual) toast(discover ? '已重新寻找本机代理核心' : '连接状态已更新'); }
  catch (error) { if (manual) toast(error.message, true); if (!app.status) { setText('controller-label', '控制台未连接'); $('controller-pill').className = 'status-pill offline'; show('offline-banner', true); setText('offline-message', error.message); setText('openai-node', '暂时无法读取'); setText('openai-detail', '请确认控制台后台仍在运行'); } }
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
  if (app.status) renderGeneralPicker(app.status);
  try { const result = await api('/api/select', { scope, node }); toast(result.message || (scope === 'openai' ? 'ChatGPT 新连接已切换，已有会话可重新连接以使用新线路。' : '普通流量线路已切换')); await refresh(); }
  catch (error) { toast(error.message, true); }
  finally { app.action = false; if (app.status) renderStatus(app.status); }
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
$('gpt-follow').addEventListener('click', () => selectNode('openai', app.status?.general?.group));
function setScope(scope) {
  app.scope = scope;
  $('scope-gpt').setAttribute('aria-pressed', String(scope === 'openai'));
  $('scope-general').setAttribute('aria-pressed', String(scope === 'general'));
  if (app.status) renderGeneralPicker(app.status);
  renderNodes();
}
$('scope-gpt').addEventListener('click', () => setScope('openai'));
$('scope-general').addEventListener('click', () => setScope('general'));
$('choose-gpt').addEventListener('click', () => setScope('openai'));
$('node-search').addEventListener('input', renderNodes); $('node-sort').addEventListener('change', renderNodes);
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
