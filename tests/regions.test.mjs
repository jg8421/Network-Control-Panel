import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'yaml';
import { renderRules } from '../lib/direct-guard.mjs';
import { GPT_DOMAINS, containsHongKong, isHongKong } from '../lib/regions.mjs';
import { prepareSaturnProfile } from '../lib/saturn-profile.mjs';
import { summarize } from '../lib/controller.mjs';

const policy = { directDomains: ['cn', 'outlook.com', 'sharepoint.com'], proxyDomains: ['github.com'] };
const fixture = `mode: rule
proxies:
    - {name: '🇭🇰香港-1', type: trojan, server: fixture.invalid, port: 443}
    - {name: '🇯🇵日本', type: trojan, server: fixture.invalid, port: 443}
    - {name: '台北', type: trojan, server: fixture.invalid, port: 443}
proxy-groups:
    - {name: SELECT, type: select, proxies: [自动选择, '🇭🇰香港-1', '🇯🇵日本', 台北]}
    - {name: 自动选择, type: url-test, proxies: ['🇭🇰香港-1', '🇯🇵日本', 台北], url: 'https://fixture.invalid', interval: 300}
    - {name: 故障转移, type: fallback, proxies: ['🇭🇰香港-1'], url: 'https://fixture.invalid', interval: 300}
rules:
    - 'DOMAIN-SUFFIX,chatgpt.com,SELECT'
    - 'DOMAIN-SUFFIX,example.invalid,🇭🇰香港-1'
    - 'MATCH,SELECT'
`;

test('removes Hong Kong from the whole profile, preserves direct rules and stays idempotent', () => {
  const update = text => prepareSaturnProfile(renderRules(text, policy));
  const actual = update(fixture);
  assert.equal(update(actual), actual);
  const profile = parse(actual);
  assert.deepEqual(profile.proxies.map(proxy => proxy.name), ['🇯🇵日本', '台北']);
  const groups = Object.fromEntries(profile['proxy-groups'].map(group => [group.name, group]));
  assert.deepEqual(groups.SELECT.proxies, ['自动选择', '🇯🇵日本', '台北']);
  assert.deepEqual(groups.自动选择.proxies, ['🇯🇵日本', '台北']);
  assert.deepEqual(groups.故障转移.proxies, ['REJECT']);
  assert.deepEqual(groups.ChatGPT.proxies, ['SELECT', '🇯🇵日本', '台北']);
  assert.deepEqual(profile.rules.slice(0, 3), policy.directDomains.map(domain => `DOMAIN-SUFFIX,${domain},DIRECT`));
  assert.deepEqual(profile.rules.slice(3, 3 + GPT_DOMAINS.length), GPT_DOMAINS.map(domain => `DOMAIN-SUFFIX,${domain},ChatGPT`));
  assert(profile.rules.includes('DOMAIN-SUFFIX,example.invalid,SELECT'));
  assert.equal(profile.rules.at(-1), 'MATCH,DIRECT');
});

test('blocks nested automatic groups even when their selected exit is allowed', () => {
  for (const name of ['香港01', '🇭🇰-02', 'HK01', 'Hong-Kong', 'HKG West', 'ＨＫ 3']) assert(isHongKong(name), name);
  for (const name of ['台湾HINET-2', '新加坡', '日本東京', '美国西雅图', 'Frankfurt']) assert(!isHongKong(name), name);
  const proxies = { Auto: { all: ['Fallback'], now: 'Japan' }, Fallback: { all: ['Japan', 'HK01'] }, Japan: {} };
  assert(containsHongKong(proxies, 'Auto'));
  assert(!containsHongKong(proxies, 'Japan'));
});

test('reports new ChatGPT policy independently of older connection chains', () => {
  const proxies = { SELECT: { type: 'Selector', all: ['Japan', 'Singapore'], now: 'Japan' },
    ChatGPT: { type: 'Selector', all: ['SELECT', 'Singapore'], now: 'SELECT' }, Japan: {}, Singapore: {} };
  const rules = { rules: GPT_DOMAINS.map(payload => ({ type: 'DomainSuffix', payload, proxy: 'ChatGPT' })) };
  const old = { connections: [{ metadata: { host: 'cdn.oaistatic.com' }, chains: ['Singapore', 'ChatGPT'] },
    { metadata: { host: 'chatgpt.com.example.invalid' }, chains: ['HK-1'] }] };
  const status = () => summarize({ proxies, config: { mode: 'rule' } }, rules, old, null);
  assert.equal(status().openai.followsGeneral, true);
  assert.equal(status().openai.configured, 'Japan');
  assert.deepEqual(status().openai.live, [{ node: 'Singapore', count: 1 }]);
  proxies.ChatGPT.now = 'Singapore';
  assert.equal(status().openai.followsGeneral, false);
  assert.equal(status().openai.configured, 'Singapore');
  assert.equal(status().general.effectiveNode, 'Japan');
});
