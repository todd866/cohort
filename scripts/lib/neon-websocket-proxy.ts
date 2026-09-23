/**
 * Route Neon's WebSocket transport through an HTTPS proxy when one is set.
 *
 * A Claude Code on the web container reaches the internet only through the
 * proxy in HTTPS_PROXY, which relays HTTPS on 443. Raw Postgres (5432) cannot
 * pass, but PrismaNeon speaks WebSocket on 443 and can — except that `ws`
 * ignores the proxy variables and dials the host directly, which the sandbox
 * refuses. With no proxy configured (the Mac) this returns plain `ws`, so
 * nothing changes there.
 */
import ws from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

type Env = Record<string, string | undefined>;

export function proxyForHost(host: string, env: Env): string | undefined {
  const proxy = env.HTTPS_PROXY || env.https_proxy;
  if (!proxy) return undefined;
  const bypass = (env.NO_PROXY || env.no_proxy || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const h = host.toLowerCase();
  for (const entry of bypass) {
    if (entry === '*' || h === entry.replace(/^\./, '')) return undefined;
    if (entry.startsWith('.') ? h.endsWith(entry) : h.endsWith(`.${entry}`)) return undefined;
  }
  return proxy;
}

export function neonWebSocketConstructor(env: Env = process.env): typeof ws {
  if (!(env.HTTPS_PROXY || env.https_proxy)) return ws;
  class ProxiedWebSocket extends ws {
    // ws takes (address, options) as well as (address, protocols, options).
    constructor(
      address: string | URL,
      protocolsOrOptions?: string | string[] | ws.ClientOptions,
      maybeOptions?: ws.ClientOptions,
    ) {
      const optionsFirst = typeof protocolsOrOptions === 'object' && !Array.isArray(protocolsOrOptions);
      const protocols = optionsFirst ? undefined : protocolsOrOptions;
      const options = optionsFirst ? protocolsOrOptions : maybeOptions;
      const proxy = proxyForHost(new URL(String(address)).hostname, env);
      super(address, protocols, proxy ? { ...options, agent: new HttpsProxyAgent(proxy) } : options);
    }
  }
  // Only the constructor signature differs, and it accepts every ws call form.
  return ProxiedWebSocket as typeof ws;
}
