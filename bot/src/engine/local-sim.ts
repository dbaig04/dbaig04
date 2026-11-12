// Local full-transaction simulation (LOCAL_SIM=shadow, simulate mode only).
//
// LocalTxSimulator executes the exact VersionedTransaction the engine would send in LiteSVM
// (src/engine/local-sim-worker.mjs, a child process with a per-request deadline) against the
// engine's own account snapshot, with the real mainnet program binaries and mainnet's feature set:
//   - programs: PumpSwap (pAMMBay…), pump fees (pfeeUx…, owner of PumpSwap's FeeConfig), Meteora DLMM
//     (LBUZKh…), SPL Token (Tokenkeg…, upgradeable on mainnet since the p-token migration — LiteSVM's
//     bundled SPL Token is NOT the mainnet program), Token-2022, ATA, Memo: all loaded from chain
//     (programdata minus its 45-byte header; loader-v2 programs from the program account). Never
//     LiteSVM's bundled SPL programs. Upgradeable programs are re-checked every `checkIntervalMs`
//     (45-byte programdata header): a changed deploy slot makes every simulation refuse until the new
//     binary is loaded; a check that is overdue (3 intervals without a successful check) refuses too.
//   - runtime: LiteSVM builtins (system, compute budget, loaders), precompiles and sysvars; the feature
//     set is mainnet's (every feature LiteSVM knows, activated iff its feature account says so).
//   - Clock: slot = snapshot slot, the other fields (unix_timestamp: DLMM fees depend on it, epoch…)
//     from the snapshot's Clock sysvar account. Rent: from chain (SysvarRent) at startup.
//   - signatures: sigverify off (simulate mode has no keypair) — instead the message's required
//     signers must be exactly [user] (fee payer, writable), checked and reported.
//   - blockhash: LiteSVM does not know mainnet blockhashes, so its check is off (as the RPC simulation's
//     replaceRecentBlockhash: true); instead the tx's blockhash must be the one the engine's
//     BlockhashCache handed out, no older than `maxBlockhashAgeMs`.
//   - compute: the tx's own SetComputeUnitLimit/Price instructions (no ComputeBudget override).
//   - accounts: EVERY account the message references (incl. lookup-table entries) must be in the
//     snapshot (an entry, or an explicit null = verified non-existent), a loaded program, a builtin or
//     a provided sysvar. Anything else refuses the simulation with the list of missing keys — it is
//     never simulated against a default/empty account — and the key is added to the live set
//     (LocalSimAccounts) so the next snapshot carries it.
//
// Which accounts are live vs static:
//   live (in the engine's gRPC subscription / RPC poll, i.e. the snapshot): everything the venues
//   quote from (pools, vaults, bin arrays, mints, global/fee config, buyback ATA, Clock), the user's
//   wSOL / token ATAs and volume accumulator (engine), plus LocalSimAccounts: the user's wallet (fee
//   payer lamports), each DLMM pool's reserve X / reserve Y / oracle (written by every swap), both
//   event authorities, and any key a refused simulation reported missing.
//   static (fetched here, never in the snapshot): program binaries (immutable until the deploy slot
//   changes, checked as above), Rent (constant on mainnet), lookup tables and Jito tip accounts if a tx
//   uses them (`addStatic`, refreshed with every program check: ALTs only append; a tip account only
//   receives, so its balance can only rise and never makes the transfer fail).
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type AccountInfo, type AddressLookupTableAccount, type Connection, type VersionedTransaction } from "@solana/web3.js";
import type { StateSource, SwapVenue } from "../types.js";
import { decodeTokenAmount } from "./state.js";
import { evaluateSimOutcome, type SimParams, type SimPlan, type SimResult } from "./simulate.js";
import type { Ledger } from "./ledger.js";
import { EVENT_AUTHORITY as DLMM_EVENT_AUTHORITY } from "../meteora/pda.js";
import { EVENT_AUTHORITY as PUMP_EVENT_AUTHORITY } from "../pumpswap/pda.js";

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "local-sim-worker.mjs");

export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const LOADER_V2 = "BPFLoader2111111111111111111111111111111111";
export const FEATURE_PROGRAM = "Feature111111111111111111111111111111111111";
export const SYSVAR_CLOCK = "SysvarC1ock11111111111111111111111111111111";
export const SYSVAR_RENT = "SysvarRent111111111111111111111111111111111";
const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";

/** Programs a MAX pair tx executes or passes: PumpSwap, pump fees, DLMM, SPL Token, Token-2022, ATA, Memo. */
export const PAIR_PROGRAMS = [
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
];
/** Native programs LiteSVM implements itself (same builtin code as the validator). */
export const BUILTINS = new Set(["11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111"]);
/** Sysvars the simulator provides (Clock from the snapshot, Rent from chain, Instructions synthesized by the runtime). */
const PROVIDED_SYSVARS = new Set([SYSVAR_CLOCK, SYSVAR_RENT, SYSVAR_INSTRUCTIONS]);

// ---------------------------------------------------------------------------------------------
// chain context: programs, feature set, rent

export interface LoadedProgram {
  id: string;
  loader: string;
  /** Programdata address (upgradeable loader only). */
  programData?: string;
  /** Programdata deploy slot (upgradeable) or null (immutable loader-v2 program). */
  deploySlot: string | null;
  elf: Buffer;
  sha256: string;
}

export interface ChainContext {
  features: { id: Buffer; slot: string }[];
  /** Feature ids LiteSVM knows (to detect a feature-set change). */
  knownFeatures: number;
  programs: LoadedProgram[];
  rent: { lpby: string; thr: number; burn: number };
  /** Slot at which the context was read. */
  slot?: number;
}

export type ChainConnection = Pick<Connection, "getMultipleAccountsInfo" | "getSlot">;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export function parseRent(data: Buffer): ChainContext["rent"] {
  return { lpby: data.readBigUInt64LE(0).toString(), thr: data.readDoubleLE(8), burn: data[16] };
}

/** bincode Option<u64> activated_at of a feature account (null = pending / absent). */
export function featureActivationSlot(info: AccountInfo<Buffer> | null): bigint | null {
  if (!info || info.owner.toBase58() !== FEATURE_PROGRAM || info.data.length < 9 || info.data[0] !== 1) return null;
  return info.data.readBigUInt64LE(1);
}

async function getMany(conn: ChainConnection, keys: PublicKey[], dataSlice?: { offset: number; length: number }): Promise<(AccountInfo<Buffer> | null)[]> {
  const out: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const r = await conn.getMultipleAccountsInfo(keys.slice(i, i + 100), { commitment: "confirmed", ...(dataSlice ? { dataSlice } : {}) });
    out.push(...(r as (AccountInfo<Buffer> | null)[]));
  }
  return out;
}

/** Deploy slots of the upgradeable programs (45-byte header reads). */
export async function readDeploySlots(conn: ChainConnection, programs: LoadedProgram[]): Promise<Map<string, string | null>> {
  const up = programs.filter((p) => p.programData);
  const infos = await getMany(conn, up.map((p) => new PublicKey(p.programData!)), { offset: 0, length: 45 });
  const m = new Map<string, string | null>();
  up.forEach((p, i) => {
    const d = infos[i]?.data;
    m.set(p.id, d && d.length >= 12 && d.readUInt32LE(0) === 3 ? d.readBigUInt64LE(4).toString() : null);
  });
  return m;
}

/**
 * Load the mainnet binaries of `ids`. Upgradeable programs are cached on disk as
 * `<cacheDir>/<id>-<deploySlot>.so` (a redeploy always changes the deploy slot); the deploy slot is
 * always read from chain first, so a cached binary is only used for the slot that is deployed now.
 */
export async function loadPrograms(conn: ChainConnection, ids: string[], cacheDir?: string, log?: (m: string) => void): Promise<LoadedProgram[]> {
  const accs = await getMany(conn, ids.map((k) => new PublicKey(k)));
  const out: LoadedProgram[] = [];
  const needFull: { id: string; pd: string; slot: string }[] = [];
  const headers: { id: string; pd: string }[] = [];
  ids.forEach((id, i) => {
    const a = accs[i];
    if (!a || !a.executable) throw new Error(`local-sim: program ${id} missing or not executable`);
    const owner = a.owner.toBase58();
    if (owner === UPGRADEABLE_LOADER) {
      if (a.data.length < 36 || a.data.readUInt32LE(0) !== 2) throw new Error(`local-sim: ${id}: not an upgradeable Program account`);
      headers.push({ id, pd: new PublicKey(a.data.subarray(4, 36)).toBase58() });
    } else if (owner === LOADER_V2) {
      out.push({ id, loader: owner, deploySlot: null, elf: Buffer.from(a.data), sha256: sha(a.data) });
    } else throw new Error(`local-sim: program ${id} owned by unsupported loader ${owner}`);
  });
  const hdr = await getMany(conn, headers.map((h) => new PublicKey(h.pd)), { offset: 0, length: 45 });
  headers.forEach((h, i) => {
    const d = hdr[i]?.data;
    if (!d || d.readUInt32LE(0) !== 3) throw new Error(`local-sim: ${h.id}: programdata ${h.pd} missing`);
    const slot = d.readBigUInt64LE(4).toString();
    const f = cacheDir ? path.join(cacheDir, `${h.id}-${slot}.so`) : null;
    if (f && existsSync(f)) {
      const elf = readFileSync(f);
      out.push({ id: h.id, loader: UPGRADEABLE_LOADER, programData: h.pd, deploySlot: slot, elf, sha256: sha(elf) });
    } else needFull.push({ id: h.id, pd: h.pd, slot });
  });
  // one program per request (programdata is 0.1-1.5 MB each)
  for (const n of needFull) {
    const [pd] = await getMany(conn, [new PublicKey(n.pd)]);
    if (!pd || pd.data.readUInt32LE(0) !== 3) throw new Error(`local-sim: ${n.id}: programdata ${n.pd} missing`);
    const slot = pd.data.readBigUInt64LE(4).toString();
    if (slot !== n.slot) throw new Error(`local-sim: ${n.id}: deploy slot changed while loading (${n.slot} -> ${slot}); retry`);
    const elf = Buffer.from(pd.data.subarray(45));
    if (cacheDir) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(path.join(cacheDir, `${n.id}-${slot}.so`), elf); }
    log?.(`local-sim: loaded ${n.id} from chain (deploy slot ${slot}, ${elf.length} B)`);
    out.push({ id: n.id, loader: UPGRADEABLE_LOADER, programData: n.pd, deploySlot: slot, elf, sha256: sha(elf) });
  }
  return ids.map((id) => out.find((p) => p.id === id)!);
}

/** Mainnet activation state of every feature id LiteSVM knows. */
export async function loadFeatures(conn: ChainConnection, featureIds: string[]): Promise<ChainContext["features"]> {
  const infos = await getMany(conn, featureIds.map((k) => new PublicKey(k)));
  const out: ChainContext["features"] = [];
  featureIds.forEach((id, i) => {
    const s = featureActivationSlot(infos[i]);
    if (s !== null) out.push({ id: new PublicKey(id).toBuffer(), slot: s.toString() });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// worker handle (child process + deadline)

interface Pending { resolve: (v: WorkerReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WorkerReply = Record<string, any> & { id: number; ok: boolean };

export class WorkerHandle {
  readonly child: ChildProcess;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  exited = false;
  stderrTail = "";
  constructor(private onExit: (h: WorkerHandle, why: string) => void, workerPath = WORKER) {
    this.child = fork(workerPath, [], { serialization: "advanced", execArgv: ["--expose-gc"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    this.child.stderr?.on("data", (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-600); });
    this.child.on("message", (m: WorkerReply) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve(m);
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      const why = `worker exited (${signal ?? `code ${code}`})${this.stderrTail ? `: ${this.stderrTail.trim().split("\n").slice(-2).join(" | ").slice(0, 200)}` : ""}`;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
      this.pending.clear();
      this.onExit(this, why);
    });
    this.child.on("error", () => { /* exit follows */ });
    // never keep the bot process alive (a pending request's deadline timer does while it waits)
    this.child.unref();
    (this.child.channel as { unref?: () => void } | undefined)?.unref?.();
    (this.child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
  }

  /** One request with a hard deadline: past it the worker is SIGKILLed (a hang can never block the bot). */
  request(msg: Record<string, unknown>, timeoutMs: number): Promise<WorkerReply> {
    if (this.exited) return Promise.reject(new Error("worker not running"));
    const id = this.nextId++;
    return new Promise<WorkerReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker timeout after ${timeoutMs} ms (${String(msg.op)})`));
        this.kill();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.send({ ...msg, id }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e as Error); }
    });
  }

  kill(): void {
    if (!this.exited) try { this.child.kill("SIGKILL"); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------------------------
// simulator

export interface LocalSimSnapshot {
  slot: number;
  /** Account at the snapshot: AccountInfo, null = verified non-existent, undefined = NOT in the snapshot. */
  get(key: string): AccountInfo<Buffer> | null | undefined;
}

export interface LocalSimRequest {
  tx: VersionedTransaction;
  snapshot: LocalSimSnapshot;
  user: PublicKey;
  wsolAta: PublicKey;
  tokenAta: PublicKey;
  plan: SimPlan;
  params: Pick<SimParams, "wsolPre" | "risePre" | "feeForUnits" | "tipLamports" | "profitFloorLamports" | "toleranceLamports" | "toleranceBps">;
  lookupTables?: AddressLookupTableAccount[];
  /** The blockhash the engine's cache handed out for this tx and its age (ms). */
  blockhash?: { value: string; ageMs: number };
  /** Keys this simulation found missing (e.g. LocalSimAccounts.learn); default: the simulator's onMissing. */
  onMissing?: (keys: string[]) => void;
}

export interface LocalSimChecks {
  signers: string[];
  signersOk: boolean;
  blockhashAgeMs?: number;
  blockhashOk: boolean;
  accounts: number;
  programs: string[];
  missing: string[];
  /** Writable non-program accounts (for the post-hoc state check). */
  writable: string[];
  clockSlot?: string;
  unixTimestamp?: string;
}

export interface LocalSimResult extends SimResult {
  /** Not simulated (missing accounts, stale binary, worker down, failed pre-checks) — not a verdict. */
  refused?: string;
  /** The tx executed to completion without error. */
  execOk: boolean;
  /** Canonical error (same format as canonicalRpcError). */
  errCanon?: string;
  checks?: LocalSimChecks;
  /** Wall time of simulate() (snapshot assembly + IPC + LiteSVM) and the worker's own timings. */
  ms: number;
  workerSimUs?: number;
  workerApplyUs?: number;
  sentAccounts?: number;
}

export interface LocalTxSimulatorOptions {
  conn?: ChainConnection;
  /** Pre-loaded context (offline tests); else loaded from `conn`. */
  context?: ChainContext;
  programs?: string[];
  timeoutMs?: number;
  setupTimeoutMs?: number;
  cacheDir?: string;
  /** Upgradeable-program deploy-slot check period (0 = off; then binaries are never considered stale). */
  checkIntervalMs?: number;
  /** Feature-set refresh period. */
  featureRefreshMs?: number;
  maxBlockhashAgeMs?: number;
  log?: (m: string) => void;
  workerPath?: string;
  /** Called with keys a refused simulation reported missing (LocalSimAccounts.learn). */
  onMissing?: (keys: string[]) => void;
}

export class LocalTxSimulator {
  private worker: WorkerHandle | null = null;
  private ctx: ChainContext | null = null;
  private sent = new Map<string, { lamports: number; owner: string; data: Buffer; executable: boolean } | null>();
  private statics = new Map<string, AccountInfo<Buffer> | null>();
  private respawning: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private lastFeatureRefresh = 0;
  /** Refusal reason while a binary is known to be stale (deploy slot changed) until it is reloaded. */
  staleReason: string | null = null;
  lastCheckOkAt = 0;
  spawns = 0;
  crashes = 0;
  /** LiteSVM build the worker runs (e.g. "litesvm-local-sim@1.6.2"). */
  litesvm = "";
  timeouts = 0;
  readonly o: Required<Pick<LocalTxSimulatorOptions, "timeoutMs" | "setupTimeoutMs" | "checkIntervalMs" | "featureRefreshMs" | "maxBlockhashAgeMs">> & LocalTxSimulatorOptions;
  onMissing?: (keys: string[]) => void;

  constructor(opts: LocalTxSimulatorOptions) {
    this.o = { timeoutMs: 500, setupTimeoutMs: 60_000, checkIntervalMs: 30_000, featureRefreshMs: 600_000, maxBlockhashAgeMs: 60_000, ...opts };
    this.onMissing = opts.onMissing;
    if (opts.context) this.ctx = opts.context;
  }

  private log(m: string) { (this.o.log ?? console.log)(m); }

  get context(): ChainContext | null { return this.ctx; }
  get ready(): boolean { return !!this.ctx && !!this.worker && !this.worker.exited && !this.respawning; }
  private progCache: { ctx: ChainContext; ids: Set<string> } | null = null;
  get programIds(): Set<string> {
    if (!this.ctx) return new Set();
    if (this.progCache?.ctx !== this.ctx) this.progCache = { ctx: this.ctx, ids: new Set(this.ctx.programs.map((p) => p.id)) };
    return this.progCache.ids;
  }

  /** Load programs / features / rent (unless given), start the worker, start the deploy-slot checks. */
  async init(): Promise<void> {
    if (!this.ctx) this.ctx = await this.loadContext();
    await this.spawn();
    this.lastCheckOkAt = Date.now();
    this.lastFeatureRefresh = Date.now();
    if (this.o.checkIntervalMs > 0 && this.o.conn) {
      this.timer = setInterval(() => { void this.check().catch((e) => this.log(`local-sim: program check failed: ${(e as Error).message}`)); }, this.o.checkIntervalMs);
      this.timer.unref?.();
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.worker?.kill();
    this.worker = null;
  }

  /** Feature ids LiteSVM knows (asked from a short-lived worker: the litesvm addon never loads in this process). */
  private async featureIds(): Promise<string[]> {
    const h = new WorkerHandle(() => undefined, this.o.workerPath);
    try {
      const r = await h.request({ op: "featureIds" }, 20_000);
      return r.ids as string[];
    } finally { h.kill(); }
  }

  private async loadContext(): Promise<ChainContext> {
    const conn = this.o.conn;
    if (!conn) throw new Error("local-sim: no connection and no context");
    const ids = await this.featureIds();
    const features = await loadFeatures(conn, ids);
    const programs = await loadPrograms(conn, this.o.programs ?? PAIR_PROGRAMS, this.o.cacheDir, (m) => this.log(m));
    const [rentInfo] = await getMany(conn, [new PublicKey(SYSVAR_RENT)]);
    if (!rentInfo) throw new Error("local-sim: Rent sysvar missing");
    const slot = await conn.getSlot("confirmed");
    this.log(`local-sim: ${features.length}/${ids.length} known features active on mainnet; programs ${programs.map((p) => `${p.id.slice(0, 6)}@${p.deploySlot ?? "immutable"}`).join(" ")}`);
    return { features, knownFeatures: ids.length, programs, rent: parseRent(rentInfo.data), slot };
  }

  private async spawn(): Promise<void> {
    const ctx = this.ctx!;
    this.worker?.kill();
    const h = new WorkerHandle((w, why) => this.exited(w, why), this.o.workerPath);
    this.worker = h;
    this.spawns++;
    this.sent.clear();
    const r = await h.request({ op: "setup", features: ctx.features, rent: ctx.rent, programs: ctx.programs.map((p) => ({ id: p.id, loader: p.loader, elf: p.elf })) }, this.o.setupTimeoutMs);
    if (!r.ok) throw new Error(`local-sim: worker setup failed: ${r.err}`);
    if (this.litesvm !== r.litesvm) this.log(`local-sim: worker ${r.litesvm} ready (${Math.round(r.ms as number)} ms setup)`);
    this.litesvm = r.litesvm as string;
    for (const p of r.programs as { id: string; executable: boolean }[]) if (!p.executable) throw new Error(`local-sim: ${p.id} not executable after load`);
  }

  private exited(w: WorkerHandle, why: string): void {
    if (this.worker !== w) return;
    this.worker = null;
    if (this.closed) return;
    if (/timeout/.test(why) || w.child.signalCode === "SIGKILL") this.timeouts++; else this.crashes++;
    this.log(`local-sim: ${why}; respawning`);
    this.respawn();
  }

  private respawn(): void {
    if (this.respawning || this.closed) return;
    this.respawning = (async () => {
      for (let i = 0; i < 5 && !this.closed; i++) {
        try { await this.spawn(); return; } catch (e) { this.log(`local-sim: respawn failed: ${(e as Error).message}`); await new Promise((r) => setTimeout(r, 1000 * (i + 1))); }
      }
    })().finally(() => { this.respawning = null; });
  }

  /** Wait (up to maxMs) until the worker has its spare VM built, so the first simulations are not queued behind it. */
  async warm(maxMs = 5_000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await this.settled();
      if (this.worker && !this.worker.exited) {
        try { if ((await this.worker.request({ op: "ping" }, 2_000)).spareReady) return true; } catch { /* respawn */ }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  /** Wait until a respawn in progress is done (tests). */
  async settled(): Promise<void> { while (this.respawning) await this.respawning; }

  /** Static (non-snapshot) accounts: lookup tables, tip accounts. Fetched now and on every check. */
  async addStatic(keys: string[]): Promise<void> {
    const todo = keys.filter((k) => !this.statics.has(k));
    if (!todo.length || !this.o.conn) return;
    const infos = await getMany(this.o.conn, todo.map((k) => new PublicKey(k)));
    todo.forEach((k, i) => this.statics.set(k, infos[i]));
  }

  /** Deploy-slot check (+ periodic feature refresh); reloads binaries when a program was redeployed. */
  async check(): Promise<void> {
    const conn = this.o.conn;
    if (!conn || !this.ctx) return;
    const slots = await readDeploySlots(conn, this.ctx.programs);
    const changed = this.ctx.programs.filter((p) => p.programData && slots.get(p.id) !== p.deploySlot);
    if (changed.length) {
      this.staleReason = `program binary stale: ${changed.map((p) => `${p.id.slice(0, 8)} deploy slot ${p.deploySlot} -> ${slots.get(p.id)}`).join(", ")}`;
      this.log(`local-sim: ${this.staleReason}; refusing until reloaded`);
      const programs = await loadPrograms(conn, this.ctx.programs.map((p) => p.id), this.o.cacheDir, (m) => this.log(m));
      this.ctx = { ...this.ctx, programs };
      await this.spawn();
      this.staleReason = null;
      this.log("local-sim: reloaded upgraded program binaries");
    }
    if (Date.now() - this.lastFeatureRefresh >= this.o.featureRefreshMs) {
      this.lastFeatureRefresh = Date.now();
      const ids = await this.featureIds();
      const features = await loadFeatures(conn, ids);
      const key = (f: ChainContext["features"]) => f.map((x) => `${x.id.toString("hex")}@${x.slot}`).sort().join(",");
      if (key(features) !== key(this.ctx.features)) {
        this.log(`local-sim: mainnet feature set changed (${this.ctx.features.length} -> ${features.length} active); reloading`);
        this.ctx = { ...this.ctx, features };
        await this.spawn();
      }
    }
    if (this.statics.size) {
      const keys = [...this.statics.keys()];
      const infos = await getMany(conn, keys.map((k) => new PublicKey(k)));
      keys.forEach((k, i) => this.statics.set(k, infos[i]));
    }
    this.lastCheckOkAt = Date.now();
  }

  /** Why a simulation would be refused right now (null = can run). */
  unavailable(): string | null {
    if (!this.ctx) return "local sim not initialised";
    if (this.staleReason) return this.staleReason;
    if (this.o.checkIntervalMs > 0 && this.o.conn && Date.now() - this.lastCheckOkAt > 3 * this.o.checkIntervalMs) return `program deploy-slot check overdue (last ok ${Math.round((Date.now() - this.lastCheckOkAt) / 1000)} s ago)`;
    if (this.respawning || !this.worker || this.worker.exited) return "local sim worker restarting";
    return null;
  }

  /** Test hook: send a raw op ("hang", "crash", "ping") to the worker. */
  debugRequest(op: string, timeoutMs = this.o.timeoutMs): Promise<WorkerReply> {
    if (!this.worker) return Promise.reject(new Error("no worker"));
    return this.worker.request({ op }, timeoutMs);
  }

  async simulate(req: LocalSimRequest): Promise<LocalSimResult> {
    const t0 = performance.now();
    const done = (r: Omit<LocalSimResult, "ms">): LocalSimResult => ({ ...r, ms: Math.round((performance.now() - t0) * 1000) / 1000 });
    const refuse = (why: string, checks?: LocalSimChecks): LocalSimResult => done({ ok: false, execOk: false, refused: why, reason: `local sim refused: ${why}`, slot: req.snapshot.slot, checks });
    const na = this.unavailable();
    if (na) return refuse(na);
    const msg = req.tx.message;
    // --- signers: exactly the user, as writable fee payer ---
    const h = msg.header;
    const signers = msg.staticAccountKeys.slice(0, h.numRequiredSignatures).map((k) => k.toBase58());
    const signersOk = signers.length === 1 && signers[0] === req.user.toBase58() && h.numReadonlySignedAccounts === 0;
    // --- blockhash: the engine's cached one, not too old (LiteSVM's own check is off: it cannot know mainnet hashes) ---
    const bhAge = req.blockhash?.ageMs;
    const blockhashOk = !req.blockhash || (req.blockhash.value === msg.recentBlockhash && req.blockhash.ageMs <= this.o.maxBlockhashAgeMs);
    // --- account keys (lookup tables resolved) ---
    let keys: PublicKey[];
    let writableFlags: boolean[];
    const lookups = "addressTableLookups" in msg ? msg.addressTableLookups : [];
    try {
      if (lookups.length) {
        const ak = msg.getAccountKeys({ addressLookupTableAccounts: req.lookupTables ?? [] });
        keys = [...ak.staticAccountKeys, ...(ak.accountKeysFromLookups?.writable ?? []), ...(ak.accountKeysFromLookups?.readonly ?? [])];
      } else keys = msg.staticAccountKeys;
      writableFlags = keys.map((_, i) => msg.isAccountWritable(i));
    } catch (e) {
      return refuse(`cannot resolve account keys: ${(e as Error).message}`);
    }
    const progs = this.programIds;
    const keyStrs = keys.map((x) => x.toBase58());
    const invoked = new Set(msg.compiledInstructions.map((ix) => keyStrs[ix.programIdIndex]));
    const accounts: Record<string, { lamports: string; owner: string; data: Buffer; executable: boolean } | null> = {};
    const missing: string[] = [];
    const writable: string[] = [];
    let n = 0;
    const altKeys = lookups.map((l) => l.accountKey.toBase58());
    const all = [...keyStrs, ...altKeys];
    for (let i0 = 0; i0 < all.length; i0++) {
      const k = all[i0];
      n++;
      if (progs.has(k) || BUILTINS.has(k)) continue;
      if (PROVIDED_SYSVARS.has(k)) continue;
      const i = i0 < keyStrs.length ? i0 : keyStrs.indexOf(k);
      if (i >= 0 && writableFlags[i]) writable.push(k);
      let a = req.snapshot.get(k);
      if (a === undefined && this.statics.has(k)) a = this.statics.get(k)!;
      if (a === undefined) { missing.push(`${k}${i >= 0 && writableFlags[i] ? " (writable)" : ""}`); continue; }
      if (a?.executable) { missing.push(`${k} (executable account that is not a loaded program)`); continue; }
      const prev = this.sent.get(k);
      const same = prev === undefined ? false : prev === null ? a === null : a !== null && prev.lamports === a.lamports && prev.owner === a.owner.toBase58() && prev.executable === a.executable && prev.data.equals(a.data);
      if (!same) {
        accounts[k] = a === null ? null : { lamports: String(a.lamports), owner: a.owner.toBase58(), data: a.data, executable: a.executable };
      }
    }
    for (const p of invoked) if (p && !progs.has(p) && !BUILTINS.has(p)) missing.push(`${p} (program not loaded)`);
    const clockInfo = req.snapshot.get(SYSVAR_CLOCK);
    const checks: LocalSimChecks = { signers, signersOk, blockhashAgeMs: bhAge, blockhashOk, accounts: n, programs: [...invoked].filter(Boolean) as string[], missing, writable };
    if (missing.length) {
      (req.onMissing ?? this.onMissing)?.(missing.filter((m) => !/program not loaded|executable/.test(m)).map((m) => m.split(" ")[0]));
      return refuse(`accounts not in snapshot: ${missing.join(", ")}`, checks);
    }
    if (!clockInfo) return refuse("Clock sysvar not in snapshot", checks);
    if (!signersOk) return refuse(`required signers ${JSON.stringify(signers)} (readonly signed ${h.numReadonlySignedAccounts}) are not exactly the user ${req.user.toBase58()}`, checks);
    if (!blockhashOk) return refuse(`blockhash ${msg.recentBlockhash} is not the cached one or older than ${this.o.maxBlockhashAgeMs} ms (age ${bhAge} ms)`, checks);
    const c = clockInfo.data;
    const clock = { slot: String(req.snapshot.slot), epochStartTimestamp: c.readBigInt64LE(8).toString(), epoch: c.readBigUInt64LE(16).toString(), leaderScheduleEpoch: c.readBigUInt64LE(24).toString(), unixTimestamp: c.readBigInt64LE(32).toString() };
    checks.clockSlot = c.readBigUInt64LE(0).toString();
    checks.unixTimestamp = clock.unixTimestamp;
    const w = this.worker!;
    const wsol = req.wsolAta.toBase58(), tok = req.tokenAta.toBase58();
    let r: WorkerReply;
    try {
      r = await w.request({ op: "sim", tx: req.tx.serialize(), accounts, clock, watch: [wsol, tok] }, this.o.timeoutMs);
    } catch (e) {
      return refuse(`worker: ${(e as Error).message}`, checks);
    }
    // the worker now holds exactly these accounts
    for (const [k, a] of Object.entries(accounts)) this.sent.set(k, a === null ? null : { lamports: Number(a.lamports), owner: a.owner, data: a.data, executable: a.executable });
    const timing = { workerSimUs: r.simUs as number, workerApplyUs: r.applyUs as number, sentAccounts: Object.keys(accounts).length, checks };
    const base: SimResult = { ok: false, slot: req.snapshot.slot, unitsConsumed: r.cu || undefined, logs: r.logs };
    if (!r.ok) {
      if (r.post === undefined || /worker exception|not set up/.test(String(r.err))) return refuse(String(r.err), checks);
      return done({ ...base, err: r.err, errCanon: r.err, execOk: false, reason: `sim error: ${r.err}`, ...timing });
    }
    if (!r.cu) return done({ ...base, execOk: false, reason: "sim returned no unitsConsumed", ...timing });
    const pw = r.post[wsol], pt = r.post[tok];
    if (!pw || !pt) return done({ ...base, execOk: false, reason: "sim did not return token account post-state", ...timing });
    const res = evaluateSimOutcome(base, r.cu, decodeTokenAmount(pw.data), decodeTokenAmount(pt.data), req.plan, req.params);
    return done({ ...res, execOk: true, ...timing });
  }
}

/**
 * LOCAL_SIM=shadow: the shared simulator (programs + features loaded, worker up, deploy-slot checks
 * every UPGRADE_CHECK_MS). undefined when LOCAL_SIM=off. Lookup tables are static accounts.
 */
export async function createLocalSim(cfg: { mode: string; localSim: { mode: string; timeoutMs: number; cacheDir: string }; risk: { upgradeCheckMs: number }; pairs: { lookupTables: string[] } }, conn: ChainConnection, log: (m: string) => void = console.log): Promise<LocalTxSimulator | undefined> {
  if (cfg.localSim.mode !== "shadow") return undefined;
  if (cfg.mode !== "simulate") throw new Error("LOCAL_SIM=shadow is simulation-only (MODE=simulate)");
  const sim = new LocalTxSimulator({ conn, cacheDir: cfg.localSim.cacheDir, timeoutMs: cfg.localSim.timeoutMs, checkIntervalMs: cfg.risk.upgradeCheckMs, log });
  await sim.init();
  if (cfg.pairs.lookupTables.length) await sim.addStatic(cfg.pairs.lookupTables);
  await sim.warm();
  log(`local-sim: shadow mode on (${sim.litesvm}; RPC simulation remains the gate; ledger rows "local_simulation")`);
  return sim;
}

// ---------------------------------------------------------------------------------------------
// live account set + snapshot capture


/**
 * StateSource added to the engine when LOCAL_SIM=shadow: (1) puts the extra accounts a full-tx
 * simulation needs into the live set (user wallet, DLMM reserves + oracle, event authorities, keys a
 * refused simulation reported missing), (2) captures the snapshot every source was fed this tick.
 */
export class LocalSimAccounts implements StateSource {
  slot = -1;
  private infos = new Map<string, AccountInfo<Buffer> | null>();
  readonly learned = new Map<string, PublicKey>();
  /** When the snapshot came from a store that distinguishes "not seeded" from "does not exist" (gRPC). */
  provider?: { lastSource?: string; store?: { has(k: string): boolean } };

  constructor(private venues: SwapVenue[], private user: PublicKey) {}

  accounts(): PublicKey[] {
    const out: PublicKey[] = [this.user];
    for (const v of this.venues as (SwapVenue & { dlmm?: { lbPair: { reserveX: PublicKey; reserveY: PublicKey; oracle: PublicKey } | null } })[]) {
      if (v.dlmm) {
        const lb = v.dlmm.lbPair;
        if (lb) out.push(lb.reserveX, lb.reserveY, lb.oracle);
        out.push(DLMM_EVENT_AUTHORITY);
      } else if (v.name.startsWith("pumpswap:")) out.push(PUMP_EVENT_AUTHORITY);
    }
    out.push(...this.learned.values());
    return out;
  }

  update(slot: number, infos: Map<string, AccountInfo<Buffer> | null>): void {
    this.slot = slot;
    this.infos = infos;
  }

  /** Keys reported missing by a refused simulation join the live set from the next refresh on. */
  learn(keys: string[]): void {
    for (const k of keys) { try { if (!this.learned.has(k)) this.learned.set(k, new PublicKey(k)); } catch { /* not a key */ } }
  }

  snapshot(): LocalSimSnapshot {
    const infos = this.infos;
    const p = this.provider;
    const store = p?.lastSource === "grpc" ? p.store : undefined;
    return {
      slot: this.slot,
      get: (k) => {
        if (!infos.has(k)) return undefined;
        const v = infos.get(k) ?? null;
        // gRPC snapshots read unseeded keys as null: only trust a null the store actually holds
        if (v === null && store && !store.has(k)) return undefined;
        return v;
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// comparison with the RPC simulation

/** Canonical form of an RPC TransactionError JSON (matches the worker's canonical()). */
export function canonicalRpcError(err: unknown): string | undefined {
  if (err === undefined || err === null) return undefined;
  if (typeof err === "string") return err;
  const e = err as Record<string, unknown>;
  if (Array.isArray(e.InstructionError)) {
    const [i, x] = e.InstructionError as [number, unknown];
    let s: string;
    if (typeof x === "string") s = x;
    else if (x && typeof x === "object" && "Custom" in x) s = `Custom(${(x as { Custom: number }).Custom})`;
    else if (x && typeof x === "object" && "BorshIoError" in x) s = "BorshIoError";
    else s = JSON.stringify(x);
    return `InstructionError(${i},${s})`;
  }
  if (e.InsufficientFundsForRent && typeof e.InsufficientFundsForRent === "object") return `InsufficientFundsForRent(${(e.InsufficientFundsForRent as { account_index: number }).account_index})`;
  if (e.DuplicateInstruction !== undefined) return `DuplicateInstruction(${e.DuplicateInstruction})`;
  return JSON.stringify(err);
}

export type AgreementClass = "agree-ok" | "agree-err" | "mismatch-delta" | "mismatch-outcome" | "mismatch-error" | "local-refused" | "rpc-not-run";

export interface Agreement {
  class: AgreementClass;
  agree: boolean | null;
  /** RPC context slot == snapshot slot (only then are both views of the same slot). */
  sameSlot: boolean | null;
  rpcSlotLag?: number;
  cuEqual?: boolean;
  /** Both verdicts (incl. floor / tolerance checks) equal. */
  verdictEqual?: boolean;
  details?: string;
}

/** RPC simulation ran (got a response) — vs never ran (rpc behind / rpc error). */
export const rpcRan = (r: SimResult) => r.slot !== undefined;
const rpcExecOk = (r: SimResult) => rpcRan(r) && !r.err && !!r.unitsConsumed && r.wsolDelta !== undefined;

export function compareSims(local: LocalSimResult, rpc: SimResult, snapshotSlot: number): Agreement {
  const sameSlot = rpcRan(rpc) ? rpc.slot === snapshotSlot : null;
  const rpcSlotLag = rpcRan(rpc) ? rpc.slot! - snapshotSlot : undefined;
  if (local.refused) return { class: "local-refused", agree: null, sameSlot, rpcSlotLag, details: local.refused };
  if (!rpcRan(rpc)) return { class: "rpc-not-run", agree: null, sameSlot, details: rpc.reason };
  const cuEqual = local.unitsConsumed !== undefined && rpc.unitsConsumed !== undefined ? local.unitsConsumed === rpc.unitsConsumed : undefined;
  const verdictEqual = local.ok === rpc.ok;
  const common = { sameSlot, rpcSlotLag, cuEqual, verdictEqual };
  const lOk = local.execOk, rOk = rpcExecOk(rpc);
  if (lOk && rOk) {
    if (local.wsolDelta === rpc.wsolDelta && local.riseDelta === rpc.riseDelta) return { class: "agree-ok", agree: true, ...common };
    return { class: "mismatch-delta", agree: false, ...common, details: `Δ wSOL local ${local.wsolDelta} rpc ${rpc.wsolDelta} (diff ${(rpc.wsolDelta ?? 0n) - (local.wsolDelta ?? 0n)}); Δ token local ${local.riseDelta} rpc ${rpc.riseDelta}` };
  }
  const le = local.errCanon ?? (lOk ? undefined : local.reason);
  const re = canonicalRpcError(rpc.err) ?? (rOk ? undefined : rpc.reason);
  if (!lOk && !rOk) {
    if (le === re) return { class: "agree-err", agree: true, ...common, details: le };
    return { class: "mismatch-error", agree: false, ...common, details: `local ${le} / rpc ${re}` };
  }
  return { class: "mismatch-outcome", agree: false, ...common, details: lOk ? `local ok (Δ wSOL ${local.wsolDelta}), rpc failed: ${re}` : `local failed: ${le}, rpc ok (Δ wSOL ${rpc.wsolDelta})` };
}

const accHash = (a: AccountInfo<Buffer> | null | undefined) => (a ? createHash("sha256").update(a.data).update(`${a.lamports}:${a.owner.toBase58()}`).digest("hex").slice(0, 16) : a === null ? "none" : "missing");

export type StateCheckConnection = Pick<Connection, "getMultipleAccountsInfoAndContext">;

/**
 * For a mismatch: read the tx's writable accounts again at >= the RPC simulation's context slot and
 * list the ones whose (data, lamports, owner) differ from our snapshot. Accounts that differ => the
 * state changed between our snapshot and the RPC's view (not a local-sim error, though the read can
 * be later than the sim). Nothing differs and the read is at the sim's slot => same state, different
 * result: a real disagreement to investigate. The exact in-slot ordering can be recovered afterwards
 * from the block (src/research/sim-diag.ts reads the blocks between snapshot and sim slot).
 */
export async function stateCheck(conn: StateCheckConnection, keys: string[], snap: LocalSimSnapshot, minSlot: number): Promise<{ slot: number; differ: string[]; checked: number; atSimSlot: boolean }> {
  const res = await conn.getMultipleAccountsInfoAndContext(keys.map((k) => new PublicKey(k)), { commitment: "processed", minContextSlot: minSlot });
  const differ = keys.filter((k, i) => accHash((res.value[i] as AccountInfo<Buffer> | null) ?? null) !== accHash(snap.get(k)));
  return { slot: res.context.slot, differ, checked: keys.length, atSimSlot: res.context.slot === minSlot };
}

// ---------------------------------------------------------------------------------------------
// shadow orchestration (engine side)

export interface LocalRun {
  promise: Promise<{ r: LocalSimResult; doneAt: number }>;
  startedAt: number;
  snapshot: LocalSimSnapshot;
}

export interface ShadowMeta {
  pair: string;
  route: string;
  direction: string;
  stage: "pre" | "final";
  forced: boolean;
  snapshotSlot: number;
  /** performance.now() at which the snapshot's newest data arrived. */
  dataAt?: number;
  rpcStartedAt: number;
  rpcDoneAt: number;
}

const r2 = (x: number | undefined) => (x === undefined ? undefined : Math.round(x * 100) / 100);

function simSummary(s: SimResult & Partial<LocalSimResult>, execOk: boolean) {
  return {
    ok: s.ok, execOk, err: s.errCanon ?? canonicalRpcError(s.err), reason: s.reason, wsolDelta: s.wsolDelta, tokenDelta: s.riseDelta, profit: s.simulatedProfit, fee: s.fee, cu: s.unitsConsumed,
    // logs only for an execution failure (a tx that ran fine but missed the floor needs none)
    logsTail: execOk ? undefined : s.logs?.filter((l) => !l.startsWith("Program data:")).slice(-4),
  };
}

/**
 * LOCAL_SIM=shadow: run the local simulation of the exact tx + snapshot concurrently with (and
 * started just before) the unchanged RPC simulation; the RPC result stays the gate. One
 * `local_simulation` ledger row per comparison.
 */
export class LocalSimShadow {
  /** State checks queued or running (serialized, at most MAX_CHECKS: bounded extra RPC load). */
  private checks = 0;
  private checkChain: Promise<unknown> = Promise.resolve();
  static readonly MAX_CHECKS = 4;
  stats = { n: 0, agree: 0, mismatch: 0, refused: 0, rpcNotRun: 0 };
  constructor(readonly sim: LocalTxSimulator, private ledger: Ledger, private o: { stateConn?: StateCheckConnection; stateCheck?: boolean; log?: (m: string) => void } = {}) {}

  start(req: LocalSimRequest): LocalRun {
    const startedAt = performance.now();
    const promise = this.sim.simulate(req).catch((e): LocalSimResult => ({ ok: false, execOk: false, refused: `exception: ${(e as Error).message}`, ms: performance.now() - startedAt })).then((r) => ({ r, doneAt: performance.now() }));
    return { promise, startedAt, snapshot: req.snapshot };
  }

  /** Never throws. Resolves once the row is written (after the optional state check). */
  async finish(run: LocalRun, rpc: SimResult, meta: ShadowMeta): Promise<{ local: LocalSimResult; agreement: Agreement } | null> {
    try {
      const { r: local, doneAt } = await run.promise;
      const agreement = compareSims(local, rpc, meta.snapshotSlot);
      this.stats.n++;
      if (agreement.class === "local-refused") this.stats.refused++;
      else if (agreement.class === "rpc-not-run") this.stats.rpcNotRun++;
      else if (agreement.agree) this.stats.agree++;
      else this.stats.mismatch++;
      const d0 = meta.dataAt;
      const rpcWait = rpc.rpcBehindMs ?? 0;
      const row: Record<string, unknown> = {
        pair: meta.pair, route: meta.route, direction: meta.direction, stage: meta.stage, forced: meta.forced, snapshotSlot: meta.snapshotSlot,
        local: { ...simSummary(local, local.execOk), refused: local.refused, ms: r2(local.ms), workerSimMs: r2(local.workerSimUs !== undefined ? local.workerSimUs / 1000 : undefined), sentAccounts: local.sentAccounts, checks: local.checks ? { signers: local.checks.signers, signersOk: local.checks.signersOk, blockhashAgeMs: r2(local.checks.blockhashAgeMs), accounts: local.checks.accounts, clockSlot: local.checks.clockSlot, unixTimestamp: local.checks.unixTimestamp, missing: local.checks.missing.length ? local.checks.missing : undefined } : undefined },
        rpc: { ...simSummary(rpc, rpcExecOk(rpc)), ran: rpcRan(rpc), slot: rpc.slot, waitMs: rpcWait, retries: (rpc.rpcBehindRetries ?? 0) + (rpc.rpcErrorRetries ?? 0), ms: r2(meta.rpcDoneAt - meta.rpcStartedAt) },
        agreement,
        timing: {
          localMs: r2(doneAt - run.startedAt), rpcMs: r2(meta.rpcDoneAt - meta.rpcStartedAt),
          dataToLocalMs: d0 !== undefined ? r2(doneAt - d0) : undefined, dataToRpcMs: d0 !== undefined ? r2(meta.rpcDoneAt - d0) : undefined,
          // how long starting the local sim delayed the RPC request (synchronous part: snapshot, payload, IPC send)
          localStartLeadMs: r2(meta.rpcStartedAt - run.startedAt),
        },
      };
      if (agreement.agree === false && this.o.stateCheck !== false && this.o.stateConn && this.checks < LocalSimShadow.MAX_CHECKS && rpc.slot !== undefined && local.checks?.writable.length) {
        this.checks++;
        const conn = this.o.stateConn, keys = local.checks.writable, slot = rpc.slot;
        const p = this.checkChain.then(async () => {
          const t = Date.now();
          try {
            const sc = await stateCheck(conn, keys, run.snapshot, slot);
            row.stateCheck = { ...sc, verdict: sc.differ.length ? "state-changed" : sc.atSimSlot ? "same-state" : "same-state-later-read", ms: Date.now() - t };
          } catch (e) {
            row.stateCheck = { error: String((e as Error).message).replace(/https?:\/\/\S+/g, "<url>").slice(0, 160) };
          } finally { this.checks--; }
        });
        this.checkChain = p;
        await p;
      } else if (agreement.agree === false) row.stateCheck = { skipped: true };
      this.ledger.append("local_simulation", row);
      if (agreement.agree === false) this.o.log?.(`[local-sim] MISMATCH ${meta.route} ${meta.direction} ${meta.stage} slot ${meta.snapshotSlot} (rpc slot ${rpc.slot}): ${agreement.class}: ${agreement.details}`);
      return { local, agreement };
    } catch (e) {
      this.o.log?.(`[local-sim] shadow comparison failed: ${(e as Error).message}`);
      return null;
    }
  }
}
