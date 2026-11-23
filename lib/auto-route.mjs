import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { api, testNodes } from './controller.mjs';
import { PROBE_GROUP, SPEED_HOST } from './regions.mjs';

const exec = promisify(execFile);
const SAMPLE_BYTES = 256 * 1024;
const LATENCY_LIMIT_MS = 1000;
const DOWNLOAD_LIMIT_MBPS = 1;
const SAMPLE_INTERVAL_MS = 300000;
const RECHECK_MS = 60000;
const SWITCH_COOLDOWN_MS = 180000;

export async function measureDownload(found, token, node) {
  const port = found.config.port || found.config['mixed-port'];
  if (process.platform !== 'win32' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const selector = '/proxies/' + encodeURIComponent(PROBE_GROUP);
  const original = (await api(found.url, token, selector)).now;
  try {
    if (original !== node) await api(found.url, token, selector, 'PUT', { name: node });
    if ((await api(found.url, token, selector)).now !== node) return null;
    const system = process.env.SystemRoot || 'C:\\Windows';
    const transfer = await exec(path.join(system, 'System32', 'curl.exe'), [
      '--silent', '--show-error', '--proto', '=https', '--noproxy', 'invalid.test',
      '--proxy', `http://127.0.0.1:${port}`, '--max-time', '8', '--max-filesize', String(SAMPLE_BYTES),
      '--output', 'NUL', '--write-out', '%{http_code} %{size_download} %{time_starttransfer} %{time_total}',
      `https://${SPEED_HOST}/__down?bytes=${SAMPLE_BYTES}&t=${Date.now()}`
    ], { windowsHide: true, timeout: 9500, maxBuffer: 16384 }).catch(error => {
      if (error.code === 28 && error.stdout) return error;
      throw error;
    });
    const [code, size, firstByte, end] = transfer.stdout.trim().split(/\s+/).map(Number);
    if ((await api(found.url, token, selector)).now !== node) return null;
    const downloadSeconds = end - firstByte;
    if (code !== 200 || !Number.isInteger(size) || size < 0 || size > SAMPLE_BYTES
        || !Number.isFinite(downloadSeconds) || downloadSeconds <= 0) return null;
    if (size !== SAMPLE_BYTES && (transfer.code !== 28 || downloadSeconds < 5)) return null;
    return size * 8 / downloadSeconds / 1e6;
  } catch {
    return null;
  } finally {
    if (original && original !== node) {
      try {
        if ((await api(found.url, token, selector)).now === node)
          await api(found.url, token, selector, 'PUT', { name: original });
      } catch {}
    }
  }
}

export function createRouteHealth() {
  const stats = { delay: null, downloadMbps: null };
  let node, sampledAt = 0, slowDelay = 0, slowDownload = 0;
  function track(name) {
    if (node === name) return;
    node = name;
    sampledAt = slowDelay = slowDownload = 0;
    stats.delay = stats.downloadMbps = null;
  }
  return {
    stats, track,
    needsDownload: now => now - sampledAt >= (slowDownload > 0 ? RECHECK_MS : SAMPLE_INTERVAL_MS),
    observe({ delay, downloadMbps, measuredDownload, now }) {
      stats.delay = delay;
      slowDelay = delay === null || delay >= LATENCY_LIMIT_MS ? slowDelay + 1 : 0;
      if (measuredDownload) {
        sampledAt = now;
        stats.downloadMbps = downloadMbps === null ? null : Math.round(downloadMbps * 10) / 10;
        slowDownload = downloadMbps !== null && downloadMbps < DOWNLOAD_LIMIT_MBPS ? slowDownload + 1 : 0;
      }
      return slowDownload >= 2 ? '下载速度持续偏低' :
        slowDelay >= 2 ? (delay === null ? '线路连续超时' : '延迟持续偏高') : null;
    }
  };
}

export function candidateIsBetter(current, candidate, reason) {
  if (!candidate.delay || candidate.delay >= LATENCY_LIMIT_MS) return false;
  if (reason === '下载速度持续偏低')
    return candidate.downloadMbps !== null && candidate.downloadMbps >= DOWNLOAD_LIMIT_MBPS
      && candidate.downloadMbps >= 1.35 * current.downloadMbps;
  return (current.delay === null || candidate.delay <= 0.75 * current.delay)
    && (candidate.downloadMbps === null || candidate.downloadMbps >= DOWNLOAD_LIMIT_MBPS);
}

export function startAutoRoute({ read, promote, setBusy }) {
  const health = createRouteHealth();
  const state = { ...health.stats, lastCheck: null, lastSwitch: null, message: null };
  let busy = false, cursor = 0, lastSwitchAt = 0;
  async function run() {
    if (busy) return;
    busy = true;
    setBusy(true);
    try {
      const context = await read();
      if (!context) return;
      const { found, token, node, candidates } = context;
      health.track(node);
      const now = Date.now();
      const measuredDownload = health.needsDownload(now);
      const [latency, downloadMbps] = await Promise.all([
        testNodes(found, token, [node]), measuredDownload ? measureDownload(found, token, node) : null
      ]);
      const reason = health.observe({ delay: latency[0]?.delay || null, downloadMbps, measuredDownload, now });
      Object.assign(state, health.stats, { lastCheck: new Date().toISOString(), message: reason });
      if (!reason || now - lastSwitchAt < SWITCH_COOLDOWN_MS || !candidates.length) return;
      const ranked = candidates.filter(candidate => candidate.name !== node)
        .sort((a, b) => (a.delay || Infinity) - (b.delay || Infinity));
      if (!ranked.length) return;
      const alternates = [...new Set([...ranked.slice(0, 3).map(candidate => candidate.name), ranked[cursor++ % ranked.length].name])];
      const tested = (await testNodes(found, token, alternates))
        .filter(candidate => candidate.delay > 0 && candidate.delay < LATENCY_LIMIT_MS)
        .sort((a, b) => a.delay - b.delay).slice(0, 2);
      for (const candidate of tested) {
        const mbps = await measureDownload(found, token, candidate.name);
        if (!candidateIsBetter(health.stats, { ...candidate, downloadMbps: mbps }, reason)) continue;
        if (await promote(context, candidate.name)) {
          lastSwitchAt = Date.now();
          health.track(candidate.name);
          Object.assign(state, health.stats, { lastSwitch: new Date(lastSwitchAt).toISOString(), message: `${reason}，已换到 ${candidate.name}` });
        }
        return;
      }
      state.message = `${reason}，暂未找到更好的线路`;
    } catch {
      state.message = '暂时无法完成测速';
    } finally {
      busy = false;
      setBusy(false);
    }
  }
  setTimeout(run, 2500).unref();
  setInterval(run, RECHECK_MS).unref();
  return { state, run };
}
