import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { api, effective } from './controller.mjs';
import { atomicWrite, jsonFile, portHints, powershell, systemProxy, setSystemProxy } from './windows.mjs';
import { AI_DOMAINS, GPT_GROUP, ORDINARY_GROUP, PROBE_GROUP, SPEED_HOST, containsHongKong, hongKongExcluded, isHongKong } from './regions.mjs';
import { prepareSaturnProfile, routeOrdinaryRule } from './saturn-profile.mjs';
const exec = promisify(execFile);
const BEGIN = '    # JERRY-DOMESTIC-DIRECT-BEGIN';
const END = '    # JERRY-DOMESTIC-DIRECT-END';
const EXTRA_BEGIN = '    # JERRY-OVERSEAS-PROXY-BEGIN';
const EXTRA_END = '    # JERRY-OVERSEAS-PROXY-END';
export function renderRules(text, policy) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rows = text.split(/\r?\n/);
  const start = rows.findIndex(l => /^rules:\s*(?:#.*)?$/.test(l));
  if (start < 0) throw new Error('rules section missing');
  let end = start + 1;
  while (end < rows.length && !/^\S/.test(rows[end])) end++;
  let managed = false;
  const rest = rows.slice(start + 1, end).filter(l => {
    if ([BEGIN, EXTRA_BEGIN].includes(l)) { managed = true; return false; }
    if ([END, EXTRA_END].includes(l)) { managed = false; return false; }
    return !managed && !/^\s+-\s+['"]?MATCH,/i.test(l);
  });
  while (rest.length && !rest.at(-1).trim()) rest.pop();
  const existing = new Set(rest.map(l => l.match(/^\s+-\s+['"]?(.+?)['"]?\s*$/)?.[1]).filter(Boolean).map(routeOrdinaryRule));
  const direct = policy.directDomains.map(d => `DOMAIN-SUFFIX,${d},DIRECT`);
  const overseas = policy.proxyDomains.map(d => `DOMAIN-SUFFIX,${d},${ORDINARY_GROUP}`).filter(r => !existing.has(r));
  rows.splice(start + 1, end - start - 1, BEGIN, ...direct.map(r => `    - '${r}'`), END,
    ...rest, EXTRA_BEGIN, ...overseas.map(r => `    - '${r}'`), EXTRA_END, "    - 'MATCH,DIRECT'");
  return rows.join(eol);
}
function liveCorrect(config, rules, policy) {
  return config.mode === 'rule' && rules.at(-1)?.type === 'Match' && rules.at(-1)?.proxy === 'DIRECT'
    && policy.directDomains.every((d,i) => rules[i]?.type === 'DomainSuffix' && rules[i]?.payload === d && rules[i]?.proxy === 'DIRECT')
    && policy.proxyDomains.every(d => rules.some(r => r.type === 'DomainSuffix' && r.payload === d && r.proxy === ORDINARY_GROUP));
}
function livePorts(text, config) {
  for (const k of ['port', 'socks-port', 'mixed-port', 'redir-port', 'tproxy-port']) {
    if (Number.isInteger(config[k])) {
      const re = new RegExp('^' + k + ':.*$', 'm');
      text = re.test(text) ? text.replace(re, `${k}: ${config[k]}`) : text + `\n${k}: ${config[k]}\n`;
    }
  }
  return text.replace(/^mode:.*$/m, 'mode: rule');
}
function profileCorrect(config, rules, proxies) {
  return config.mode === 'rule' && proxies[GPT_GROUP]?.type === 'Selector'
    && proxies[PROBE_GROUP]?.type === 'Selector'
    && proxies[ORDINARY_GROUP]?.type === 'Selector'
    && !rules.some(rule => rule.proxy === 'SELECT')
    && rules.find(rule => rule.payload === SPEED_HOST && /domain/i.test(rule.type))?.proxy === PROBE_GROUP
    && hongKongExcluded(proxies) && !rules.some(rule => isHongKong(rule.proxy))
    && AI_DOMAINS.every(domain => rules.find(rule => rule.payload === domain && /domain/i.test(rule.type))?.proxy === GPT_GROUP);
}

export function startDirectGuard(stateRoot, { canRun, preferredGpt }) {
  const health = { enabled: false, ok: false, hongKongExcluded: false, lastCheck: null, lastReload: null, error: null, controllerUrl: null };
  let running, lastBypass = 0;
  const check = async () => {
    health.lastCheck = new Date().toISOString();
    try {
      if (process.platform !== 'win32' || process.env.PANEL_PROFILE_GUARD === 'off') return;
      const ports = await portHints();
      if (!ports) return;
      const policy = await jsonFile(path.join(stateRoot, 'routing-policy.json'));
      const tidalab = path.join(process.env.APPDATA, 'tidalab');
      const configFile = path.join(tidalab, 'config.yaml');
      const token = (await fs.readFile(path.join(tidalab, 'token'), 'utf8')).trim();
      const url = `http://127.0.0.1:${ports[2]}`;
      health.controllerUrl = url;
      health.enabled = !!policy;
      const [config, rules, proxies] = await Promise.all([api(url,token,'/configs'), api(url,token,'/rules'), api(url,token,'/proxies')]);
      if (!proxies.proxies.SELECT) throw new Error('SELECT group missing');
      const original = await fs.readFile(configFile, 'utf8');
      if (!policy && config.mode !== 'rule') throw new Error('Expected rule mode');
      const updated = livePorts(prepareSaturnProfile(policy ? renderRules(original, policy) : original), config);
      const needReload = !profileCorrect(config, rules.rules, proxies.proxies) || (policy && !liveCorrect(config, rules.rules, policy));
      let after = proxies.proxies;
      if (updated !== original || needReload) {
        const candidate = path.join(stateRoot, 'routing-candidate.yaml');
        await atomicWrite(candidate, updated);
        const core = path.join(process.env.ProgramFiles, 'tidalab/resources/libs/win32/clash.exe');
        await exec(core, ['-t','-d',path.dirname(core),'-f',candidate], {windowsHide:true,timeout:15000,maxBuffer:65536});
        try { await fs.copyFile(configFile, path.join(stateRoot,'config.before-region-policy.yaml'), fs.constants.COPYFILE_EXCL); } catch(e) { if(e.code !== 'EEXIST') throw e; }
        if (await fs.readFile(configFile,'utf8') !== original) throw new Error('configuration changed; retry next check');
        if (updated !== original) await atomicWrite(configFile, updated);
        if (needReload) {
          const selections = Object.entries(proxies.proxies).filter(([,v]) => v.type === 'Selector' && v.now && !isHongKong(v.now))
            .map(([name,v]) => [name,name === GPT_GROUP && v.now === 'SELECT' ? effective(proxies.proxies, 'SELECT') : v.now]);
          try {
            await api(url, token, '/configs', 'PUT', {payload:updated}, 15000);
            after = (await api(url,token,'/proxies')).proxies;
            for (const [name,selected] of selections) {
              if (after[name]?.now !== selected && after[name]?.all?.includes(selected) && !containsHongKong(after, selected))
                await api(url,token,'/proxies/'+encodeURIComponent(name),'PUT',{name:selected});
            }
            const [c,r,p] = await Promise.all([api(url,token,'/configs'),api(url,token,'/rules'),api(url,token,'/proxies')]);
            after = p.proxies;
            if (!profileCorrect(c,r.rules,after) || (policy && !liveCorrect(c,r.rules,policy))) throw new Error('route verification failed');
            health.lastReload = new Date().toISOString();
          } catch(e) {
            if (await fs.readFile(configFile,'utf8') === updated) await atomicWrite(configFile,original);
            try { await api(url,token,'/configs','PUT',{payload:livePorts(original,config)}); } catch {}
            throw e;
          }
        }
      }
      const wanted = preferredGpt();
      if (wanted && after[GPT_GROUP]?.now !== wanted && after[GPT_GROUP]?.all?.includes(wanted) && !containsHongKong(after, wanted)) {
        await api(url,token,'/proxies/'+encodeURIComponent(GPT_GROUP),'PUT',{name:wanted});
      }
      const { connections = [] } = await api(url,token,'/connections');
      for (const connection of connections.filter(connection => connection.chains?.some(isHongKong))) {
        await api(url, token, '/connections/' + encodeURIComponent(connection.id), 'DELETE');
      }
      health.hongKongExcluded = true;
      if (policy && Date.now() - lastBypass > 60000) {
        const required = ['localhost','127.*','[::1]',...policy.directDomains.flatMap(d => [d,'*.'+d])];
        const current = await systemProxy(true);
        const have = new Set((current.bypass || '').split(';').map(s => s.toLowerCase()));
        if (required.some(d => !have.has(d.toLowerCase()))) {
          await powershell("$x=([Console]::In.ReadToEnd() | ConvertFrom-Json); $k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; $p=Get-ItemProperty -LiteralPath $k; $all=@(([string]$p.ProxyOverride -split ';') + @($x.required)) | Where-Object {$_} | Select-Object -Unique; Set-ItemProperty -LiteralPath $k -Name ProxyOverride -Value ($all -join ';')", {required});
          const confirmed = await systemProxy(true);
          if (confirmed.enabled && confirmed.server === `127.0.0.1:${config.port}`) await setSystemProxy(true, config.port);
        }
        lastBypass = Date.now();
      }
      health.ok = !!policy; health.error = null;
    } catch {
      health.ok = false;
      health.hongKongExcluded = false;
      health.error = '代理配置检查未完成，稍后自动重试';
    }
  };
  const run = () => {
    if (!running && canRun()) running = check().finally(() => { running = null; });
    return running;
  };
  run();
  const timer = setInterval(run, 30000); timer.unref();
  return { health, wait: () => running };
}
