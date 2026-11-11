// Yellowstone (Dragon's Mouth) Geyser gRPC account feed -> StateProvider.
//
// Subscribes to the union of every StateSource's accounts() (venues + the user's
// token accounts) plus slot updates, keeps a per-account store ordered by
// (slot, write_version), and hands the engine a snapshot `(slot, Map)` whenever a
// relevant update arrived. Falls back to RPC polling (the wrapped PollingProvider)
// whenever the stream is disconnected, not yet seeded, or stale.
//
// Protocol facts used here were checked against @triton-one/yellowstone-grpc
// (pinned 9.0.1) generated geyser types and its native client:
//   SubscribeRequest{accounts, slots, transactions, transactionsStatus, blocks, blocksMeta,
//   entry, commitment, accountsDataSlice, ping, fromSlot, blockFooter};
//   SubscribeUpdate{account{account{pubkey, lamports, owner, executable, rentEpoch, data,
//   writeVersion}, slot, isStartup}, slot{slot, parent, status}, ping, pong};
//   CommitmentLevel PROCESSED=0 CONFIRMED=1 FINALIZED=2; auth metadata header `x-token`.
// Yellowstone does NOT send an initial account snapshot on subscribe, so the store is
// seeded with getMultipleAccountsInfo on every (re)connect and for every account
// added later (e.g. bin arrays).
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import bs58 from "bs58";
import type { StateSource } from "../types.js";
import type { RefreshResult, StateManager, StateProvider } from "../engine/state.js";
import { ChangeSignal } from "./signal.js";

export type GrpcCommitment = "processed" | "confirmed" | "finalized";
/** geyser.proto CommitmentLevel. */
export const COMMITMENT_LEVEL: Record<GrpcCommitment, number> = { processed: 0, confirmed: 1, finalized: 2 };

/** Subset of geyser SubscribeUpdate this module reads (u64 fields arrive as decimal strings). */
export interface GeyserUpdate {
  filters?: string[];
  account?: {
    slot: string;
    isStartup?: boolean;
    account?: {
      pubkey: Uint8Array;
      lamports: string;
      owner: Uint8Array;
      executable: boolean;
      rentEpoch: string;
      data: Uint8Array;
      writeVersion: string;
    };
  };
  slot?: { slot: string; parent?: string; status?: number };
  ping?: object;
  pong?: { id: number };
}

/** Minimal Duplex surface of the yellowstone ClientDuplexStream (lets tests pass a fake). */
export interface GeyserStream {
  write(req: unknown, cb?: (err?: Error | null) => void): boolean;
  on(ev: "data", fn: (u: GeyserUpdate) => void): unknown;
  on(ev: "error", fn: (e: Error) => void): unknown;
  on(ev: "end" | "close", fn: () => void): unknown;
  destroy(err?: Error): unknown;
}

export type GeyserConnect = () => Promise<GeyserStream>;

/** Real transport: @triton-one/yellowstone-grpc, imported lazily so it only loads when GRPC_ENDPOINT is set. */
export function yellowstoneConnect(endpoint: string, xToken?: string): GeyserConnect {
  return async () => {
    const mod = (await import("@triton-one/yellowstone-grpc")) as unknown as { default: unknown };
    // CJS package: depending on the loader, the class is `default` or `default.default`.
    const d = mod.default as { default?: unknown };
    const Client = (typeof d === "function" ? d : d.default) as typeof import("@triton-one/yellowstone-grpc").default;
    const client = new Client(endpoint, xToken || undefined, {
      grpcMaxDecodingMessageSize: 64 * 1024 * 1024,
      grpcConnectTimeout: 10_000,
      grpcHttp2KeepAliveInterval: 10_000,
      grpcKeepAliveTimeout: 5_000,
      grpcKeepAliveWhileIdle: true,
      grpcTcpNodelay: true,
    });
    await client.connect();
    return (await client.subscribe()) as unknown as GeyserStream;
  };
}

export interface GrpcProviderOptions {
  connect: GeyserConnect;
  commitment?: GrpcCommitment;
  /** Client ping period (keeps LBs / idle timeouts from closing the stream). */
  pingMs?: number;
  /** No message (slot or account) for this long => stale: don't trust the store, poll RPC instead. */
  staleMs?: number;
  /** Flush a slot's updates this long after its first update if no slot status / later slot arrives first. */
  debounceMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Accounts whose updates are stored but never trigger a re-evaluation by themselves (default: Clock sysvar). */
  quietAccounts?: string[];
  signal?: ChangeSignal;
  log?: (m: string) => void;
  /** Monotonic ms clock (default performance.now). */
  now?: () => number;
  /** Max rounds per refresh when accounts() grows after update (mirrors StateManager.maxRounds). */
  maxRounds?: number;
}

export const SYSVAR_CLOCK = "SysvarC1ock11111111111111111111111111111111";

interface StoreEntry {
  slot: number;
  /** -1 for RPC seeds (no write version). */
  writeVersion: bigint;
  /** Stream generation that delivered it (write versions are only comparable within one connection). */
  gen: number;
  info: AccountInfo<Buffer> | null;
  receivedAt: number;
}

/** Per-account last-writer-wins store ordered by (slot, write_version). */
export class AccountStore {
  readonly map = new Map<string, StoreEntry>();
  /** Stale updates rejected (metrics / tests). */
  rejected = 0;

  /** Apply a streamed update; true if it replaced the stored state. */
  applyStream(key: string, slot: number, writeVersion: bigint, gen: number, info: AccountInfo<Buffer> | null, receivedAt: number): boolean {
    const cur = this.map.get(key);
    if (cur) {
      const newer = slot > cur.slot || (slot === cur.slot && (gen > cur.gen || writeVersion > cur.writeVersion));
      if (!newer) { this.rejected++; return false; }
    }
    this.map.set(key, { slot, writeVersion, gen, info, receivedAt });
    return true;
  }

  /** Apply an RPC snapshot value at context slot `slot`; never overrides a streamed update of the same or a later slot. */
  applySeed(key: string, slot: number, gen: number, info: AccountInfo<Buffer> | null, receivedAt: number): boolean {
    const cur = this.map.get(key);
    if (cur && slot <= cur.slot) { this.rejected++; return false; }
    this.map.set(key, { slot, writeVersion: -1n, gen, info, receivedAt });
    return true;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }
}

export function buildSubscribeRequest(accounts: string[], commitment: GrpcCommitment, ping?: number): Record<string, unknown> {
  return {
    accounts: accounts.length ? { bot: { account: [...accounts].sort(), owner: [], filters: [] } } : {},
    slots: { bot: { filterByCommitment: true } },
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    blockFooter: {},
    accountsDataSlice: [],
    commitment: COMMITMENT_LEVEL[commitment],
    ...(ping !== undefined ? { ping: { id: ping } } : {}),
  };
}

export function decodeAccountUpdate(u: NonNullable<GeyserUpdate["account"]>): { key: string; slot: number; writeVersion: bigint; info: AccountInfo<Buffer> | null } | null {
  const a = u.account;
  if (!a) return null;
  const key = bs58.encode(a.pubkey);
  const lamports = Number(a.lamports);
  // A closed account is streamed with 0 lamports; RPC reports it as null.
  const info: AccountInfo<Buffer> | null = lamports === 0 ? null : {
    data: Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength),
    executable: a.executable,
    lamports,
    owner: new PublicKey(a.owner),
    rentEpoch: Number(a.rentEpoch),
  };
  return { key, slot: Number(u.slot), writeVersion: BigInt(a.writeVersion), info };
}

export type GrpcStatus = "idle" | "connecting" | "connected" | "disconnected" | "closed";

export class GrpcProvider implements StateProvider {
  readonly name = "grpc";
  readonly store = new AccountStore();
  readonly signal: ChangeSignal;
  lastSlot = -1;
  lastUpdateAt?: number;
  lastSource?: string;

  status: GrpcStatus = "idle";
  /** True once the store was seeded via RPC on the current connection. */
  seeded = false;
  reconnects = 0;
  /** Highest slot seen from the stream (slot or account updates). */
  streamSlot = -1;
  /** Bumped on every flush; refresh() feeds sources when it differs from consumedVersion. */
  version = 0;
  private consumedVersion = -1;
  private snapshotSlot = -1;
  private snapshotReceivedAt = 0;
  private dirtySlot: number | null = null;
  private dirtyAt = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stream: GeyserStream | null = null;
  private gen = 0;
  private gotData = false;
  private backoffMs: number;
  private lastMsgAt = -Infinity;
  private subscribed = new Set<string>();
  private pingId = 0;
  private wasHealthy = false;
  private quiet: Set<string>;
  private o: Required<Omit<GrpcProviderOptions, "signal" | "log" | "quietAccounts">>;
  private log: (m: string) => void;

  constructor(private poller: StateManager, opts: GrpcProviderOptions) {
    this.o = {
      connect: opts.connect,
      commitment: opts.commitment ?? "confirmed",
      pingMs: opts.pingMs ?? 10_000,
      staleMs: opts.staleMs ?? 3_000,
      debounceMs: opts.debounceMs ?? 20,
      reconnectMinMs: opts.reconnectMinMs ?? 250,
      reconnectMaxMs: opts.reconnectMaxMs ?? 15_000,
      now: opts.now ?? (() => performance.now()),
      maxRounds: opts.maxRounds ?? 3,
    };
    this.backoffMs = this.o.reconnectMinMs;
    this.signal = opts.signal ?? new ChangeSignal();
    this.quiet = new Set(opts.quietAccounts ?? [SYSVAR_CLOCK]);
    this.log = opts.log ?? ((m) => console.log(m));
  }

  private get sources(): readonly StateSource[] {
    return this.poller.stateSources;
  }

  private wanted(): string[] {
    return this.poller.wantedAccounts().map((k) => k.toBase58());
  }

  /** Begin connecting (non-blocking). The provider polls RPC until the stream is up and seeded. */
  start(): void {
    if (this.status !== "idle") return;
    void this.connectOnce();
  }

  close(): void {
    this.status = "closed";
    this.clearTimers();
    const s = this.stream;
    this.stream = null;
    try { s?.destroy(); } catch { /* ignore */ }
  }

  /** Healthy = connected, seeded on this connection, and a message within staleMs. */
  healthy(): boolean {
    return this.status === "connected" && this.seeded && this.o.now() - this.lastMsgAt <= this.o.staleMs;
  }

  info() {
    return { status: this.status, seeded: this.seeded, healthy: this.healthy(), streamSlot: this.streamSlot, snapshotSlot: this.snapshotSlot, lastMsgAgeMs: this.o.now() - this.lastMsgAt, reconnects: this.reconnects, accounts: this.subscribed.size, rejectedStale: this.store.rejected };
  }

  waitForChange(timeoutMs: number): Promise<string> {
    return this.signal.wait(timeoutMs);
  }

  // ---------------- stream lifecycle ----------------

  private clearTimers() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.debounceTimer = this.pingTimer = this.reconnectTimer = null;
  }

  private async connectOnce(): Promise<void> {
    if (this.status === "closed") return;
    this.status = "connecting";
    this.seeded = false;
    const gen = ++this.gen;
    let stream: GeyserStream;
    try {
      stream = await this.o.connect();
    } catch (e) {
      this.log(`grpc connect failed: ${(e as Error).message}`);
      this.scheduleReconnect(gen);
      return;
    }
    if ((this.status as GrpcStatus) === "closed" || gen !== this.gen) { try { stream.destroy(); } catch { /* ignore */ } return; }
    this.stream = stream;
    this.gotData = false;
    stream.on("data", (u: GeyserUpdate) => { if (gen === this.gen) this.onData(u); });
    stream.on("error", (e: Error) => { if (gen === this.gen) this.onDown(gen, `error: ${e.message}`); });
    stream.on("end", () => { if (gen === this.gen) this.onDown(gen, "end"); });
    stream.on("close", () => { if (gen === this.gen) this.onDown(gen, "close"); });
    const keys = this.wanted();
    this.subscribed = new Set(keys);
    this.write(buildSubscribeRequest(keys, this.o.commitment));
    this.status = "connected";
    this.lastMsgAt = this.o.now(); // grace period: staleMs from now
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.ping(), this.o.pingMs);
    this.pingTimer.unref?.();
    this.log(`grpc connected (gen ${gen}, ${keys.length} accounts, ${this.o.commitment})`);
    // Seed (or re-seed after a gap) from RPC: the stream only carries changes.
    try {
      await this.seed(keys, gen);
      if (gen === this.gen && this.status === "connected") {
        this.seeded = true;
        this.bump(this.store.map.size ? Math.max(...[...this.store.map.values()].map((e) => e.slot)) : -1, this.o.now(), "grpc-seed");
      }
    } catch (e) {
      this.log(`grpc seed failed: ${(e as Error).message}; reconnecting`);
      this.onDown(gen, "seed failed");
    }
  }

  private async seed(keys: string[], gen: number): Promise<void> {
    if (!keys.length) return;
    const { slot, infos } = await this.poller.fetch(keys.map((k) => new PublicKey(k)));
    const at = this.o.now();
    for (const k of keys) this.store.applySeed(k, slot, gen, infos.get(k) ?? null, at);
  }

  private onDown(gen: number, why: string) {
    if (gen !== this.gen || this.status === "closed") return;
    this.log(`grpc stream down (${why}); falling back to RPC polling`);
    this.status = "disconnected";
    this.seeded = false;
    const s = this.stream;
    this.stream = null;
    try { s?.destroy(); } catch { /* ignore */ }
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.gotData) this.backoffMs = this.o.reconnectMinMs; // the stream worked: reset backoff
    this.scheduleReconnect(gen);
  }

  private scheduleReconnect(gen: number) {
    if (this.status === "closed" || gen !== this.gen || this.reconnectTimer) return;
    this.status = "disconnected";
    const base = this.backoffMs;
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.backoffMs = Math.min(this.o.reconnectMaxMs, base * 2);
    this.reconnects++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOnce();
    }, delay);
  }

  private write(req: unknown) {
    const s = this.stream;
    if (!s) return;
    try {
      s.write(req, (err) => { if (err) this.log(`grpc write error: ${err.message}`); });
    } catch (e) {
      this.log(`grpc write threw: ${(e as Error).message}`);
    }
  }

  private ping() {
    // Full request + ping: if a server treated a ping as a filter update it would
    // still carry the same filters.
    this.write(buildSubscribeRequest([...this.subscribed], this.o.commitment, ++this.pingId));
  }

  private onData(u: GeyserUpdate) {
    const now = this.o.now();
    this.gotData = true;
    if (u.ping) { this.lastMsgAt = now; this.ping(); return; }
    if (u.pong) return;
    if (u.slot) {
      this.lastMsgAt = now;
      const s = Number(u.slot.slot);
      if (s > this.streamSlot) this.streamSlot = s;
      // A slot status at our commitment for >= the dirty slot means that slot's writes are all in.
      if (this.dirtySlot !== null && s >= this.dirtySlot) this.flush();
      return;
    }
    if (u.account) {
      this.lastMsgAt = now;
      const d = decodeAccountUpdate(u.account);
      if (!d || !this.subscribed.has(d.key)) return;
      if (d.slot > this.streamSlot) this.streamSlot = d.slot;
      const applied = this.store.applyStream(d.key, d.slot, d.writeVersion, this.gen, d.info, now);
      if (!applied || this.quiet.has(d.key) || !this.seeded) return;
      this.markDirty(d.slot, now);
    }
  }

  private markDirty(slot: number, now: number) {
    if (this.dirtySlot !== null && slot > this.dirtySlot) this.flush(); // a later slot started: the earlier one is complete
    if (this.dirtySlot === null) {
      this.dirtySlot = slot;
      this.dirtyAt = now;
      this.debounceTimer = setTimeout(() => { this.debounceTimer = null; this.flush(); }, this.o.debounceMs);
    } else {
      this.dirtyAt = now;
    }
  }

  private flush() {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.dirtySlot === null) return;
    const slot = this.dirtySlot;
    this.dirtySlot = null;
    this.bump(slot, this.dirtyAt, "grpc");
  }

  private bump(slot: number, receivedAt: number, reason: string) {
    if (slot > this.snapshotSlot) this.snapshotSlot = slot;
    this.snapshotReceivedAt = receivedAt;
    this.version++;
    this.signal.notify(reason);
  }

  // ---------------- StateProvider ----------------

  private snapshot(keys: string[]): Map<string, AccountInfo<Buffer> | null> {
    const m = new Map<string, AccountInfo<Buffer> | null>();
    for (const k of keys) m.set(k, this.store.map.get(k)?.info ?? null);
    return m;
  }

  async refresh(): Promise<RefreshResult> {
    const healthy = this.healthy();
    if (healthy !== this.wasHealthy) {
      this.log(healthy ? `grpc feed healthy (slot ${this.streamSlot})` : `grpc feed not usable (${this.status}${this.seeded ? "" : ", unseeded"}, last msg ${Math.round(this.o.now() - this.lastMsgAt)} ms ago): RPC polling`);
      this.wasHealthy = healthy;
      if (healthy) this.consumedVersion = -1; // force a fresh feed of the stream store
    }
    if (!healthy) {
      const r = await this.poller.refresh();
      this.lastSlot = Math.max(this.lastSlot, r.slot);
      this.lastUpdateAt = this.poller.lastUpdateAt;
      this.lastSource = "grpc-fallback-rpc";
      return r;
    }
    if (this.version === this.consumedVersion) return { slot: this.lastSlot, updated: false };
    const version = this.version;
    // Snapshot slot: newest slot whose updates were flushed (never behind what RPC fallback already served).
    const slot = Math.max(this.snapshotSlot, this.lastSlot);
    let keys = this.wanted();
    let infos = this.snapshot(keys);
    for (let round = 0; round < this.o.maxRounds; round++) {
      for (const s of this.sources) s.update(slot, infos);
      const next = this.wanted();
      const missing = next.filter((k) => !this.store.has(k));
      const unsubscribed = next.filter((k) => !this.subscribed.has(k));
      if (unsubscribed.length) {
        // Account set grew (bin arrays): resubscribe on the live stream with the full set.
        for (const k of unsubscribed) this.subscribed.add(k);
        this.write(buildSubscribeRequest([...this.subscribed], this.o.commitment));
        this.log(`grpc resubscribed: +${unsubscribed.length} accounts (${this.subscribed.size} total)`);
      }
      if (missing.length === 0) break;
      await this.seed(missing, this.gen);
      keys = next;
      infos = this.snapshot(keys);
    }
    this.consumedVersion = version;
    this.lastSlot = slot;
    this.lastUpdateAt = this.snapshotReceivedAt;
    this.lastSource = "grpc";
    return { slot, updated: true };
  }
}
