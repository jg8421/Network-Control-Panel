import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const intervalMs = 15000;
const probeIntervalMs = 90000;

export const ordinaryTarget = (region, manual) => region === 'HK' && !manual ? 'DIRECT' : 'SELECT';

export function traceRegion(text) {
  if (!text.split(/\r?\n/).includes('status=200')) return null;
  const matches = [...text.matchAll(/^loc=([A-Z]{2})\r?$/gm)];
  return matches.length === 1 ? matches[0][1] : null;
}

async function detectRegion() {
  const system = process.env.SystemRoot || 'C:\\Windows';
  try {
    const { stdout } = await exec(path.join(system, 'System32', 'curl.exe'), [
      '--disable', '--silent', '--show-error', '--noproxy', '*', '--proxy', '',
      '--proto', '=https', '--max-time', '7', '--max-filesize', '4096',
      '--write-out', '\nstatus=%{http_code}\n', 'https://www.cloudflare.com/cdn-cgi/trace'
    ], { windowsHide: true, timeout: 8000, maxBuffer: 8192 });
    return traceRegion(stdout);
  } catch {
    return null;
  }
}

function networkFingerprint() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
    addresses.filter(item => !item.internal && item.family === 'IPv4').map(item => name + ':' + item.address)
  ).sort().join('|');
}

export function startNetworkRoute({ supported, apply }) {
  const state = { region: null, checkedAt: null };
  let fingerprint, checked = 0, busy = false;
  async function run() {
    if (busy || process.platform !== 'win32' || !supported()) return;
    busy = true;
    try {
      const current = networkFingerprint();
      if (fingerprint !== current || Date.now() - checked >= probeIntervalMs) {
        const changed = fingerprint !== undefined && fingerprint !== current;
        fingerprint = current;
        if (changed) {
          state.region = null;
          await apply(null);
        }
        const detected = await detectRegion();
        state.region = current === networkFingerprint() ? detected : null;
        checked = Date.now();
        state.checkedAt = new Date(checked).toISOString();
      }
      await apply(state.region);
    } catch {
      // If the core is restarting, the next tick verifies the target again.
    } finally {
      busy = false;
    }
  }
  setTimeout(run, 1200).unref();
  setInterval(run, intervalMs).unref();
  return { state, run };
}
