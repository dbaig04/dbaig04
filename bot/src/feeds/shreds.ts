// ShredStream entries feed: an EARLY, UNCONFIRMED signal of activity on the RISE
// program and the DLMM pool. Never applied to state; it only
//   * logs pending competing arbs / pool swaps / RISE mints+redeems,
//   * triggers an immediate engine re-evaluation (ChangeSignal), and
//   * exposes PendingActivity so the engine can optionally hold a trade when a
//     competing arb on the same pool is in flight (SHREDS_HOLD_ON_COMPETING_ARB, off by default).
//
// Wire format (verified against the Validators DAO / ERPC solana-stream-sdk 3.0.0 crate's
// protos/shredstream.proto, which keeps Jito's service name, and Agave 4.x crates
// solana-entry 4.2.2 / solana-transaction 4.1.6 / solana-message 4.4.1):
//   gRPC  /shredstream.ShredstreamProxy/SubscribeEntries (server stream)
//   Entry { uint64 slot = 1; bytes entries = 2; }
//   entries = Vec<Entry> in the ledger (bincode-compatible wincode) layout:
//     u64 LE count, then per entry: u64 num_hashes, [u8;32] hash, u64 LE tx count, txs.
//   VersionedTransaction:
//     legacy / v0 : short_vec signatures, message (v0 starts with 0x80), ...
//     v1 (SIMD-0385, live since 2026-09): 0x81, header, u32 config mask, [32] lifetime,
//                   u8 #ix, u8 #addr, addrs, config values, ix headers (u8,u8,u16), payloads,
//                   then num_required_signatures x 64-byte signatures (no length prefix).
//   Alpenglow block markers: payload with a zero entry count followed by a non-zero marker.
// The request message is ERPC's extended SubscribeEntriesRequest (filters, commitment);
// upstream Jito's proxy has an empty request and ignores the unknown fields.
import bs58 from "bs58";
import { PublicKey, type Connection } from "@solana/web3.js";
import { DLMM_PROGRAM_ID, POOL_ADDRESS, RISE_MINT, RISE_PROGRAM_ID, WSOL_MINT } from "../types.js";
import type { ChangeSignal } from "./signal.js";

// ============================ protobuf (tiny, hand-rolled) ============================

function pbVarint(n: number | bigint): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  while (v >= 0x80n) { out.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
  out.push(Number(v));
  return out;
}
function pbLenDelim(field: number, bytes: Uint8Array | number[]): number[] {
  return [...pbVarint((field << 3) | 2), ...pbVarint(bytes.length), ...bytes];
}
const utf8 = (s: string) => [...Buffer.from(s, "utf8")];

export interface EntriesRequestOptions {
  /** ERPC server-side transaction filter (experimental on their side). Empty = no filter = full stream. */
  accountInclude?: string[];
  /** geyser-style CommitmentLevel; 0 = processed. */
  commitment?: number;
}

/** Encode ERPC's SubscribeEntriesRequest. With no options it is the empty message (Jito-compatible). */
export function encodeSubscribeEntriesRequest(o: EntriesRequestOptions = {}): Buffer {
  const out: number[] = [];
  if (o.accountInclude?.length) {
    // SubscribeRequestFilterTransactions { repeated string account_include = 3; }
    const filter: number[] = [];
    for (const a of o.accountInclude) filter.push(...pbLenDelim(3, utf8(a)));
    // map<string, SubscribeRequestFilterTransactions> transactions = 3;  (entry: key = 1, value = 2)
    const entry = [...pbLenDelim(1, utf8("bot")), ...pbLenDelim(2, filter)];
    out.push(...pbLenDelim(3, entry));
  }
  if (o.commitment !== undefined) out.push(...pbVarint((6 << 3) | 0), ...pbVarint(o.commitment));
  return Buffer.from(out);
}

/** Decode shredstream.Entry { uint64 slot = 1; bytes entries = 2; } (unknown fields skipped). */
export function decodeEntryMessage(buf: Uint8Array): { slot: number; entries: Uint8Array } {
  let o = 0;
  const varint = (): bigint => {
    let shift = 0n, v = 0n;
    for (;;) {
      if (o >= buf.length) throw new Error("pb: truncated varint");
      const b = buf[o++];
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
      shift += 7n;
      if (shift > 63n) throw new Error("pb: varint too long");
    }
  };
  let slot = 0, entries: Uint8Array = new Uint8Array(0);
  while (o < buf.length) {
    const tag = Number(varint());
    const field = tag >> 3, wt = tag & 7;
    if (wt === 0) { const v = varint(); if (field === 1) slot = Number(v); }
    else if (wt === 2) {
      const len = Number(varint());
      if (o + len > buf.length) throw new Error("pb: truncated bytes");
      if (field === 2) entries = buf.subarray(o, o + len);
      o += len;
    } else if (wt === 1) o += 8;
    else if (wt === 5) o += 4;
    else throw new Error(`pb: unsupported wire type ${wt}`);
  }
  return { slot, entries };
}

// ============================ ledger entry / tx decoding ============================

export interface DecodedIx { programIdIndex: number; accounts: Uint8Array; data: Uint8Array }
export interface DecodedLookup { table: string; writable: Uint8Array; readonly: Uint8Array }
export interface DecodedTx {
  version: "legacy" | 0 | 1;
  signatures: string[];
  header: { numRequiredSignatures: number; numReadonlySigned: number; numReadonlyUnsigned: number };
  staticKeys: string[];
  recentBlockhash: string;
  instructions: DecodedIx[];
  lookups: DecodedLookup[];
  /** v1 TransactionConfig values, when present. */
  v1Config?: { priorityFee?: bigint; computeUnitLimit?: number; loadedAccountsDataSizeLimit?: number; heapSize?: number };
}
export interface DecodedEntry { numHashes: bigint; hash: string; transactions: DecodedTx[] }

const MAX_ENTRIES = 1 << 16;
const MAX_TXS = 1 << 16;

class Reader {
  o = 0;
  constructor(readonly b: Uint8Array) {}
  need(n: number) { if (this.o + n > this.b.length) throw new Error(`entry decode: unexpected end (need ${n} at ${this.o}/${this.b.length})`); }
  u8() { this.need(1); return this.b[this.o++]; }
  u16() { this.need(2); const v = this.b[this.o] | (this.b[this.o + 1] << 8); this.o += 2; return v; }
  u32() { this.need(4); const v = Buffer.from(this.b.buffer, this.b.byteOffset + this.o, 4).readUInt32LE(0); this.o += 4; return v; }
  u64() { this.need(8); const v = Buffer.from(this.b.buffer, this.b.byteOffset + this.o, 8).readBigUInt64LE(0); this.o += 8; return v; }
  bytes(n: number) { this.need(n); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  key() { return bs58.encode(this.bytes(32)); }
  /** solana short_vec (compact-u16). */
  shortVec(): number {
    let v = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.u8();
      v |= (b & 0x7f) << (7 * i);
      if (!(b & 0x80)) return v;
    }
    throw new Error("entry decode: short_vec too long");
  }
}

function readLegacyOrV0(r: Reader, sigCount: number): DecodedTx {
  const signatures: string[] = [];
  for (let i = 0; i < sigCount; i++) signatures.push(bs58.encode(r.bytes(64)));
  let version: DecodedTx["version"] = "legacy";
  let first = r.u8();
  if (first & 0x80) {
    const v = first & 0x7f;
    if (v !== 0) throw new Error(`entry decode: unexpected message version ${v} after short_vec signatures`);
    version = 0;
    first = r.u8();
  }
  const header = { numRequiredSignatures: first, numReadonlySigned: r.u8(), numReadonlyUnsigned: r.u8() };
  const nKeys = r.shortVec();
  const staticKeys: string[] = [];
  for (let i = 0; i < nKeys; i++) staticKeys.push(r.key());
  const recentBlockhash = r.key();
  const nIx = r.shortVec();
  const instructions: DecodedIx[] = [];
  for (let i = 0; i < nIx; i++) {
    const programIdIndex = r.u8();
    const accounts = r.bytes(r.shortVec());
    const data = r.bytes(r.shortVec());
    instructions.push({ programIdIndex, accounts, data });
  }
  const lookups: DecodedLookup[] = [];
  if (version === 0) {
    const nL = r.shortVec();
    for (let i = 0; i < nL; i++) {
      const table = r.key();
      const writable = r.bytes(r.shortVec());
      const readonly = r.bytes(r.shortVec());
      lookups.push({ table, writable, readonly });
    }
  }
  return { version, signatures, header, staticKeys, recentBlockhash, instructions, lookups };
}

const V1_KNOWN_MASK = 0b11111;

function readV1(r: Reader): DecodedTx {
  const header = { numRequiredSignatures: r.u8(), numReadonlySigned: r.u8(), numReadonlyUnsigned: r.u8() };
  const mask = r.u32();
  if (mask & ~V1_KNOWN_MASK) throw new Error(`entry decode: unknown v1 config mask bits ${mask.toString(2)}`);
  const pf = mask & 0b11;
  if (pf !== 0 && pf !== 0b11) throw new Error("entry decode: partial v1 priority-fee bits");
  const recentBlockhash = r.key();
  const nIx = r.u8();
  const nAddr = r.u8();
  const staticKeys: string[] = [];
  for (let i = 0; i < nAddr; i++) staticKeys.push(r.key());
  const v1Config: NonNullable<DecodedTx["v1Config"]> = {};
  if (pf === 0b11) v1Config.priorityFee = r.u64();
  if (mask & 0b100) v1Config.computeUnitLimit = r.u32();
  if (mask & 0b1000) v1Config.loadedAccountsDataSizeLimit = r.u32();
  if (mask & 0b10000) v1Config.heapSize = r.u32();
  const heads: { p: number; na: number; dl: number }[] = [];
  for (let i = 0; i < nIx; i++) heads.push({ p: r.u8(), na: r.u8(), dl: r.u16() });
  const instructions: DecodedIx[] = heads.map((h) => ({ programIdIndex: h.p, accounts: r.bytes(h.na), data: r.bytes(h.dl) }));
  const signatures: string[] = [];
  for (let i = 0; i < header.numRequiredSignatures; i++) signatures.push(bs58.encode(r.bytes(64)));
  return { version: 1, signatures, header, staticKeys, recentBlockhash, instructions, lookups: [], v1Config };
}

function readTx(r: Reader): DecodedTx {
  const d = r.b[r.o];
  if (d === undefined) throw new Error("entry decode: unexpected end at tx");
  if ((d & 0x80) === 0) { r.o++; return readLegacyOrV0(r, d); }
  if (d === 0x81) { r.o++; return readV1(r); }
  throw new Error(`entry decode: invalid transaction discriminator 0x${d.toString(16)}`);
}

export type PayloadKind = "entries" | "block-marker" | "empty";

/** Same rule as the ERPC SDK's classifyBlockMarker: zero entry count followed by non-zero bytes. */
export function classifyPayload(p: Uint8Array): PayloadKind {
  if (p.length < 8) return "entries"; // will fail to decode
  for (let i = 0; i < 8; i++) if (p[i] !== 0) return "entries";
  for (let i = 8; i < p.length; i++) if (p[i] !== 0) return "block-marker";
  return "empty";
}

/** Decode a bincode/wincode Vec<Entry>. Trailing zero padding is accepted, other trailing bytes are an error. */
export function decodeEntries(buf: Uint8Array): DecodedEntry[] {
  const r = new Reader(buf);
  const n = r.u64();
  if (n > BigInt(MAX_ENTRIES)) throw new Error(`entry decode: implausible entry count ${n}`);
  const out: DecodedEntry[] = [];
  for (let i = 0; i < Number(n); i++) {
    const numHashes = r.u64();
    const hash = r.key();
    const nt = r.u64();
    if (nt > BigInt(MAX_TXS)) throw new Error(`entry decode: implausible tx count ${nt}`);
    const transactions: DecodedTx[] = [];
    for (let j = 0; j < Number(nt); j++) transactions.push(readTx(r));
    out.push({ numHashes, hash, transactions });
  }
  for (let i = r.o; i < buf.length; i++) if (buf[i] !== 0) throw new Error(`entry decode: ${buf.length - r.o} trailing bytes`);
  return out;
}

// ============================ filtering ============================

export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

export interface WatchSet {
  riseProgram: string;
  dlmmProgram: string;
  pool: string;
  /** Pool reserve token accounts. */
  reserves: string[];
  /** Fee payers treated as our own (never "competing"). */
  ownSigners: Set<string>;
}

/** Meteora DLMM reserve PDA = [lb_pair, mint] under the DLMM program (as in @meteora-ag/dlmm deriveReserve). */
export function dlmmReserve(pool: string, mint: string, program = DLMM_PROGRAM_ID): string {
  return PublicKey.findProgramAddressSync([new PublicKey(pool).toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey(program))[0].toBase58();
}

export function defaultWatchSet(ownSigners: string[] = []): WatchSet {
  return {
    riseProgram: RISE_PROGRAM_ID,
    dlmmProgram: DLMM_PROGRAM_ID,
    pool: POOL_ADDRESS,
    reserves: [dlmmReserve(POOL_ADDRESS, RISE_MINT), dlmmReserve(POOL_ADDRESS, WSOL_MINT)],
    ownSigners: new Set(ownSigners),
  };
}

export type HitKind = "arb" | "pool-swap" | "rise";

export interface ShredHit {
  slot: number;
  signature: string;
  feePayer: string;
  kind: HitKind;
  own: boolean;
  version: DecodedTx["version"];
  /** Top-level programs invoked (static keys). */
  programs: string[];
  /** Address-lookup tables we could not resolve (keys hidden in them were not checked). */
  unresolvedLookups: number;
  cuPriceMicroLamports?: bigint;
  cuLimit?: number;
  v1PriorityFee?: bigint;
  receivedAt: number;
}

/** Resolves v0 address lookup tables (optional). */
export interface LookupResolver {
  /** Cached table contents, or undefined (and possibly start fetching it). */
  get(table: string, wantFetch: boolean): string[] | undefined;
}

function computeBudget(tx: DecodedTx): { price?: bigint; limit?: number } {
  const out: { price?: bigint; limit?: number } = {};
  for (const ix of tx.instructions) {
    if (tx.staticKeys[ix.programIdIndex] !== COMPUTE_BUDGET_PROGRAM_ID || ix.data.length < 1) continue;
    const d = Buffer.from(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    if (d[0] === 2 && d.length >= 5) out.limit = d.readUInt32LE(1);
    if (d[0] === 3 && d.length >= 9) out.price = d.readBigUInt64LE(1);
  }
  return out;
}

/**
 * Classify one transaction against the watch set. Matching is by account keys
 * (static + resolved lookup tables), so CPI routes (aggregators, other arb bots'
 * programs) that pass the RISE program or the pool/reserves are caught too.
 */
export function classifyTx(tx: DecodedTx, slot: number, w: WatchSet, resolver?: LookupResolver, receivedAt = 0): ShredHit | null {
  const keys = new Set(tx.staticKeys);
  const programs = [...new Set(tx.instructions.map((ix) => tx.staticKeys[ix.programIdIndex]).filter((k): k is string => !!k))];
  const interesting = keys.has(w.riseProgram) || keys.has(w.dlmmProgram) || keys.has(w.pool);
  let unresolved = 0;
  for (const l of tx.lookups) {
    const t = resolver?.get(l.table, interesting);
    if (!t) { unresolved++; continue; }
    for (const i of l.writable) if (t[i]) keys.add(t[i]);
    for (const i of l.readonly) if (t[i]) keys.add(t[i]);
  }
  const rise = keys.has(w.riseProgram);
  const pool = keys.has(w.pool) || w.reserves.some((r) => keys.has(r));
  if (!rise && !pool) return null;
  const kind: HitKind = rise && pool ? "arb" : pool ? "pool-swap" : "rise";
  const feePayer = tx.staticKeys[0] ?? "";
  const cb = computeBudget(tx);
  return {
    slot, signature: tx.signatures[0] ?? "", feePayer, kind, own: w.ownSigners.has(feePayer), version: tx.version, programs,
    unresolvedLookups: unresolved, cuPriceMicroLamports: cb.price, cuLimit: cb.limit ?? tx.v1Config?.computeUnitLimit,
    v1PriorityFee: tx.v1Config?.priorityFee, receivedAt,
  };
}

// ============================ lookup-table cache ============================

/** Lazily fetches lookup tables via RPC (only for txs that already look relevant). Bounded LRU. */
export class AltCache implements LookupResolver {
  private cache = new Map<string, string[]>();
  private inflight = new Set<string>();
  private failedAt = new Map<string, number>();
  constructor(private conn: Pick<Connection, "getAddressLookupTable">, private max = 5000, private log?: (m: string) => void) {}
  get(table: string, wantFetch: boolean): string[] | undefined {
    const v = this.cache.get(table);
    if (v) { this.cache.delete(table); this.cache.set(table, v); return v; }
    if (wantFetch && !this.inflight.has(table) && (Date.now() - (this.failedAt.get(table) ?? 0)) > 60_000 && this.inflight.size < 8) {
      this.inflight.add(table);
      this.conn.getAddressLookupTable(new PublicKey(table)).then((r) => {
        if (r.value) this.put(table, r.value.state.addresses.map((a) => a.toBase58()));
        else this.failedAt.set(table, Date.now());
      }, (e) => { this.failedAt.set(table, Date.now()); this.log?.(`ALT ${table} fetch failed: ${(e as Error).message}`); })
        .finally(() => this.inflight.delete(table));
    }
    return undefined;
  }
  put(table: string, addrs: string[]) {
    this.cache.set(table, addrs);
    if (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
  }
}

// ============================ pending-activity hint ============================

/** Recent unconfirmed hits, for the engine's optional hold-on-competing-arb rule. */
export class PendingActivity {
  private hits: ShredHit[] = [];
  constructor(private windowMs = 1500, private now: () => number = () => performance.now()) {}
  record(h: ShredHit) {
    this.hits.push(h);
    this.prune();
  }
  private prune() {
    const cutoff = this.now() - this.windowMs;
    while (this.hits.length && this.hits[0].receivedAt < cutoff) this.hits.shift();
    if (this.hits.length > 1000) this.hits.splice(0, this.hits.length - 1000);
  }
  /** A non-own arb on the pool seen at a slot >= `slot` (i.e. not yet reflected in that snapshot) within the window. */
  competingArb(slot: number): ShredHit | null {
    this.prune();
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (h.kind === "arb" && !h.own && h.slot >= slot) return h;
    }
    return null;
  }
  /** Counts of recent non-own hits at slot >= `slot` (attached to ledger opportunities). */
  summary(slot: number): { arb: number; poolSwap: number; rise: number } {
    this.prune();
    const s = { arb: 0, poolSwap: 0, rise: 0 };
    for (const h of this.hits) {
      if (h.own || h.slot < slot) continue;
      if (h.kind === "arb") s.arb++; else if (h.kind === "pool-swap") s.poolSwap++; else s.rise++;
    }
    return s;
  }
}

// ============================ the feed ============================

/** Minimal server-stream surface (grpc-js ClientReadableStream) so tests can pass a fake. */
export interface EntriesStream {
  on(ev: "data", fn: (msg: Buffer) => void): unknown;
  on(ev: "error", fn: (e: Error) => void): unknown;
  on(ev: "end", fn: () => void): unknown;
  cancel(): void;
}
export type EntriesConnect = (request: Buffer) => Promise<EntriesStream>;

export const SUBSCRIBE_ENTRIES_PATH = "/shredstream.ShredstreamProxy/SubscribeEntries";

/** Real transport: @grpc/grpc-js generic client (raw bytes in/out), loaded lazily. */
export function grpcEntriesConnect(endpoint: string, xToken?: string): EntriesConnect {
  let client: import("@grpc/grpc-js").Client | null = null;
  return async (request: Buffer) => {
    const grpc = await import("@grpc/grpc-js");
    if (!client) {
      const u = new URL(endpoint.includes("://") ? endpoint : `http://${endpoint}`);
      const tls = u.protocol === "https:";
      const target = `${u.hostname}:${u.port || (tls ? "443" : "80")}`;
      client = new grpc.Client(target, tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(), {
        "grpc.keepalive_time_ms": 10_000,
        "grpc.keepalive_timeout_ms": 5_000,
        "grpc.keepalive_permit_without_calls": 1,
        "grpc.max_receive_message_length": 64 * 1024 * 1024,
        "grpc.initial_reconnect_backoff_ms": 250,
        "grpc.max_reconnect_backoff_ms": 10_000,
      });
    }
    const md = new grpc.Metadata();
    if (xToken) md.set("x-token", xToken);
    const call = client.makeServerStreamRequest<Buffer, Buffer>(SUBSCRIBE_ENTRIES_PATH, (b: Buffer) => b, (b: Buffer) => b, request, md, {});
    return call as unknown as EntriesStream;
  };
}

export interface ShredFeedOptions {
  connect: EntriesConnect;
  watch: WatchSet;
  request?: EntriesRequestOptions;
  resolver?: LookupResolver;
  pending?: PendingActivity;
  signal?: ChangeSignal;
  /** Recycle the stream when nothing arrives for this long. */
  staleMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  log?: (m: string) => void;
  now?: () => number;
}

export class ShredFeed {
  stats = { messages: 0, entries: 0, txs: 0, hits: 0, markers: 0, decodeErrors: 0, reconnects: 0 };
  status: "idle" | "connecting" | "connected" | "disconnected" | "closed" = "idle";
  lastSlot = -1;
  private stream: EntriesStream | null = null;
  private gen = 0;
  /** Consecutive failures since the last stream that delivered data (log throttling). */
  private fails = 0;
  private backoff: number;
  private lastMsgAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private log: (m: string) => void;
  private now: () => number;

  constructor(private o: ShredFeedOptions) {
    this.backoff = o.reconnectMinMs ?? 250;
    this.log = o.log ?? ((m) => console.log(m));
    this.now = o.now ?? (() => performance.now());
  }

  start(): void {
    if (this.status !== "idle") return;
    const staleMs = this.o.staleMs ?? 5_000;
    this.watchdog = setInterval(() => {
      if (this.status === "connected" && this.now() - this.lastMsgAt > staleMs) this.down(this.gen, `no entries for ${staleMs} ms`);
    }, Math.max(100, Math.min(1000, staleMs / 2)));
    this.watchdog.unref?.();
    void this.connectOnce();
  }

  close(): void {
    this.status = "closed";
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.stream?.cancel(); } catch { /* ignore */ }
    this.stream = null;
  }

  private async connectOnce() {
    if (this.status === "closed") return;
    this.status = "connecting";
    const gen = ++this.gen;
    try {
      const s = await this.o.connect(encodeSubscribeEntriesRequest(this.o.request));
      if (gen !== this.gen || (this.status as string) === "closed") { try { s.cancel(); } catch { /* ignore */ } return; }
      this.stream = s;
      this.status = "connected";
      this.lastMsgAt = this.now();
      let got = false;
      s.on("data", (m: Buffer) => {
        if (gen !== this.gen) return;
        if (!got) { got = true; this.backoff = this.o.reconnectMinMs ?? 250; this.fails = 0; this.log("shredstream receiving entries"); }
        this.onMessage(m);
      });
      s.on("error", (e: Error) => this.down(gen, `error: ${e.message}`));
      s.on("end", () => this.down(gen, "end"));
      if (this.stats.reconnects === 0) this.log("shredstream subscribed");
    } catch (e) {
      this.down(gen, `connect failed: ${(e as Error).message}`);
    }
  }

  private down(gen: number, why: string) {
    if (gen !== this.gen || this.status === "closed" || this.reconnectTimer) return;
    const n = ++this.fails;
    if (n <= 3 || (n & (n - 1)) === 0) this.log(`shredstream down (${why}); reconnecting (attempt ${n})`);
    this.status = "disconnected";
    try { this.stream?.cancel(); } catch { /* ignore */ }
    this.stream = null;
    const delay = Math.round(this.backoff * (0.8 + Math.random() * 0.4));
    this.backoff = Math.min(this.o.reconnectMaxMs ?? 10_000, this.backoff * 2);
    this.stats.reconnects++;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connectOnce(); }, delay);
  }

  /** Process one raw shredstream.Entry message. Public for tests. */
  onMessage(msg: Uint8Array): ShredHit[] {
    const at = this.now();
    this.lastMsgAt = at;
    this.stats.messages++;
    let slot: number, payload: Uint8Array;
    try {
      ({ slot, entries: payload } = decodeEntryMessage(msg));
    } catch {
      this.stats.decodeErrors++;
      return [];
    }
    if (slot > this.lastSlot) this.lastSlot = slot;
    let r: PayloadMatch;
    try {
      r = matchEntriesPayload(payload, slot, this.o.watch, this.o.resolver, at);
    } catch (e) {
      this.stats.decodeErrors++;
      if (this.stats.decodeErrors <= 5 || this.stats.decodeErrors % 1000 === 0) this.log(`shred decode error #${this.stats.decodeErrors} (slot ${slot}): ${(e as Error).message}`);
      return [];
    }
    if (r.kind !== "entries") { if (r.kind === "block-marker") this.stats.markers++; return []; }
    this.stats.entries += r.entries;
    this.stats.txs += r.txs;
    this.stats.hits += r.hits.length;
    reportHits(r.hits, { pending: this.o.pending, signal: this.o.signal, log: this.log });
    return r.hits;
  }
}

// ============================ shared by the gRPC and UDP shred paths ============================

export interface PayloadMatch {
  kind: PayloadKind;
  entries: number;
  txs: number;
  hits: ShredHit[];
}

/**
 * Decode one deshredded payload (a bincode Vec<Entry>, or an Alpenglow block marker / empty
 * batch) and classify every transaction against the watch set. Throws on a malformed entries
 * payload (callers count it as a decode error).
 */
export function matchEntriesPayload(payload: Uint8Array, slot: number, watch: WatchSet, resolver: LookupResolver | undefined, at: number): PayloadMatch {
  const kind = classifyPayload(payload);
  if (kind !== "entries") return { kind, entries: 0, txs: 0, hits: [] };
  const entries = decodeEntries(payload);
  const hits: ShredHit[] = [];
  let txs = 0;
  for (const e of entries) {
    for (const tx of e.transactions) {
      txs++;
      const h = classifyTx(tx, slot, watch, resolver, at);
      if (h) hits.push(h);
    }
  }
  return { kind, entries: entries.length, txs, hits };
}

export interface HitSink {
  pending?: PendingActivity;
  signal?: ChangeSignal;
  log: (m: string) => void;
}

/** Log hits, record them as pending activity and wake the engine once for any non-own hit. */
export function reportHits(hits: ShredHit[], o: HitSink, tag = "shred", extra?: (h: ShredHit) => string): void {
  for (const h of hits) {
    o.pending?.record(h);
    const fee = h.cuPriceMicroLamports !== undefined ? ` cuPrice=${h.cuPriceMicroLamports}µ cuLimit=${h.cuLimit ?? "?"}` : h.v1PriorityFee !== undefined ? ` v1PriorityFee=${h.v1PriorityFee}` : "";
    o.log(`[${tag} ${h.slot}] pending ${h.own ? "OWN " : ""}${h.kind} ${h.signature.slice(0, 16)}… payer ${h.feePayer.slice(0, 8)}… v${h.version}${fee}${h.unresolvedLookups ? ` (${h.unresolvedLookups} unresolved ALTs)` : ""}${extra ? extra(h) : ""}`);
  }
  const first = hits.find((h) => !h.own);
  if (first) o.signal?.notify(`shred:${first.kind}`);
}
