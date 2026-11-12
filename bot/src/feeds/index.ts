// Infrastructure wiring (ERPC VPS / Geyser gRPC / Shreds / SWQoS send endpoint),
// all optional and env-driven. With nothing configured this reproduces the
// original behaviour: one RPC connection, per-tick polling, sleep between ticks.
import { Connection } from "@solana/web3.js";
import type { Config } from "../config.js";
import type { StateSource } from "../types.js";
import type { StateManager, StateProvider } from "../engine/state.js";
import { ChangeSignal } from "./signal.js";
import { GrpcProvider, yellowstoneConnect } from "./grpc.js";
import { AltCache, PendingActivity, ShredFeed, defaultWatchSet, grpcEntriesConnect, type PairWatch } from "./shreds.js";
import { keepAliveFetch } from "./http.js";
import { ShredsUdpFeed } from "./shreds-udp.js";

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
  /** Every GrpcProvider created (one per engine). */
  grpcs?: GrpcProvider[];
  shreds?: ShredFeed;
  /** Raw shreds over UDP (ERPC Shreds UDP Forwarding); exclusive with `shreds`. */
  shredsUdp?: ShredsUdpFeed;
  /** True when a push feed can wake the loop early. */
  eventDriven: boolean;
  /** Wait for a feed event or up to ms; resolves with the trigger reason ("timeout" if none). */
  wait(ms: number): Promise<string>;
  start(): void;
  close(): void;
  describe(): Record<string, string>;
}

export interface InfraHooks {
  /** Periodic shreds-udp summary (main.ts appends it to the ledger as a `latency` row). */
  onShredsUdpSummary?: (s: Record<string, unknown>) => void;
  /** Generic pairs to watch in the shred feeds (e.g. MAX pools), in addition to RISE. */
  pairWatch?: PairWatch[];
}

export function setupInfra(cfg: Config, conn: Connection, log: (m: string) => void = console.log, hooks: InfraHooks = {}): Infra {
  const signal = new ChangeSignal();
  const sendConn = cfg.sendRpcUrl ? new Connection(cfg.sendRpcUrl, { commitment: cfg.commitment, fetch: keepAliveFetch({ connections: 4 }) }) : undefined;
  // one GrpcProvider per engine that asks for one (RISE engine, each pair engine); all share the signal
  const grpcs: GrpcProvider[] = [];
  const g = cfg.grpc;
  const stateProvider = g
    ? (_sources: StateSource[], polling: StateManager) => {
        const p = new GrpcProvider(polling, {
          connect: yellowstoneConnect(g.endpoint, g.xToken),
          commitment: g.commitment, pingMs: g.pingMs, staleMs: g.staleMs, debounceMs: g.debounceMs,
          reconnectMinMs: g.reconnectMinMs, reconnectMaxMs: g.reconnectMaxMs, signal, log,
        });
        grpcs.push(p);
        return p;
      }
    : undefined;
  const watchSet = () => ({ ...defaultWatchSet([cfg.user.toBase58()]), ...(hooks.pairWatch?.length ? { pairs: hooks.pairWatch } : {}) });

  let pending: PendingActivity | undefined;
  let shreds: ShredFeed | undefined;
  const s = cfg.shreds;
  if (s) {
    pending = new PendingActivity(s.holdWindowMs);
    const watch = watchSet();
    shreds = new ShredFeed({
      connect: grpcEntriesConnect(s.endpoint, s.xToken),
      watch,
      request: s.serverFilter ? { accountInclude: [watch.riseProgram, watch.pool, ...watch.reserves, ...(watch.pairs ?? []).flatMap((p) => p.pools.flatMap((x) => x.accounts))], commitment: 0 } : {},
      resolver: s.resolveLookupTables ? new AltCache(conn, 5000, log) : undefined,
      pending, signal, staleMs: s.staleMs, log,
    });
  }

  let shredsUdp: ShredsUdpFeed | undefined;
  const u = cfg.shredsUdp;
  if (u) {
    if (u.overridesShredstream) log("SHREDS_UDP_PORT and SHREDSTREAM_ENDPOINT are both set: using UDP shreds, ignoring SHREDSTREAM_ENDPOINT");
    pending = new PendingActivity(u.holdWindowMs);
    shredsUdp = new ShredsUdpFeed({
      port: u.port, bind: u.bind, rcvbuf: u.rcvbuf, allowedSources: u.allowedSources, shredVersion: u.shredVersion,
      maxSlotLag: u.maxSlotLag, maxBufferedBytes: u.maxBufferedBytes, recovery: u.recovery, summaryMs: u.summaryMs, staleMs: u.staleMs,
      watch: watchSet(),
      resolver: u.resolveLookupTables ? new AltCache(conn, 5000, log) : undefined,
      pending, signal, log, onSummary: hooks.onShredsUdpSummary,
    });
  }

  let warm: ReturnType<typeof setInterval> | null = null;
  const eventDriven = !!(g || s || u);
  return {
    sendConn, signal, stateProvider, pending, shreds, shredsUdp,
    get grpc() { return grpcs[0]; },
    get grpcs() { return grpcs; },
    eventDriven,
    wait: (ms: number) => (eventDriven ? signal.wait(ms) : new Promise<string>((r) => setTimeout(() => r("timeout"), ms))),
    start() {
      for (const p of grpcs) p.start();
      shreds?.start();
      shredsUdp?.start();
      if (sendConn && cfg.sendWarmMs > 0) {
        // Any request keeps the pooled TLS connection warm; errors are irrelevant.
        warm = setInterval(() => { sendConn.getSlot().catch(() => undefined); }, cfg.sendWarmMs);
        warm.unref?.();
      }
    },
    close() {
      if (warm) clearInterval(warm);
      for (const p of grpcs) p.close();
      shreds?.close();
      shredsUdp?.close();
    },
    describe() {
      return {
        state: grpcs.length ? `grpc(${g!.commitment}) with RPC-poll fallback${grpcs.length > 1 ? ` x${grpcs.length} streams` : ""}` : "rpc-poll",
        shreds: shredsUdp ? `${shredsUdp.describe()} hold=${cfg.holdOnCompetingArb}` : shreds ? `grpc (serverFilter=${s!.serverFilter}, hold=${cfg.holdOnCompetingArb})` : "off",
        send: sendConn ? "SEND_RPC_URL" : "RPC_URL",
        loop: eventDriven ? `event-driven (max ${cfg.pollIntervalMs} ms between ticks)` : `poll every ${cfg.pollIntervalMs} ms`,
      };
    },
  } as Infra;
}
