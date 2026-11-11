// ERPC "Shreds UDP Forwarding" ingestor: ERPC forwards raw Solana turbine shreds as UDP
// packets to a port on our VPS. We parse them (src/feeds/shred-wire.ts), deshred completed
// data batches, recover missing data shreds from coding shreds (Reed-Solomon, verified
// against the FEC set's Merkle root), decode the entries with the same decoder as the
// gRPC ShredStream path (src/feeds/shreds.ts) and emit the same pending-activity hint +
// engine wake-up for txs touching the RISE program / DLMM pool / reserves.
//
// Like the gRPC path this is a HINT, never state. We do NOT verify the leader's signature
// over the Merkle root (that needs the leader schedule and an ed25519 verify per FEC set):
// packets are only accepted from SHREDS_UDP_ALLOWED_SOURCES (ERPC's forwarders), a bad or
// forged shred can at worst cause a spurious log line / an early re-evaluation (or a hold, if
// SHREDS_HOLD_ON_COMPETING_ARB is on), and every trade is still quoted from RPC/gRPC state
// and simulated before it is sent. Recovered shreds ARE checked: the recomputed Merkle tree
// of the whole FEC set must reproduce the root committed to by a received coding shred.
//
// Deshredding follows Agave's blockstore: data shreds of a slot are grouped into
// "completed data ranges" — a contiguous run of data shreds that starts at index 0 or right
// after a DATA_COMPLETE_SHRED and ends at the next DATA_COMPLETE_SHRED. Their data is
// concatenated (Shredder::deshred) and decoded as one wincode Vec<Entry> (or Alpenglow
// BlockComponent marker, which classifyPayload recognises and skips). A range whose start
// we cannot establish (we joined mid-slot and missed the previous DATA_COMPLETE shred) is
// not decoded.
//
// Offline replay of a capture (src/feeds/shreds-udp-capture.ts):
//   npx tsx src/feeds/shreds-udp.ts --replay /var/tmp/shreds.cap [--allow ip,ip] [--quiet]
import { createSocket, type Socket } from "node:dgram";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import type { ChangeSignal } from "./signal.js";
import {
  defaultWatchSet, matchEntriesPayload, reportHits, type LookupResolver, type PayloadKind, type PendingActivity, type ShredHit, type WatchSet,
} from "./shreds.js";
import {
  DATA_SHREDS_PER_FEC_BLOCK, FLAG_DATA_COMPLETE, FLAG_LAST_IN_SLOT, MERKLE_LEAF_PREFIX, SIZE_OF_DATA_SHRED_HEADERS, SIZE_OF_MERKLE_ROOT,
  SIZE_OF_SIGNATURE, merkleCapacity, merkleRootOf, merkleTree, parseShred, sha256, variantByte, type ParsedShred, type ShredError,
} from "./shred-wire.js";
import { reedSolomon } from "./reed-solomon.js";
import { normalizeAddress, readCapture } from "./shreds-udp-capture.js";

export interface ShredsUdpOptions {
  /** UDP port to bind. Omit for replay-only use. */
  port?: number;
  bind?: string;
  /** Requested SO_RCVBUF in bytes (the kernel caps it at net.core.rmem_max). */
  rcvbuf?: number;
  /** Accept packets only from these source IPs. Empty/undefined = accept all (logged as a warning). */
  allowedSources?: string[];
  /** Drop shreds whose header version differs (cluster shred version). Undefined = no check. */
  shredVersion?: number;
  /** Evict slots more than this many slots older than the newest slot seen. */
  maxSlotLag?: number;
  /** Ignore shreds this far ahead of the newest slot (garbage); re-baselines after a long streak. */
  maxFutureSlots?: number;
  /** Cap on buffered shred bytes; oldest slots are evicted beyond it. */
  maxBufferedBytes?: number;
  /** Reed-Solomon recovery of missing data shreds. */
  recovery?: boolean;
  /** Enforce Agave's fixed 32:32 FEC layout checks (filter.rs). */
  strictFixedFec?: boolean;
  watch: WatchSet;
  resolver?: LookupResolver;
  pending?: PendingActivity;
  signal?: ChangeSignal;
  /** Period of the summary log line / onSummary record (0 = off). */
  summaryMs?: number;
  /** Warn once when no packet arrived for this long. */
  staleMs?: number;
  onSummary?: (s: Record<string, unknown>) => void;
  /** Every decoded (or failed) batch; tests and replay. */
  onBatch?: (b: BatchEvent) => void;
  log?: (m: string) => void;
  now?: () => number;
}

export interface BatchEvent {
  slot: number;
  start: number;
  end: number;
  bytes: number;
  recovered: boolean;
  kind: PayloadKind | "decode-error" | "empty";
  entries: number;
  txs: number;
  hits: ShredHit[];
  /** first shred of the batch -> decoded, ms */
  latencyMs: number;
}

interface DataRec {
  /** Entry bytes; null once emitted in a batch. */
  data: Uint8Array | null;
  complete: boolean;
  at: number;
  recovered: boolean;
}

interface FecState {
  fec: number;
  signature: Uint8Array;
  proofSize: number;
  chained: boolean;
  resigned: boolean;
  version: number;
  firstAt: number;
  /** From the first coding shred (or the fixed 32 when strict). */
  numData: number;
  numCoding: number;
  firstCodingIndex: number;
  /** First coding shred (payload copy): its proof commits to the FEC set's Merkle root. */
  rootShred: ParsedShred | null;
  chainedRoot: Uint8Array | null;
  dataShards: Map<number, Uint8Array>;
  codeShards: Map<number, Uint8Array>;
  codeSeen: Set<number>;
  dataPresent: number;
  done: boolean;
  recovered: boolean;
  failures: number;
  bytes: number;
}

interface SlotState {
  slot: number;
  data: Map<number, DataRec>;
  fecs: Map<number, FecState>;
  emitted: Set<number>;
  emittedEnds: Set<number>;
  dataShreds: number;
  codeShreds: number;
  bytes: number;
}

const ZERO_STATS = {
  packets: 0, accepted: 0, invalid: 0, foreign: 0, versionMismatch: 0, staleSlot: 0, futureSlot: 0, duplicates: 0, conflicts: 0,
  dataShreds: 0, codeShreds: 0, completedBatches: 0, emptyBatches: 0, markers: 0, decodeErrors: 0, entries: 0, txs: 0, matches: 0,
  recoveredShreds: 0, recoveredFecSets: 0, recoveredBatches: 0, recoveryFailures: 0, unrecoverableFecSets: 0, incompleteFecSets: 0,
  incompleteBatches: 0, orphanDataShreds: 0, slotsEvicted: 0, memoryEvictions: 0, handlerErrors: 0,
};
export type ShredsUdpStats = typeof ZERO_STATS;

function pct(xs: number[], p: number): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10;
}
function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
const copy = (b: Uint8Array) => Uint8Array.prototype.slice.call(b) as Uint8Array;

export class ShredsUdpFeed {
  stats: ShredsUdpStats = { ...ZERO_STATS };
  invalidReasons: Partial<Record<ShredError, number>> = {};
  newestSlot = -1;
  bufferedBytes = 0;
  lastPacketAt = 0;
  status: "idle" | "listening" | "closed" | "error" = "idle";
  /** Effective SO_RCVBUF after bind. */
  rcvbuf = 0;
  private slots = new Map<number, SlotState>();
  /** Slots evicted for memory while still inside the lag window: later shreds are dropped (no re-decode). */
  private dead = new Set<number>();
  private allowed: Set<string> | null;
  private futureStreak = 0;
  private sock: Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rebindTimer: ReturnType<typeof setTimeout> | null = null;
  private staleLogged = false;
  private last: ShredsUdpStats = { ...ZERO_STATS };
  private lastSummaryAt: number;
  private periodSlots: { data: number; code: number }[] = [];
  private batchLat: number[] = [];
  private matchLat: number[] = [];
  private log: (m: string) => void;
  private now: () => number;
  private readonly maxSlotLag: number;
  private readonly maxFutureSlots: number;
  private readonly maxBytes: number;
  private readonly recovery: boolean;
  private readonly strict: boolean;

  constructor(private o: ShredsUdpOptions) {
    this.log = o.log ?? ((m) => console.log(m));
    this.now = o.now ?? (() => performance.now());
    this.allowed = o.allowedSources?.length ? new Set(o.allowedSources.map(normalizeAddress)) : null;
    this.maxSlotLag = o.maxSlotLag ?? 12;
    this.maxFutureSlots = o.maxFutureSlots ?? 2_000;
    this.maxBytes = o.maxBufferedBytes ?? 128 * 1024 * 1024;
    this.recovery = o.recovery !== false;
    this.strict = o.strictFixedFec !== false;
    this.lastSummaryAt = this.now();
  }

  // ------------------------------------------------------------------ socket

  start(): void {
    if (this.status !== "idle") return;
    if (!this.allowed) this.log("shreds-udp: SHREDS_UDP_ALLOWED_SOURCES is unset: accepting shreds from ANY source address (set it to ERPC's forwarder IPs)");
    const summaryMs = this.o.summaryMs ?? 60_000;
    const staleMs = this.o.staleMs ?? 5_000;
    this.timer = setInterval(() => {
      const t = this.now();
      if (this.status === "listening" && staleMs > 0 && t - (this.lastPacketAt || this.lastSummaryAt) > staleMs && !this.staleLogged) {
        this.staleLogged = true;
        this.log(`shreds-udp: no packets for ${Math.round((t - (this.lastPacketAt || this.lastSummaryAt)) / 1000)} s on ${this.o.bind ?? "0.0.0.0"}:${this.o.port}`);
      }
      if (summaryMs > 0 && t - this.lastSummaryAt >= summaryMs) this.flushSummary();
    }, 1000);
    this.timer.unref?.();
    this.bindSocket();
  }

  private bindSocket() {
    if (this.status === "closed" || this.o.port === undefined) return;
    const bind = this.o.bind ?? "0.0.0.0";
    const requested = this.o.rcvbuf ?? 64 * 1024 * 1024;
    const sock = createSocket({ type: isIP(bind) === 6 ? "udp6" : "udp4", recvBufferSize: requested });
    this.sock = sock;
    let listening = false;
    sock.on("message", (msg, rinfo) => this.ingest(msg, rinfo.address, this.now()));
    sock.on("error", (e) => {
      this.log(`shreds-udp socket error: ${e.message}${listening ? "" : "; retrying bind in 5 s"}`);
      if (!listening && this.status !== "closed") {
        this.status = "error";
        try { sock.close(); } catch { /* ignore */ }
        this.rebindTimer = setTimeout(() => { this.rebindTimer = null; if ((this.status as string) !== "closed") this.bindSocket(); }, 5_000);
        this.rebindTimer.unref?.();
      }
    });
    sock.bind(this.o.port, bind, () => {
      listening = true;
      this.status = "listening";
      try { this.rcvbuf = sock.getRecvBufferSize(); } catch { this.rcvbuf = 0; }
      // Linux reports twice the granted size (bookkeeping overhead) and caps it at net.core.rmem_max.
      const low = this.rcvbuf > 0 && this.rcvbuf < requested;
      this.log(`shreds-udp listening on ${bind}:${this.o.port} (SO_RCVBUF effective ${this.rcvbuf} bytes, requested ${requested}${low ? "; capped by the kernel: raise net.core.rmem_max" : ""}; recovery=${this.recovery})`);
    });
  }

  close(): void {
    this.status = "closed";
    if (this.timer) clearInterval(this.timer);
    if (this.rebindTimer) clearTimeout(this.rebindTimer);
    try { this.sock?.close(); } catch { /* ignore */ }
    this.sock = null;
  }

  /** Bound port (after start), e.g. when port 0 was requested in tests. */
  address(): { address: string; port: number } | null {
    try { const a = this.sock?.address(); return a ? { address: a.address, port: a.port } : null; } catch { return null; }
  }

  // ------------------------------------------------------------------ ingest

  /** Process one UDP payload. Never throws. `at` is the arrival time in ms (performance.now() live, capture time on replay). */
  ingest(packet: Uint8Array, source: string, at: number): void {
    try {
      this.ingestInner(packet, source, at);
    } catch (e) {
      this.stats.handlerErrors++;
      if (this.stats.handlerErrors <= 5) this.log(`shreds-udp handler error: ${(e as Error).message}`);
    }
  }

  private ingestInner(packet: Uint8Array, source: string, at: number) {
    this.stats.packets++;
    this.lastPacketAt = at;
    if (this.staleLogged) { this.staleLogged = false; this.log("shreds-udp receiving packets again"); }
    if (this.allowed && !this.allowed.has(normalizeAddress(source))) { this.stats.foreign++; return; }
    const r = parseShred(packet, { strictFixedFec: this.strict });
    if (!r.ok) {
      this.stats.invalid++;
      this.invalidReasons[r.error] = (this.invalidReasons[r.error] ?? 0) + 1;
      return;
    }
    const s = r.shred;
    if (this.o.shredVersion !== undefined && s.version !== this.o.shredVersion) { this.stats.versionMismatch++; return; }
    if (!this.admitSlot(s.slot)) return;
    const st = this.slotState(s.slot);
    this.stats.accepted++;
    if (s.type === "data") this.onDataShred(st, s, at);
    else this.onCodeShred(st, s, at);
    if (this.bufferedBytes > this.maxBytes) this.evictForMemory();
  }

  private admitSlot(slot: number): boolean {
    if (this.newestSlot < 0) this.newestSlot = slot;
    if (slot < this.newestSlot - this.maxSlotLag || this.dead.has(slot)) { this.stats.staleSlot++; return false; }
    if (slot > this.newestSlot + this.maxFutureSlots) {
      this.stats.futureSlot++;
      if (++this.futureStreak < 512) return false;
      this.log(`shreds-udp: re-baselining newest slot ${this.newestSlot} -> ${slot} after ${this.futureStreak} far-future shreds`);
      this.newestSlot = slot;
    }
    this.futureStreak = 0;
    if (slot > this.newestSlot) {
      this.newestSlot = slot;
      for (const st of [...this.slots.values()]) if (st.slot < slot - this.maxSlotLag) this.evict(st);
      for (const d of this.dead) if (d < slot - this.maxSlotLag) this.dead.delete(d);
    }
    return true;
  }

  private slotState(slot: number): SlotState {
    let st = this.slots.get(slot);
    if (!st) {
      st = { slot, data: new Map(), fecs: new Map(), emitted: new Set(), emittedEnds: new Set(), dataShreds: 0, codeShreds: 0, bytes: 0 };
      this.slots.set(slot, st);
    }
    return st;
  }

  private addBytes(st: SlotState, f: FecState | null, n: number) {
    st.bytes += n;
    this.bufferedBytes += n;
    if (f) f.bytes += n;
  }

  private fecState(st: SlotState, s: ParsedShred, at: number): FecState | null {
    let f = st.fecs.get(s.fecSetIndex);
    if (!f) {
      f = {
        fec: s.fecSetIndex, signature: copy(s.signature), proofSize: s.proofSize, chained: s.chained, resigned: s.resigned, version: s.version,
        firstAt: at, numData: this.strict ? DATA_SHREDS_PER_FEC_BLOCK : -1, numCoding: -1, firstCodingIndex: -1, rootShred: null, chainedRoot: null,
        dataShards: new Map(), codeShards: new Map(), codeSeen: new Set(), dataPresent: 0, done: false, recovered: false, failures: 0, bytes: 0,
      };
      st.fecs.set(s.fecSetIndex, f);
      this.addBytes(st, f, 256);
      return f;
    }
    // All shreds of one FEC set carry the leader's signature of the same Merkle root and the
    // same variant (proof size, chained, resigned). A mismatch is a duplicate block, a
    // different fork's shred, or garbage: keep the first.
    if (!eq(f.signature, s.signature) || f.proofSize !== s.proofSize || f.chained !== s.chained || f.resigned !== s.resigned || f.version !== s.version) {
      this.stats.conflicts++;
      return null;
    }
    return f;
  }

  private storeShard(st: SlotState, f: FecState, s: ParsedShred, map: Map<number, Uint8Array>, pos: number) {
    if (!this.recovery || f.done) return;
    const shard = copy(s.payload.subarray(s.shardStart, s.shardEnd));
    map.set(pos, shard);
    this.addBytes(st, f, shard.length);
    if (f.chained && !f.chainedRoot) f.chainedRoot = copy(s.payload.subarray(s.chainedRootOffset, s.chainedRootOffset + SIZE_OF_MERKLE_ROOT));
  }

  private onDataShred(st: SlotState, s: ParsedShred, at: number) {
    if (st.data.has(s.index)) { this.stats.duplicates++; return; }
    const f = this.fecState(st, s, at);
    if (!f) return;
    this.stats.dataShreds++;
    st.dataShreds++;
    const rec: DataRec = { data: copy(s.data), complete: s.dataComplete, at, recovered: false };
    st.data.set(s.index, rec);
    this.addBytes(st, null, rec.data!.length + 48);
    f.dataPresent++;
    this.storeShard(st, f, s, f.dataShards, s.index - f.fec);
    this.checkFecDone(st, f);
    this.onData(st, s.index, at);
    this.maybeRecover(st, f, at);
  }

  private onCodeShred(st: SlotState, s: ParsedShred, at: number) {
    const f0 = st.fecs.get(s.fecSetIndex);
    if (f0?.codeSeen.has(s.position)) { this.stats.duplicates++; return; }
    const f = this.fecState(st, s, at);
    if (!f) return;
    if (f.firstCodingIndex < 0) {
      if (f.numData > 0 && f.numData !== s.numData) { this.stats.conflicts++; return; }
      f.numData = s.numData;
      f.numCoding = s.numCoding;
      f.firstCodingIndex = s.index - s.position;
      if (this.recovery && !f.done) {
        const p = parseShred(copy(s.payload), { strictFixedFec: this.strict });
        if (p.ok) { f.rootShred = p.shred; this.addBytes(st, f, p.shred.payload.length); }
      }
    } else if (f.numData !== s.numData || f.numCoding !== s.numCoding || f.firstCodingIndex !== s.index - s.position) {
      this.stats.conflicts++;
      return;
    }
    f.codeSeen.add(s.position);
    this.stats.codeShreds++;
    st.codeShreds++;
    this.storeShard(st, f, s, f.codeShards, s.position);
    this.checkFecDone(st, f);
    this.maybeRecover(st, f, at);
  }

  private checkFecDone(st: SlotState, f: FecState) {
    if (!f.done && f.numData > 0 && f.dataPresent >= f.numData) this.finishFec(st, f);
  }

  private finishFec(st: SlotState, f: FecState) {
    f.done = true;
    const freed = f.bytes - 256;
    if (freed > 0) { st.bytes -= freed; this.bufferedBytes -= freed; f.bytes = 256; }
    f.dataShards.clear();
    f.codeShards.clear();
    f.rootShred = null;
  }

  private maybeRecover(st: SlotState, f: FecState, at: number) {
    if (!this.recovery || f.done || f.numCoding < 0 || !f.rootShred || f.failures >= 3) return;
    if (f.dataPresent >= f.numData) return;
    if (f.dataShards.size + f.codeShards.size < f.numData) return;
    this.recover(st, f, at);
  }

  /** Reed-Solomon recovery of the FEC set's missing data shreds, checked against its Merkle root. */
  private recover(st: SlotState, f: FecState, at: number) {
    const nd = f.numData, nc = f.numCoding;
    const fail = (why: string) => {
      f.failures++;
      this.stats.recoveryFailures++;
      if (this.stats.recoveryFailures <= 5 || this.stats.recoveryFailures % 1000 === 0) this.log(`shreds-udp recovery failed (slot ${st.slot} fec ${f.fec}): ${why}`);
    };
    const shards: (Uint8Array | null)[] = [];
    for (let i = 0; i < nd; i++) shards.push(f.dataShards.get(i) ?? null);
    for (let j = 0; j < nc; j++) shards.push(f.codeShards.get(j) ?? null);
    const missingData: number[] = [];
    for (let i = 0; i < nd; i++) if (!shards[i]) missingData.push(i);
    try {
      reedSolomon(nd, nc).reconstruct(shards);
    } catch (e) {
      return fail((e as Error).message);
    }
    // Merkle check: leaves of all nd+nc shreds must rebuild the root the coding shred's proof commits to.
    const expected = merkleRootOf(f.rootShred!);
    if (!expected) return fail("coding shred has an invalid Merkle proof");
    const tail = f.chained ? [f.chainedRoot!] : [];
    const header = copy(f.rootShred!.payload.subarray(SIZE_OF_SIGNATURE, f.rootShred!.shardStart));
    const hv = new DataView(header.buffer);
    const leaves: Uint8Array[] = [];
    for (let i = 0; i < nd; i++) leaves.push(sha256(MERKLE_LEAF_PREFIX, shards[i]!, ...tail));
    for (let j = 0; j < nc; j++) {
      hv.setUint32(73 - SIZE_OF_SIGNATURE, f.firstCodingIndex + j, true);
      hv.setUint16(87 - SIZE_OF_SIGNATURE, j, true);
      leaves.push(sha256(MERKLE_LEAF_PREFIX, header, shards[nd + j]!, ...tail));
    }
    const nodes = merkleTree(leaves);
    if (!eq(nodes[nodes.length - 1], expected)) return fail("recovered shreds do not match the Merkle root");
    const dataVariant = variantByte({ type: "data", proofSize: f.proofSize, chained: f.chained, resigned: f.resigned });
    const cap = merkleCapacity("data", f.proofSize, f.chained, f.resigned);
    const recovered: number[] = [];
    for (const i of missingData) {
      const shard = shards[i]!;
      const dv = new DataView(shard.buffer, shard.byteOffset, shard.byteLength);
      // shard = payload[64..]: variant, slot, index, version, fec, parent_offset, flags, size, data
      const index = f.fec + i;
      const flags = shard[21];
      const size = dv.getUint16(22, true);
      const parentOffset = dv.getUint16(19, true);
      const ok = shard[0] === dataVariant && dv.getBigUint64(1, true) === BigInt(st.slot) && dv.getUint32(9, true) === index && dv.getUint16(13, true) === f.version
        && dv.getUint32(15, true) === f.fec && size >= SIZE_OF_DATA_SHRED_HEADERS && size <= SIZE_OF_DATA_SHRED_HEADERS + cap
        && !((flags & FLAG_LAST_IN_SLOT) !== 0 && (flags & FLAG_DATA_COMPLETE) === 0) && !(parentOffset === 0 && st.slot !== 0) && parentOffset <= st.slot
        && (!this.strict || (flags & FLAG_DATA_COMPLETE) === 0 || i === DATA_SHREDS_PER_FEC_BLOCK - 1);
      if (!ok) { this.stats.recoveryFailures++; continue; }
      if (st.data.has(index)) continue;
      const data = copy(shard.subarray(SIZE_OF_DATA_SHRED_HEADERS - SIZE_OF_SIGNATURE, size - SIZE_OF_SIGNATURE));
      st.data.set(index, { data, complete: (flags & FLAG_DATA_COMPLETE) !== 0, at: f.firstAt, recovered: true });
      this.addBytes(st, null, data.length + 48);
      f.dataPresent++;
      recovered.push(index);
    }
    this.stats.recoveredShreds += recovered.length;
    this.stats.recoveredFecSets++;
    f.recovered = true;
    this.finishFec(st, f);
    for (const idx of recovered) this.onData(st, idx, at);
  }

  // ------------------------------------------------------------------ deshred

  private onData(st: SlotState, i: number, at: number) {
    this.tryBatch(st, i, at);
    const r = st.data.get(i);
    if (r?.complete && st.data.has(i + 1)) this.tryBatch(st, i + 1, at);
  }

  /** Emit the completed data range containing index i, if all of it is present and its start is known. */
  private tryBatch(st: SlotState, i: number, at: number) {
    let e = i;
    for (;;) {
      const r = st.data.get(e);
      if (!r || r.data === null) return;
      if (r.complete) break;
      e++;
    }
    let s = i;
    while (s > 0) {
      const p = st.data.get(s - 1);
      if (!p) return; // start unknown (missing shred, or we joined mid-slot)
      if (p.complete) break;
      if (p.data === null) return;
      s--;
    }
    if (st.emitted.has(s)) return;
    st.emitted.add(s);
    st.emittedEnds.add(e);
    const parts: Uint8Array[] = [];
    let firstAt = Infinity, recovered = false, freed = 0;
    for (let k = s; k <= e; k++) {
      const r = st.data.get(k)!;
      parts.push(r.data!);
      freed += r.data!.length;
      r.data = null;
      if (r.at < firstAt) firstAt = r.at;
      if (r.recovered) recovered = true;
    }
    st.bytes -= freed;
    this.bufferedBytes -= freed;
    this.decodeBatch(st.slot, s, e, Buffer.concat(parts), firstAt, recovered, at);
  }

  private decodeBatch(slot: number, start: number, end: number, buf: Buffer, firstAt: number, recovered: boolean, at: number) {
    this.stats.completedBatches++;
    if (recovered) this.stats.recoveredBatches++;
    const latencyMs = Math.max(0, at - firstAt);
    const ev: BatchEvent = { slot, start, end, bytes: buf.length, recovered, kind: "empty", entries: 0, txs: 0, hits: [], latencyMs };
    if (buf.length === 0) {
      // Shredder::deshred: an empty batch deserializes to an empty Vec<Entry>
      this.stats.emptyBatches++;
      this.o.onBatch?.(ev);
      return;
    }
    try {
      const r = matchEntriesPayload(buf, slot, this.o.watch, this.o.resolver, at);
      ev.kind = r.kind;
      ev.entries = r.entries;
      ev.txs = r.txs;
      ev.hits = r.hits;
    } catch (e) {
      ev.kind = "decode-error";
      this.stats.decodeErrors++;
      if (this.stats.decodeErrors <= 5 || this.stats.decodeErrors % 1000 === 0) this.log(`shreds-udp decode error #${this.stats.decodeErrors} (slot ${slot} shreds ${start}..${end}): ${(e as Error).message}`);
      this.o.onBatch?.(ev);
      return;
    }
    if (ev.kind === "block-marker") this.stats.markers++;
    else if (ev.kind === "empty") this.stats.emptyBatches++;
    this.stats.entries += ev.entries;
    this.stats.txs += ev.txs;
    this.batchLat.push(latencyMs);
    if (this.batchLat.length > 100_000) this.batchLat.splice(0, 50_000);
    if (ev.hits.length) {
      this.stats.matches += ev.hits.length;
      for (let k = 0; k < ev.hits.length; k++) this.matchLat.push(latencyMs);
      if (this.matchLat.length > 100_000) this.matchLat.splice(0, 50_000);
      reportHits(ev.hits, { pending: this.o.pending, signal: this.o.signal, log: this.log }, "shred-udp",
        () => ` +${latencyMs.toFixed(1)}ms from first shred${recovered ? " (recovered)" : ""}`);
    }
    this.o.onBatch?.(ev);
  }

  // ------------------------------------------------------------------ eviction / metrics

  private evict(st: SlotState) {
    this.slots.delete(st.slot);
    this.bufferedBytes -= st.bytes;
    this.stats.slotsEvicted++;
    this.periodSlots.push({ data: st.dataShreds, code: st.codeShreds });
    if (this.periodSlots.length > 10_000) this.periodSlots.shift();
    for (const [idx, r] of st.data) {
      if (r.complete && !st.emittedEnds.has(idx)) this.stats.incompleteBatches++;
      if (r.data !== null) this.stats.orphanDataShreds++;
    }
    for (const f of st.fecs.values()) {
      if (f.done) continue;
      this.stats.incompleteFecSets++;
      if (f.numCoding > 0 && f.dataShards.size + f.codeShards.size < f.numData) this.stats.unrecoverableFecSets++;
    }
  }

  private evictForMemory() {
    const order = [...this.slots.values()].sort((a, b) => a.slot - b.slot);
    for (const st of order) {
      if (this.bufferedBytes <= this.maxBytes) break;
      this.stats.memoryEvictions++;
      this.evict(st);
      this.dead.add(st.slot);
    }
  }

  /** Flush all buffered slots into the counters (end of a replay). */
  drain(): void {
    for (const st of [...this.slots.values()]) this.evict(st);
  }

  /** Period summary (counter deltas since the previous summary). */
  summary(): Record<string, unknown> {
    const t = this.now();
    const periodMs = Math.max(1, t - this.lastSummaryAt);
    const d = Object.fromEntries(Object.entries(this.stats).map(([k, v]) => [k, v - this.last[k as keyof ShredsUdpStats]])) as ShredsUdpStats;
    const ps = this.periodSlots;
    const out = {
      kind: "shreds-udp",
      periodMs: Math.round(periodMs),
      packets: d.packets,
      packetsPerSec: Math.round((d.packets * 1000) / periodMs),
      accepted: d.accepted, invalid: d.invalid, foreign: d.foreign, versionMismatch: d.versionMismatch, staleSlot: d.staleSlot, futureSlot: d.futureSlot,
      duplicates: d.duplicates, conflicts: d.conflicts, dataShreds: d.dataShreds, codeShreds: d.codeShreds,
      slots: ps.length,
      dataShredsPerSlot: ps.length ? Math.round(ps.reduce((a, x) => a + x.data, 0) / ps.length) : undefined,
      codeShredsPerSlot: ps.length ? Math.round(ps.reduce((a, x) => a + x.code, 0) / ps.length) : undefined,
      maxDataShredsPerSlot: ps.length ? Math.max(...ps.map((x) => x.data)) : undefined,
      completedBatches: d.completedBatches, recoveredBatches: d.recoveredBatches, incompleteBatches: d.incompleteBatches,
      recoveredShreds: d.recoveredShreds, recoveredFecSets: d.recoveredFecSets, recoveryFailures: d.recoveryFailures,
      incompleteFecSets: d.incompleteFecSets, unrecoverableFecSets: d.unrecoverableFecSets,
      decodeErrors: d.decodeErrors, markers: d.markers, entries: d.entries, txs: d.txs, matches: d.matches,
      batchLatencyP50Ms: pct(this.batchLat, 0.5), batchLatencyP90Ms: pct(this.batchLat, 0.9),
      matchLatencyP50Ms: pct(this.matchLat, 0.5), matchLatencyP90Ms: pct(this.matchLat, 0.9), matchLatencyMaxMs: pct(this.matchLat, 1),
      memoryEvictions: d.memoryEvictions, handlerErrors: d.handlerErrors,
      invalidReasons: { ...this.invalidReasons },
      bufferedBytes: this.bufferedBytes, slotsBuffered: this.slots.size, newestSlot: this.newestSlot, rcvbuf: this.rcvbuf,
    };
    this.last = { ...this.stats };
    this.lastSummaryAt = t;
    this.periodSlots = [];
    this.batchLat = [];
    this.matchLat = [];
    this.invalidReasons = {};
    return out;
  }

  /** Start the current summary period at t (replay: the first packet's capture time). */
  resetPeriod(t: number): void {
    this.lastSummaryAt = t;
  }

  flushSummary(): Record<string, unknown> {
    const s = this.summary();
    const f = (k: string) => (s[k] === undefined ? "-" : String(s[k]));
    this.log(`shreds-udp ${f("packetsPerSec")} pkt/s (invalid ${f("invalid")}, foreign ${f("foreign")}, dup ${f("duplicates")}) slots ${f("slots")} data/code per slot ${f("dataShredsPerSlot")}/${f("codeShredsPerSlot")}`
      + ` batches ${f("completedBatches")} (recovered ${f("recoveredBatches")}, incomplete ${f("incompleteBatches")}, unrecoverable FEC ${f("unrecoverableFecSets")})`
      + ` txs ${f("txs")} matches ${f("matches")} first-shred->match p50/p90 ${f("matchLatencyP50Ms")}/${f("matchLatencyP90Ms")} ms`);
    this.o.onSummary?.(s);
    return s;
  }

  describe(): string {
    return `udp ${this.o.bind ?? "0.0.0.0"}:${this.o.port} (${this.allowed ? `${this.allowed.size} allowed sources` : "ANY source"}, recovery=${this.recovery})`;
  }
}

/** Feed a capture file's packets through a feed (as fast as possible; arrival times from the capture). */
export function replayCapture(buf: Uint8Array, feed: ShredsUdpFeed): number {
  let n = 0;
  for (const p of readCapture(buf)) {
    feed.ingest(p.payload, p.address, Number(p.tNs / 1000n) / 1000);
    n++;
  }
  return n;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]) {
  const file = arg(argv, "--replay");
  if (!file) {
    console.error("usage: npx tsx src/feeds/shreds-udp.ts --replay CAPTURE [--allow ip,ip] [--no-recovery] [--quiet]");
    process.exit(2);
  }
  const quiet = argv.includes("--quiet");
  const holder: { feed?: ShredsUdpFeed } = {};
  const feed = new ShredsUdpFeed({
    watch: defaultWatchSet(), allowedSources: arg(argv, "--allow")?.split(",").map((s) => s.trim()).filter(Boolean),
    recovery: !argv.includes("--no-recovery"), summaryMs: 0,
    // capture time, so the summary period covers the capture
    now: () => holder.feed?.lastPacketAt ?? 0,
    log: (m) => { if (!quiet || !m.startsWith("[")) console.log(m); },
  });
  holder.feed = feed;
  const buf = readFileSync(file);
  const first = readCapture(buf).next();
  if (!first.done) feed.resetPeriod(Number(first.value.tNs / 1000n) / 1000);
  const n = replayCapture(buf, feed);
  feed.drain();
  console.log(`replayed ${n} packets`);
  console.log(JSON.stringify({ ...feed.stats, invalidReasons: feed.invalidReasons, summary: feed.summary() }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error((e as Error).message); process.exit(1); });
}
