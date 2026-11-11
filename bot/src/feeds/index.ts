// Infrastructure wiring (ERPC VPS / Geyser gRPC / Shreds / SWQoS send endpoint),
// all optional and env-driven. With nothing configured this reproduces the
// original behaviour: one RPC connection, per-tick polling, sleep between ticks.
import { Connection } from "@solana/web3.js";
import type { Config } from "../config.js";
import type { StateSource } from "../types.js";
import type { StateManager, StateProvider } from "../engine/state.js";
import { ChangeSignal } from "./signal.js";
import { GrpcProvider, yellowstoneConnect } from "./grpc.js";
import { AltCache, PendingActivity, ShredFeed, defaultWatchSet, grpcEntriesConnect } from "./shreds.js";
import { keepAliveFetch } from "./http.js";

/** Read connection: keep-alive fetch (honours HTTP(S)_PROXY), optional WS_URL. */
export function makeReadConnection(cfg: Config): Connection {
  return new Connection(cfg.rpcUrl, { commitment: cfg.commitment, fetch: keepAliveFetch(), ...(cfg.wsUrl ? { wsEndpoint: cfg.wsUrl } : {}) });
}

export interface Infra {
  /** Where sendRawTransaction goes (SEND_RPC_URL), or undefined to use the read connection. */
  sendConn?: Connection;
  signal: ChangeSignal;
  /** Pass to ArbEngine as `stateProvider` (undefined => plain polling). */
  stateProvider?: (sources: StateSource[], polling: StateManager) => StateProvider;
  pending?: PendingActivity;
  grpc?: GrpcProvider;
  shreds?: ShredFeed;
  /** True when a push feed can wake the loop early. */
  eventDriven: boolean;
  /** Wait for a feed event or up to ms; resolves with the trigger reason ("timeout" if none). */
  wait(ms: number): Promise<string>;
  start(): void;
  close(): void;
  describe(): Record<string, string>;
}

export function setupInfra(cfg: Config, conn: Connection, log: (m: string) => void = console.log): Infra {
  const signal = new ChangeSignal();
  const sendConn = cfg.sendRpcUrl ? new Connection(cfg.sendRpcUrl, { commitment: cfg.commitment, fetch: keepAliveFetch({ connections: 4 }) }) : undefined;
  let grpc: GrpcProvider | undefined;
  const g = cfg.grpc;
  const stateProvider = g
    ? (_sources: StateSource[], polling: StateManager) => {
        grpc = new GrpcProvider(polling, {
          connect: yellowstoneConnect(g.endpoint, g.xToken),
          commitment: g.commitment, pingMs: g.pingMs, staleMs: g.staleMs, debounceMs: g.debounceMs,
          reconnectMinMs: g.reconnectMinMs, reconnectMaxMs: g.reconnectMaxMs, signal, log,
        });
        return grpc;
      }
    : undefined;

  let pending: PendingActivity | undefined;
  let shreds: ShredFeed | undefined;
  const s = cfg.shreds;
  if (s) {
    pending = new PendingActivity(s.holdWindowMs);
    const watch = defaultWatchSet([cfg.user.toBase58()]);
    shreds = new ShredFeed({
      connect: grpcEntriesConnect(s.endpoint, s.xToken),
      watch,
      request: s.serverFilter ? { accountInclude: [watch.riseProgram, watch.pool, ...watch.reserves], commitment: 0 } : {},
      resolver: s.resolveLookupTables ? new AltCache(conn, 5000, log) : undefined,
      pending, signal, staleMs: s.staleMs, log,
    });
  }

  let warm: ReturnType<typeof setInterval> | null = null;
  const eventDriven = !!(g || s);
  return {
    sendConn, signal, stateProvider, pending, shreds,
    get grpc() { return grpc; },
    eventDriven,
    wait: (ms: number) => (eventDriven ? signal.wait(ms) : new Promise<string>((r) => setTimeout(() => r("timeout"), ms))),
    start() {
      grpc?.start();
      shreds?.start();
      if (sendConn && cfg.sendWarmMs > 0) {
        // Any request keeps the pooled TLS connection warm; errors are irrelevant.
        warm = setInterval(() => { sendConn.getSlot().catch(() => undefined); }, cfg.sendWarmMs);
        warm.unref?.();
      }
    },
    close() {
      if (warm) clearInterval(warm);
      grpc?.close();
      shreds?.close();
    },
    describe() {
      return {
        state: grpc ? `grpc(${g!.commitment}) with RPC-poll fallback` : "rpc-poll",
        shreds: shreds ? `on (serverFilter=${s!.serverFilter}, hold=${cfg.holdOnCompetingArb})` : "off",
        send: sendConn ? "SEND_RPC_URL" : "RPC_URL",
        loop: eventDriven ? `event-driven (max ${cfg.pollIntervalMs} ms between ticks)` : `poll every ${cfg.pollIntervalMs} ms`,
      };
    },
  } as Infra;
}
