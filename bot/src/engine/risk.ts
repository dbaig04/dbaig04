// Hard risk limits and halts. Nothing here can enable live trading; it only
// refuses. RiskGuard is consulted before a tx is built and again before it is
// submitted, and is told the final outcome of every submission.
//
//  - spending limits: max input, max priority fee, max tip, priority+tip <= 10% of
//    expected profit before execution costs (lamportsOut − lamportsIn), min expected
//    net profit after base + priority + tip
//  - daily limits (persisted in a state file, keyed by UTC day): execution costs
//    (fee + tip of landed txs, success or failure) and realized loss
//  - consecutive failures (persisted until cleared with `estop.ts clear-failures`)
//  - stale state (slot lag vs newest slot seen, snapshot age, provider-reported staleness)
//  - program upgrade of RISE or Meteora DLMM (latched until restart)
//  - duplicate-submission protection and exactly one tx in flight
//  - emergency stop: kill file (checked every tick), SIGUSR1, `npx tsx src/engine/estop.ts`
//    Once tripped it stays tripped for the life of the process; the kill file keeps it
//    tripped across restarts until removed.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import type { RiskConfig } from "../config.js";
import { DLMM_PROGRAM_ID, RISE_PROGRAM_ID, type Direction } from "../types.js";
import { droppedOutcome, reconcileOutcome, unrealizedLandedOutcome, type Ledger, type Realized } from "./ledger.js";
import { resolveSignature, type StatusConnection } from "./sender.js";

export const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** u32 tag (3 = ProgramData) | u64 deploy slot | Option<Pubkey> upgrade authority */
export const PROGRAMDATA_HEADER = 45;

export function programDataAddress(programId: PublicKey | string): PublicKey {
  return PublicKey.findProgramAddressSync([new PublicKey(programId).toBuffer()], BPF_UPGRADEABLE_LOADER)[0];
}

export type HaltReason =
  | "estop-file"
  | "estop-signal"
  | "program-upgrade"
  | "daily-exec-cost"
  | "daily-loss"
  | "consecutive-failures";

/** Daily halts lift by themselves at the next UTC day; all others need operator action. */
export const DAILY_HALTS: ReadonlySet<HaltReason> = new Set(["daily-exec-cost", "daily-loss"]);

export interface Halt {
  reason: HaltReason;
  detail: string;
  at: string;
}

export interface InFlightRecord {
  signature: string;
  messageHash: string;
  oppKey: string;
  slot: number;
  lastValidBlockHeight: number;
  feeLamports: string;
  tipLamports: string;
  delivery: string;
  startedAt: string;
  /**
   * Which accounts this tx trades through (written at claim time), so an orphan left by a crash is
   * realized against the right pair's wSOL / token accounts. Absent in records written by older
   * versions (then the caller falls back to its default accounts).
   */
  account?: InFlightAccount;
}

export interface InFlightAccount {
  /** "rise" or the pair name (e.g. "max"). */
  pair: string;
  user: string;
  wsolAta: string;
  tokenAta: string;
  tokenMint?: string;
}

export interface RiskState {
  version: 1;
  /** UTC day (YYYY-MM-DD) the daily counters belong to. */
  day: string;
  /** Σ (fee + tip) of landed txs today (success or failure). */
  dailyExecCostLamports: string;
  /** Σ realized SOL net today (wSOL Δ + native Δ; costs included, RISE residue excluded). */
  dailyRealizedLamports: string;
  dailyTxs: number;
  consecutiveFailures: number;
  /** A submission whose final status was not recorded (crash): resolved at startup before trading. */
  inFlight: InFlightRecord | null;
  /** Last signatures / message hashes submitted (duplicate protection across restarts). */
  recentSignatures: string[];
  recentMessages: string[];
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function emptyState(day: string): RiskState {
  return { version: 1, day, dailyExecCostLamports: "0", dailyRealizedLamports: "0", dailyTxs: 0, consecutiveFailures: 0, inFlight: null, recentSignatures: [], recentMessages: [] };
}

export interface RiskGuardOptions {
  /** Persist state to limits.statePath (default true). Tests may pass false. */
  persist?: boolean;
  /** Wall clock (ms since epoch) for the UTC day. */
  now?: () => number;
  log?: (m: string) => void;
  /** Called once per new halt (wire to ledger "halt" rows). */
  onHalt?: (h: Halt) => void;
  /** Rejections (non-halting) — wire to ledger "risk" rows. */
  onReject?: (stage: string, reasons: string[], ctx: Record<string, unknown>) => void;
}

export interface Freshness {
  /** Slot of the snapshot the plan was made on. */
  snapshotSlot: number;
  /** performance.now() when the newest data in the snapshot was received. */
  snapshotReceivedAt: number;
  /** performance.now() now. */
  nowPerf: number;
  /** The provider itself says its data is stale. */
  providerStale?: boolean;
}

export interface TradeCheck {
  direction: Direction;
  /** GROSS lamports leg 1 may pull from the wallet (plan.grossIn: buyThenRedeem = DLMM max-in, before the host-fee rebate). */
  lamportsIn: bigint;
  /** Expected profit before all execution costs: lamportsOut − lamportsIn (same "gross" as fees.ts chooseExecutionFees). */
  expectedGrossProfit: bigint;
  baseFeeLamports: bigint;
  priorityFeeLamports: bigint;
  tipLamports: bigint;
}

export interface SubmissionKey {
  signature: string;
  messageHash: string;
  oppKey: string;
  slot: number;
}

export interface OutcomeForRisk {
  signature: string;
  landed: boolean;
  success: boolean;
  /** Actual fee charged (0 if not landed). */
  feeLamports: bigint;
  /** Actual tip paid (0 if not landed or reverted). */
  tipLamports: bigint;
  /** Realized SOL net: wSOL Δ + native Δ. */
  netLamports: bigint;
}

/** Same direction, size and snapshot slot => same opportunity. */
export function opportunityKey(p: { direction: Direction; lamportsIn: bigint; rise: bigint; slot: number }): string {
  return `${p.direction}:${p.lamportsIn}:${p.rise}@${p.slot}`;
}

const RECENT = 64;

export class RiskGuard {
  private state: RiskState;
  private latched: Halt | null = null;
  private halts = new Set<string>();
  private latestSlot = -1;
  private lastFailed: { oppKey: string; slot: number } | null = null;
  private inFlightKey: SubmissionKey | null = null;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(readonly limits: RiskConfig, private o: RiskGuardOptions = {}) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(m));
    this.state = this.load();
    this.rollover();
  }

  // ---------------- persistence ----------------

  private get persist(): boolean {
    return this.o.persist !== false;
  }

  private load(): RiskState {
    const day = utcDay(this.now());
    if (!this.persist || !existsSync(this.limits.statePath)) return emptyState(day);
    const raw = JSON.parse(readFileSync(this.limits.statePath, "utf8")) as Partial<RiskState>;
    if (raw.version !== 1) throw new Error(`${this.limits.statePath}: unknown risk state version`);
    return { ...emptyState(raw.day ?? day), ...raw } as RiskState;
  }

  private save(): void {
    if (!this.persist) return;
    mkdirSync(dirname(this.limits.statePath), { recursive: true });
    const tmp = `${this.limits.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    renameSync(tmp, this.limits.statePath);
  }

  private rollover(): void {
    const day = utcDay(this.now());
    if (this.state.day === day) return;
    this.log(`risk: new UTC day ${day} (previous ${this.state.day}: exec cost ${this.state.dailyExecCostLamports}, realized ${this.state.dailyRealizedLamports})`);
    this.state = { ...this.state, day, dailyExecCostLamports: "0", dailyRealizedLamports: "0", dailyTxs: 0 };
    for (const r of DAILY_HALTS) this.halts.delete(r);
    this.save();
  }

  /** Copy of the persisted state (for status / reports). */
  snapshot(): RiskState {
    this.rollover();
    return structuredClone(this.state);
  }

  get dailyExecCost(): bigint { return BigInt(this.state.dailyExecCostLamports); }
  get dailyRealized(): bigint { return BigInt(this.state.dailyRealizedLamports); }
  get consecutiveFailures(): number { return this.state.consecutiveFailures; }
  /** A submission recorded as started but never resolved (crash). */
  get orphanInFlight(): InFlightRecord | null { return this.state.inFlight; }
  get inFlight(): boolean { return this.inFlightKey !== null; }

  // ---------------- halts ----------------

  private announce(h: Halt): void {
    const k = `${h.reason}`;
    if (this.halts.has(k)) return;
    this.halts.add(k);
    this.log(`RISK HALT [${h.reason}] ${h.detail}`);
    this.o.onHalt?.(h);
  }

  /** Latch a halt for the rest of the process (e-stop, upgrade). */
  trip(reason: HaltReason, detail: string): Halt {
    const h: Halt = { reason, detail, at: new Date(this.now()).toISOString() };
    if (!this.latched) this.latched = h;
    this.announce(h);
    return this.latched;
  }

  /**
   * Current halt, or null if trading may proceed. Checks the kill file every call
   * (= every tick) and rolls the UTC day.
   */
  halt(): Halt | null {
    this.rollover();
    if (!this.latched && existsSync(this.limits.killFile)) {
      let why = "";
      try { why = readFileSync(this.limits.killFile, "utf8").trim().slice(0, 200); } catch { /* ignore */ }
      this.trip("estop-file", `kill file ${this.limits.killFile} present${why ? `: ${why}` : ""}`);
    }
    if (this.latched) return this.latched;
    const L = this.limits;
    const at = new Date(this.now()).toISOString();
    if (this.state.consecutiveFailures >= L.maxConsecutiveFailures) {
      const h: Halt = { reason: "consecutive-failures", detail: `${this.state.consecutiveFailures} consecutive failed txs (limit ${L.maxConsecutiveFailures}); clear with: npx tsx src/engine/estop.ts clear-failures`, at };
      this.announce(h);
      return h;
    }
    if (this.dailyExecCost >= L.maxDailyExecCostLamports) {
      const h: Halt = { reason: "daily-exec-cost", detail: `daily execution cost ${this.dailyExecCost} >= ${L.maxDailyExecCostLamports} lamports (UTC ${this.state.day})`, at };
      this.announce(h);
      return h;
    }
    if (this.dailyRealized <= -L.maxDailyLossLamports) {
      const h: Halt = { reason: "daily-loss", detail: `daily realized ${this.dailyRealized} <= -${L.maxDailyLossLamports} lamports (UTC ${this.state.day})`, at };
      this.announce(h);
      return h;
    }
    return null;
  }

  /** Emergency stop from a signal: latch now and write the kill file so a restart stays stopped. */
  emergencyStop(source: string): Halt {
    try {
      mkdirSync(dirname(this.limits.killFile), { recursive: true });
      if (!existsSync(this.limits.killFile)) writeFileSync(this.limits.killFile, `${source} at ${new Date(this.now()).toISOString()}\n`);
    } catch (e) {
      this.log(`could not write kill file: ${(e as Error).message}`);
    }
    return this.trip("estop-signal", `${source}; kill file ${this.limits.killFile} written (remove it and restart to resume)`);
  }

  // ---------------- per-trade checks ----------------

  /** Record the newest slot seen anywhere (state feed, sim context, statuses). */
  noteSlot(slot: number | undefined): void {
    if (slot !== undefined && slot > this.latestSlot) this.latestSlot = slot;
  }

  get newestSlot(): number { return this.latestSlot; }

  /** Reasons the snapshot is too stale to build/send on (empty = fresh). */
  checkFreshness(f: Freshness): string[] {
    this.noteSlot(f.snapshotSlot);
    const r: string[] = [];
    if (f.providerStale) r.push("state provider reports stale data");
    const lag = this.latestSlot - f.snapshotSlot;
    if (lag > this.limits.maxStaleSlots) r.push(`snapshot slot ${f.snapshotSlot} is ${lag} slots behind newest seen ${this.latestSlot} (max ${this.limits.maxStaleSlots})`);
    const age = f.nowPerf - f.snapshotReceivedAt;
    if (age > this.limits.maxStaleMs) r.push(`snapshot data is ${Math.round(age)} ms old (max ${this.limits.maxStaleMs})`);
    return r;
  }

  /** Spending-limit reasons (empty = within limits). */
  checkTrade(t: TradeCheck): string[] {
    const L = this.limits;
    const r: string[] = [];
    if (t.lamportsIn > L.maxInputLamports) r.push(`input ${t.lamportsIn} > max ${L.maxInputLamports}`);
    if (t.priorityFeeLamports > L.maxPriorityFeeLamports) r.push(`priority fee ${t.priorityFeeLamports} > max ${L.maxPriorityFeeLamports}`);
    if (t.tipLamports > L.maxTipLamports) r.push(`tip ${t.tipLamports} > max ${L.maxTipLamports}`);
    const exec = t.priorityFeeLamports + t.tipLamports;
    if (t.expectedGrossProfit <= 0n || exec * 10_000n > t.expectedGrossProfit * L.maxExecCostBpsOfProfit)
      r.push(`priority+tip ${exec} > ${L.maxExecCostBpsOfProfit} bps of expected profit ${t.expectedGrossProfit}`);
    const net = t.expectedGrossProfit - t.baseFeeLamports - exec;
    if (net < L.minNetProfitLamports) r.push(`expected net ${net} after base+priority+tip < min ${L.minNetProfitLamports}`);
    // a single landed tx must not be able to push the day past the cost limit by more than its own cost
    if (this.dailyExecCost + t.baseFeeLamports + exec > L.maxDailyExecCostLamports) r.push(`daily execution cost ${this.dailyExecCost} + ${t.baseFeeLamports + exec} would exceed ${L.maxDailyExecCostLamports}`);
    return r;
  }

  /** Duplicate-submission reasons (empty = OK). */
  checkDuplicate(k: SubmissionKey): string[] {
    const r: string[] = [];
    if (this.state.recentSignatures.includes(k.signature)) r.push(`signature ${k.signature.slice(0, 16)}… already submitted`);
    if (this.state.recentMessages.includes(k.messageHash)) r.push(`message ${k.messageHash.slice(0, 16)}… already submitted`);
    if (this.inFlightKey && this.inFlightKey.oppKey === k.oppKey) r.push(`identical opportunity ${k.oppKey} is in flight`);
    if (this.lastFailed && this.lastFailed.oppKey === k.oppKey && this.lastFailed.slot === k.slot) r.push(`identical opportunity ${k.oppKey} just failed in slot ${k.slot}`);
    return r;
  }

  /**
   * Claim the single in-flight slot. Throws if another tx is in flight, a halt is
   * active, or the submission is a duplicate. Persisted so a crash mid-flight is
   * resolved at the next startup before any new submission.
   */
  beginSubmission(k: SubmissionKey, meta: { lastValidBlockHeight: number; feeLamports: bigint; tipLamports: bigint; delivery: string; account?: InFlightAccount }): void {
    if (this.inFlightKey || this.state.inFlight) throw new Error(`risk: a tx is already in flight (${(this.inFlightKey?.signature ?? this.state.inFlight?.signature ?? "").slice(0, 16)}…)`);
    const h = this.halt();
    if (h) throw new Error(`risk: halted (${h.reason}): ${h.detail}`);
    const dup = this.checkDuplicate(k);
    if (dup.length) throw new Error(`risk: duplicate submission refused: ${dup.join("; ")}`);
    this.inFlightKey = k;
    this.state.inFlight = {
      signature: k.signature, messageHash: k.messageHash, oppKey: k.oppKey, slot: k.slot,
      lastValidBlockHeight: meta.lastValidBlockHeight, feeLamports: meta.feeLamports.toString(), tipLamports: meta.tipLamports.toString(),
      delivery: meta.delivery, startedAt: new Date(this.now()).toISOString(),
      ...(meta.account ? { account: meta.account } : {}),
    };
    this.state.recentSignatures = [...this.state.recentSignatures, k.signature].slice(-RECENT);
    this.state.recentMessages = [...this.state.recentMessages, k.messageHash].slice(-RECENT);
    this.save();
  }

  /**
   * Record the final status of the in-flight tx (or of an orphan from a previous
   * run) and release the in-flight slot. Updates daily costs/PnL and the failure streak.
   */
  recordOutcome(o: OutcomeForRisk): Halt | null {
    this.rollover();
    const cur = this.inFlightKey ?? (this.state.inFlight ? { ...this.state.inFlight } : null);
    if (cur && cur.signature !== o.signature) throw new Error(`risk: outcome for ${o.signature} but ${cur.signature} is in flight`);
    if (o.landed) {
      this.state.dailyExecCostLamports = (this.dailyExecCost + o.feeLamports + o.tipLamports).toString();
      this.state.dailyRealizedLamports = (this.dailyRealized + o.netLamports).toString();
      this.state.dailyTxs++;
    }
    const failed = o.landed ? !o.success : this.limits.expiredCountsAsFailure;
    if (o.landed && o.success) this.state.consecutiveFailures = 0;
    else if (failed) this.state.consecutiveFailures++;
    if (!(o.landed && o.success) && cur) this.lastFailed = { oppKey: cur.oppKey, slot: cur.slot };
    this.state.inFlight = null;
    this.inFlightKey = null;
    this.save();
    return this.halt();
  }

  /**
   * Release the in-flight slot for a submission that was refused before anything was
   * broadcast (GuardedSender refusal). Not counted as an outcome; the signature and
   * message stay in the duplicate lists so it is never submitted.
   */
  abortSubmission(signature: string, why: string): void {
    const cur = this.inFlightKey ?? this.state.inFlight;
    if (!cur || cur.signature !== signature) return;
    this.log(`risk: submission ${signature.slice(0, 16)}… aborted before broadcast: ${why}`);
    this.state.inFlight = null;
    this.inFlightKey = null;
    this.save();
  }

  /** Operator action (estop.ts clear-failures, with the bot stopped). */
  clearFailures(): void {
    this.state.consecutiveFailures = 0;
    this.save();
  }
}

// ---------------- program-upgrade guard ----------------

export interface WatchedProgram {
  name: string;
  programId: string;
  programData: PublicKey;
}

export const WATCHED_PROGRAMS: WatchedProgram[] = [
  { name: "RISE", programId: RISE_PROGRAM_ID, programData: programDataAddress(RISE_PROGRAM_ID) },
  { name: "Meteora DLMM", programId: DLMM_PROGRAM_ID, programData: programDataAddress(DLMM_PROGRAM_ID) },
];

export type ProgramDataConnection = Pick<Connection, "getMultipleAccountsInfo">;

/**
 * Upgrade-guard entries for extra programs (e.g. the pair venues' programIds(): PumpSwap). Only
 * programs owned by the upgradeable loader have programdata to watch; others (native / immutable
 * loaders) are returned in `immutable`. Programs already in `existing` are skipped.
 */
export async function watchedProgramsFor(conn: ProgramDataConnection, programs: { name: string; programId: string }[], existing: WatchedProgram[] = []): Promise<{ watch: WatchedProgram[]; immutable: string[] }> {
  const seen = new Set(existing.map((p) => p.programId));
  const todo = programs.filter((p, i) => !seen.has(p.programId) && programs.findIndex((q) => q.programId === p.programId) === i);
  if (!todo.length) return { watch: [], immutable: [] };
  const infos = await conn.getMultipleAccountsInfo(todo.map((p) => new PublicKey(p.programId)), { commitment: "confirmed", dataSlice: { offset: 0, length: 0 } });
  const watch: WatchedProgram[] = [];
  const immutable: string[] = [];
  todo.forEach((p, i) => {
    const info = infos[i];
    if (info && info.owner.equals(BPF_UPGRADEABLE_LOADER)) watch.push({ name: p.name, programId: p.programId, programData: programDataAddress(p.programId) });
    else immutable.push(`${p.name} (${p.programId}): ${info ? `owner ${info.owner.toBase58()}` : "missing"}`);
  });
  return { watch, immutable };
}

export function parseProgramDataHeader(info: AccountInfo<Buffer> | null): { deploySlot: bigint; authority: string | null } | null {
  if (!info || info.data.length < 13 || info.data.readUInt32LE(0) !== 3) return null;
  const hasAuth = info.data[12] === 1 && info.data.length >= PROGRAMDATA_HEADER;
  return { deploySlot: info.data.readBigUInt64LE(4), authority: hasAuth ? new PublicKey(info.data.subarray(13, 45)).toBase58() : null };
}

/**
 * Polls the 45-byte programdata header (deploy slot + authority) of the RISE and
 * DLMM programs every `intervalMs` and latches a "program-upgrade" halt on any
 * change. Only a restart (new baseline) clears it.
 */
export class ProgramUpgradeGuard {
  readonly baseline = new Map<string, { deploySlot: bigint; authority: string | null }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  lastCheckAt = 0;

  constructor(
    private conn: ProgramDataConnection,
    private risk: RiskGuard,
    private programs: WatchedProgram[] = WATCHED_PROGRAMS,
    private o: { intervalMs?: number; log?: (m: string) => void } = {},
  ) {}

  private async read(): Promise<(ReturnType<typeof parseProgramDataHeader>)[]> {
    const infos = await this.conn.getMultipleAccountsInfo(this.programs.map((p) => p.programData), { commitment: "confirmed", dataSlice: { offset: 0, length: PROGRAMDATA_HEADER } });
    return infos.map((i) => parseProgramDataHeader(i as AccountInfo<Buffer> | null));
  }

  /** Read the baseline. Throws if a programdata account is missing/unparseable. */
  async init(): Promise<Record<string, string>> {
    const hs = await this.read();
    const out: Record<string, string> = {};
    this.programs.forEach((p, i) => {
      const h = hs[i];
      if (!h) throw new Error(`${p.name} programdata ${p.programData.toBase58()} not found or not a ProgramData account`);
      this.baseline.set(p.programId, h);
      out[p.name] = `programdata=${p.programData.toBase58()} deploySlot=${h.deploySlot} authority=${h.authority ?? "none"}`;
    });
    this.lastCheckAt = Date.now();
    return out;
  }

  /** One check; returns the change description (and trips the halt) or null. */
  async check(): Promise<string | null> {
    this.lastCheckAt = Date.now();
    const hs = await this.read();
    for (const [i, p] of this.programs.entries()) {
      const b = this.baseline.get(p.programId);
      const h = hs[i];
      if (!b) continue;
      if (!h) {
        const d = `${p.name} programdata ${p.programData.toBase58()} disappeared / unreadable (closed?)`;
        this.risk.trip("program-upgrade", d);
        return d;
      }
      if (h.deploySlot !== b.deploySlot || h.authority !== b.authority) {
        const d = `${p.name} program changed: deploy slot ${b.deploySlot} -> ${h.deploySlot}, authority ${b.authority ?? "none"} -> ${h.authority ?? "none"}; trading halted until restart`;
        this.risk.trip("program-upgrade", d);
        return d;
      }
    }
    return null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.check().catch((e) => this.o.log?.(`program upgrade check failed: ${(e as Error).message}`));
    }, this.o.intervalMs ?? 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ---------------- crash recovery: resolve an unrecorded in-flight tx ----------------

/**
 * A submission was started but its outcome never recorded (crash / kill). Resolve
 * its final status (signature status until confirmed / failed / blockhash expiry),
 * fetch the landed tx, record it, and only then allow new submissions.
 */
export async function resolveOrphanInFlight(d: {
  risk: RiskGuard;
  conn: StatusConnection;
  ledger: Ledger;
  /** Realize the orphan; receives the in-flight record so it can use the record's own accounts. */
  realize: (signature: string, rec: InFlightRecord) => Promise<Realized>;
  baseFeeLamports: bigint;
  /** Fallback user for records without `account`. */
  user: string;
  log?: (m: string) => void;
  resolve?: typeof resolveSignature;
}): Promise<Realized | null> {
  const o = d.risk.orphanInFlight;
  if (!o) return null;
  d.log?.(`risk: resolving unrecorded in-flight tx ${o.signature} (started ${o.startedAt}, lastValidBlockHeight ${o.lastValidBlockHeight})`);
  const res = await (d.resolve ?? resolveSignature)(d.conn, o.signature, o.lastValidBlockHeight, { log: d.log });
  let out: Realized;
  try { out = res.status === "expired" ? droppedOutcome(o.signature, "other") : await d.realize(o.signature, o); } catch { out = droppedOutcome(o.signature, "other"); }
  if (!out.landed && res.status !== "expired") out = unrealizedLandedOutcome(o.signature, "other", res.status, BigInt(o.feeLamports), BigInt(o.tipLamports));
  const rec = reconcileOutcome(out, { wsolDelta: out.wsolDelta, riseDelta: out.riseDelta, feeLamports: BigInt(o.feeLamports), baseFeeLamports: d.baseFeeLamports, tipLamports: BigInt(o.tipLamports) });
  d.risk.recordOutcome({ signature: o.signature, landed: out.landed, success: out.success, feeLamports: out.fee, tipLamports: rec.tipLamports, netLamports: out.netLamports });
  d.ledger.append("outcome", {
    ...out, user: o.account?.user ?? d.user, ...(o.account ? { pair: o.account.pair, tokenMint: o.account.tokenMint, tokenAta: o.account.tokenAta } : {}),
    orphan: true, delivery: o.delivery, sendStatus: res.status,
    exec: { base: rec.baseFeeLamports, priority: rec.priorityFeeLamports, tip: rec.tipLamports, total: rec.execCostLamports },
    tradingProfit: rec.tradingProfitLamports, failedCost: rec.failedCostLamports, residualRise: rec.residualRise,
  });
  return out;
}
