// Keep-alive fetch for the RPC connections (read RPC_URL and the send/SWQoS
// SEND_RPC_URL). Uses an undici dispatcher with long keep-alive so the TCP+TLS
// connection to the co-located ERPC endpoint stays warm between sends.
// If HTTP(S)_PROXY is set (e.g. a sandbox with NODE_USE_ENV_PROXY=1) the
// EnvHttpProxyAgent variant is used so the proxy is still honoured.
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

export interface KeepAliveOptions {
  /** Idle socket lifetime (ms). Servers may still close earlier. */
  keepAliveTimeoutMs?: number;
  /** Max sockets per origin. */
  connections?: number;
}

export function keepAliveDispatcher(o: KeepAliveOptions = {}): Dispatcher {
  const opts = {
    keepAliveTimeout: o.keepAliveTimeoutMs ?? 60_000,
    keepAliveMaxTimeout: Math.max(o.keepAliveTimeoutMs ?? 60_000, 600_000),
    connections: o.connections ?? 16,
    pipelining: 1,
    connect: { noDelay: true, keepAlive: true, keepAliveInitialDelay: 10_000 },
  };
  const proxied = !!(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
  return proxied ? new EnvHttpProxyAgent(opts) : new Agent(opts);
}

/** A fetch(url, init) for web3.js Connection({ fetch }) bound to a keep-alive dispatcher. */
export function keepAliveFetch(o: KeepAliveOptions = {}): typeof globalThis.fetch {
  const dispatcher = keepAliveDispatcher(o);
  const f = (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) =>
    // web3.js passes a node `agent` option meant for node-fetch; undici ignores it.
    undiciFetch(input as never, { ...(init as object), dispatcher } as never) as unknown as Promise<Response>;
  return f as typeof globalThis.fetch;
}
