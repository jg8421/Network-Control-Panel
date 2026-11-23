import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export const isWindows = process.platform === 'win32';
const home = process.env.USERPROFILE || process.env.HOME || '';
const program = process.env.ProgramFiles || 'C:\\Program Files';
const psExe = isWindows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : '';
export async function exists(p) { try { return (await fs.stat(p)).isFile(); } catch { return false; } }
export async function jsonFile(p) { try { return JSON.parse((await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; } }
export async function atomicWrite(p, bytes) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const temp = p + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fs.writeFile(temp, bytes, { mode: 0o600 });
  try { await fs.rename(temp, p); } catch (e) { await fs.rm(temp, { force: true }); throw e; }
}
export async function powershell(script, data = null, timeout = 15000) {
  if (!isWindows) throw new Error('此操作需要 Windows');
  script = "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Text.UTF8Encoding]::new($false); " + script;
  return await new Promise((resolve, reject) => {
    const child = execFile(psExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(new Error('Windows 操作未完成，请检查权限或后台程序。'));
      else resolve(stdout.replace(/^\uFEFF/, '').trim());
    });
    child.stdin.end(data === null ? '' : JSON.stringify(data));
  });
}
export async function protectToken(token) {
  if (!token) return '';
  if (!isWindows) throw new Error('仅 Windows 支持保存控制接口密钥');
  return powershell("Add-Type -AssemblyName System.Security; $x=([Console]::In.ReadToEnd() | ConvertFrom-Json); $b=[Text.Encoding]::UTF8.GetBytes([string]$x.token); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))", { token });
}
export async function unprotectToken(encrypted) {
  if (!encrypted) return '';
  return powershell("Add-Type -AssemblyName System.Security; $x=([Console]::In.ReadToEnd() | ConvertFrom-Json); $b=[Convert]::FromBase64String([string]$x.value); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))", { value: encrypted });
}
export async function portHints() {
  const ports = await jsonFile(path.join(process.env.APPDATA || '', 'tidalab/ports'));
  return Array.isArray(ports) && ports.length === 3 && ports.every(n => Number.isInteger(n) && n > 0 && n < 65536) ? ports : null;
}
export async function controllerPorts() {
  if (!isWindows) return [];
  const result = await powershell("$ids=@(Get-Process -Name clash,mihomo,clash-meta -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id); if($ids.Count -gt 0){@(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object {$_.OwningProcess -in $ids -and $_.RemotePort -eq 0 -and $_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::')} | Select-Object -ExpandProperty LocalPort -Unique | Select-Object -First 12) | ConvertTo-Json -Compress}", null, 10000);
  try { const j = JSON.parse(result || '[]'); return (Array.isArray(j) ? j : [j]).filter(n => Number.isInteger(n) && n > 0 && n < 65536); } catch { return []; }
}
let proxyCache = null;
export async function systemProxy(force = false) {
  if (!isWindows) return { available: false, enabled: false, server: '' };
  if (!force && proxyCache && Date.now() - proxyCache.at < 5000) return proxyCache.value;
  try {
    const out = await powershell("$p=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; @{enabled=([int]$p.ProxyEnable -eq 1);server=[string]$p.ProxyServer;bypass=[string]$p.ProxyOverride} | ConvertTo-Json -Compress");
    const p = JSON.parse(out); proxyCache = { at: Date.now(), value: { available: true, ...p } }; return proxyCache.value;
  } catch { return { available: false, enabled: false, server: '' }; }
}
export async function saturnPaths() {
  for (const base of [program, process.env['ProgramFiles(x86)'], path.join(process.env.LOCALAPPDATA || '', 'Programs')].filter(Boolean)) {
    const app = path.join(base, 'tidalab/土星通信.exe');
    const sysproxy = path.join(base, 'tidalab/resources/libs/win32/sysproxy.exe');
    if (await exists(app)) return { app, sysproxy: await exists(sysproxy) ? sysproxy : null };
  }
  return null;
}
export async function setSystemProxy(enabled, httpPort) {
  const current = await systemProxy(true); const saturn = await saturnPaths();
  if (!saturn?.sysproxy) throw new Error('没有找到已安装的系统代理控制程序');
  if (enabled && (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535)) throw new Error('后台没有提供可用的 HTTP 代理端口');
  const bypass = [...new Set((current.bypass || '').split(';').filter(Boolean).concat(['<local>', 'localhost', '127.*', '[::1]']))].join(';');
  await execute(saturn.sysproxy, enabled ? ['global', '127.0.0.1:' + httpPort, bypass] : ['off'], { windowsHide: true, timeout: 10000 });
  const confirmed = await systemProxy(true);
  if (confirmed.enabled !== enabled) throw new Error('系统代理状态读回不一致');
  return confirmed;
}
export async function startEngine() {
  const found = await saturnPaths(); if (!found) throw new Error('此电脑尚未安装并配置土星通信，请先完成原代理安装。');
  await powershell("$x=([Console]::In.ReadToEnd()|ConvertFrom-Json); $running=Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq [string]$x.app}; if(-not $running){Start-Process -FilePath ([string]$x.app) -WorkingDirectory (Split-Path -LiteralPath ([string]$x.app)) -WindowStyle Minimized | Out-Null}", { app: found.app });
}
export const bridgePaths = {
  routeFile: path.join(home, 'traffic-monitor/office-openai-route.json'),
  guard: path.join(home, 'traffic-monitor/clash-direct-guard.mjs'),
  manage: path.join(program, 'JerryChatGPTRoute/Manage-Route.ps1')
};
export async function routeStatus() {
  const dataRoot = path.join(process.env.ProgramData || 'C:\\ProgramData', 'JerryChatGPTRoute');
  for (const p of [path.join(dataRoot, process.env.COMPUTERNAME || '', 'status.json'), path.join(dataRoot, 'status.json')]) {
    const s = await jsonFile(p);
    if (s) return { available: await exists(bridgePaths.manage), status: s.status || s.phase || 'unknown', expires: s.expires ?? null, time: s.time || null };
  }
  return { available: await exists(bridgePaths.manage), status: 'not-installed', expires: null };
}
export async function controlRoute(mode) {
  if (!['Resume', 'Pause'].includes(mode) || !await exists(bridgePaths.manage)) throw new Error('本机没有兼容的远程通道管理入口');
  await execute(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bridgePaths.manage, '-Mode', mode], { windowsHide: true, timeout: 90000, maxBuffer: 128000 });
}
export async function setFixedRoute(node, verify = async () => {}) {
  if (!await exists(bridgePaths.guard) || !await exists(bridgePaths.routeFile)) throw new Error('此电脑尚未配置 ChatGPT 专用线路，可先切换通用线路。');
  const original = await fs.readFile(bridgePaths.routeFile, 'utf8'); const data = JSON.parse(original.replace(/^\uFEFF/, ''));
  data.proxy = node;
  if (await fs.readFile(bridgePaths.routeFile, 'utf8') !== original) throw new Error('线路设置刚被其他程序修改，请刷新后重试');
  await atomicWrite(bridgePaths.routeFile + '.panel-backup.json', original);
  const updated = JSON.stringify(data, null, 2) + '\n';
  await atomicWrite(bridgePaths.routeFile, updated);
  try {
    await execute(process.execPath, [bridgePaths.guard, '--reload'], { windowsHide: true, timeout: 25000, maxBuffer: 256000 });
    await verify();
  }
  catch {
    if (await fs.readFile(bridgePaths.routeFile, 'utf8') !== updated) throw new Error('线路设置被其他程序更新，已保留该更新。请刷新检查。');
    await atomicWrite(bridgePaths.routeFile, original);
    try { await execute(process.execPath, [bridgePaths.guard, '--reload'], { windowsHide: true, timeout: 25000, maxBuffer: 256000 }); } catch { /* report failure, never expose guard output */ }
    throw new Error('线路切换未通过验证，已恢复设置。请刷新检查后台状态。');
  }
}
