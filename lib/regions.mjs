const hongKong = /🇭🇰|香港|hong[\s_.-]*kong|(?:^|[^a-z])(?:hkg|hk)(?=$|[^a-z])/iu;
export const isHongKong = name => typeof name === 'string' && hongKong.test(name.normalize('NFKC'));
export const GPT_GROUP = 'ChatGPT';
export const GPT_DOMAINS = ['chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com', 'oaistatsig.com'];
export const isGptHost = host => GPT_DOMAINS.some(domain => host === domain || host.endsWith('.' + domain));

// A selector, URL test, fallback, or relay can all reach members other than "now".
export function containsHongKong(proxies, name, visited = new Set()) {
  if (isHongKong(name)) return true;
  if (!name || visited.has(name)) return false;
  visited.add(name);
  const proxy = proxies[name];
  return Boolean(proxy?.all?.some(member => containsHongKong(proxies, member, visited))
    || (proxy?.now && containsHongKong(proxies, proxy.now, visited)));
}

export function hongKongExcluded(proxies) {
  return Object.entries(proxies).every(([name, proxy]) => !isHongKong(name)
    && !isHongKong(proxy.now) && !proxy.all?.some(isHongKong));
}
