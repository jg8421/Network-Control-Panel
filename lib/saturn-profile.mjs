import { parse, stringify } from 'yaml';
import { GPT_DOMAINS, GPT_GROUP, isHongKong } from './regions.mjs';

function sections(text, output, update) {
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const key of update) {
    const start = lines.findIndex(line => line.startsWith(key + ':'));
    if (start < 0) throw new Error('Missing supported profile section');
    let end = start + 1;
    while (end < lines.length && !/^\S/.test(lines[end])) end++;
    const snippet = stringify({ [key]: output[key] }, { indent: 4, lineWidth: 0 }).trimEnd();
    lines.splice(start, end - start, ...snippet.split('\n'));
  }
  const result = lines.join(eol);
  return text.endsWith(eol) && !result.endsWith(eol) ? result + eol : result;
}

function updateRules(text, rules) {
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const start = lines.findIndex(line => /^rules:\s*$/.test(line)) + 1;
  if (!start) throw new Error('Unsupported rules section');
  let end = start;
  while (end < lines.length && !/^\S/.test(lines[end])) end++;
  const ruleLines = lines.slice(start, end).filter(line => /^\s+-\s+/.test(line));
  if (ruleLines.length !== rules.length) throw new Error('Unsupported multiline rules');
  const gptRules = GPT_DOMAINS.map(domain => `DOMAIN-SUFFIX,${domain},${GPT_GROUP}`);
  const current = [];
  let index = 0;
  let inserted = false;
  const indent = ruleLines[0]?.match(/^\s+/)?.[0] || '    ';
  for (const line of lines.slice(start, end)) {
    if (!/^\s+-\s+/.test(line)) {
      current.push(line);
      if (line.trim() === '# JERRY-DOMESTIC-DIRECT-END' && !inserted) {
        current.push(...gptRules.map(rule => indent + '- ' + JSON.stringify(rule)));
        inserted = true;
      }
      continue;
    }
    const rule = rules[index++];
    if (typeof rule !== 'string') throw new Error('Unexpected rule format');
    if (gptRules.includes(rule)) continue;
    if (!inserted && !rule.endsWith(',DIRECT')) {
      current.push(...gptRules.map(rule => indent + '- ' + JSON.stringify(rule)));
      inserted = true;
    }
    const parts = rule.split(',');
    const target = parts.at(-1)?.toLowerCase() === 'no-resolve' ? parts.length - 2 : parts.length - 1;
    if (isHongKong(parts[target]?.trim())) {
      parts[target] = 'SELECT';
      current.push(indent + '- ' + JSON.stringify(parts.join(',')));
    } else current.push(line);
  }
  if (!inserted) throw new Error('Expected a non-direct routing rule');
  lines.splice(start, end - start, ...current);
  return lines.join(eol);
}

export function prepareSaturnProfile(text) {
  const profile = parse(text);
  const { proxies, 'proxy-groups': groups, rules } = profile || {};
  if (!Array.isArray(proxies) || !Array.isArray(groups) || !Array.isArray(rules)
      || !groups.some(group => group.name === 'SELECT' && group.type === 'select')
      || Object.keys(profile['proxy-providers'] || {}).length
      || groups.some(group => !Array.isArray(group.proxies) || group.use?.length)) {
    throw new Error('Unsupported subscription profile');
  }
  const allowed = proxies.filter(proxy => !isHongKong(proxy.name));
  const names = allowed.map(proxy => proxy.name);
  if (names.length === 0) throw new Error('No eligible non-Hong-Kong proxy nodes');
  const nextGroups = groups.filter(group => !isHongKong(group.name)).map(group => {
    const members = group.proxies.filter(name => !isHongKong(name));
    return members.length ? { ...group, proxies: members } : { name: group.name, type: 'select', proxies: ['REJECT'] };
  });
  const selector = { name: GPT_GROUP, type: 'select', proxies: ['SELECT', ...names] };
  const gptIndex = nextGroups.findIndex(group => group.name === GPT_GROUP);
  if (gptIndex < 0) nextGroups.push(selector);
  else nextGroups[gptIndex] = selector;

  const updated = { proxies: allowed, 'proxy-groups': nextGroups };
  const changed = Object.keys(updated).filter(key => JSON.stringify(profile[key]) !== JSON.stringify(updated[key]));
  return updateRules(changed.length ? sections(text, updated, changed) : text, rules);
}
