// Generic pair engine: one tick = refresh both venues' state (+ the user's wSOL and token
// accounts) -> two-stage sizing for both directions (pair-optimizer.ts) -> build (cached
// blockhash; CU learned from the last OK final sim, else a pre-sim) -> final simulation of the
// exact message (mandatory) -> risk gates -> [live] submit through GuardedSender -> realize.
// Strictly serialized like ArbEngine; shares RiskGuard (one tx in flight across engines),
// fees.ts policy, BlockhashCache, simulate.ts, ledger and sender plumbing with the RISE engine.
//
// Latency is measured per stage and handed to an optional per-tick observer (shadow.ts):
//   poll (state refresh RTT) | quote (optimizer) | build (tx build) | sim (RPC RTT) | total.
import type { AddressLookupTableAccount, Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { Config } from "../config.js";
import type { StateSource, SwapVenue } from "../types.js";
import { BlockhashCache } from "./blockhash.js";
import type { ExecFeePolicy } from "./fees.js";
import { StateManager, TokenBalances, type StateConnection, type StateProvider } from "./state.js";
import { LatencyStats, latencyRecord, type LatencyMarks } from "./latency.js";
import { cuFromSim, cuPriceFor, SIM_CU, txFee, type BuiltTx } from "./tx.js";
import { simulateArb, type SimConnection, type SimResult } from "./simulate.js";
import { GuardedSender, resolveSignature, signatureOf, SimRegistry, SubmitRefused, type Sender, type StatusConnection, type TxPreparer } from "./sender.js";
import { droppedOutcome, fetchRealized, reconcileOutcome, unrealizedLandedOutcome, type Ledger, type Realized } from "./ledger.js";
import { RiskGuard } from "./risk.js";
import { optimizePair, type PairDirection, type PairOptimizeResult, type PairPlan, type PairSearchOptions } from "./pair-optimizer.js";
import { buildPairTx, pairOpportunityKey, pairPlanRecord, type PairBuiltTx } from "./pair.js";
import type { PendingHint } from "./engine.js";

export type PairEngineConnection = StateConnection & SimConnection & Pick<Connection, "getLatestBlockhash">;

/** One route of a pair: venue A (e.g. the shared PumpSwap pool) vs venue B (one DLMM pool). */
export interface PairRoute {
  /** Route name used in plans / ledger rows, e.g. "max:H6Bcgd". */
  name: string;
  a: SwapVenue;
  b: SwapVenue;
}

export interface PairSpec {
  /** Short name used in config / ledger rows, e.g. "max". */
  name: string;
  /** Single-route form (used when `routes` is absent). */
  a: SwapVenue;
  b: SwapVenue;
  /**
   * Several routes for the same token (e.g. PumpSwap vs each of three DLMM pools). Venues shared
   * between routes (same object) are refreshed once per tick. Every route is evaluated each tick
   * and the single best plan across routes is taken.
   */
  routes?: PairRoute[];
  tokenMint: PublicKey;
  /** Token program of the mint (Token-2022 for MAX). */
  tokenProgram: PublicKey;
  /** Lookup tables used when the legacy message does not fit. */
  lookupTables?: AddressLookupTableAccount[];
}

/** Per-tick measurements handed to the observer (shadow run). Times in ms unless noted. */
export interface PairTickInfo {
  pair: string;
  status: PairTickStatus;
  trigger?: string;
  /** Wall clock at tick start / at decision. */
  wallStart: number;
  wallDecided?: number;
  /** Snapshot slot (all accounts at >= this slot). */
  slot: number;
  stateSource: string;
  /** State refresh (RPC poll RTT, or gRPC store read). */
  pollMs?: number;
  /** Optimizer time for both directions (µs) and round trips evaluated. */
  quoteUs?: number;
  screenEvals?: number;
  exactEvals?: number;
  cached?: boolean;
  /** Tx build (excl. simulation). */
  buildMs?: number;
  preSimMs?: number;
  finalSimMs?: number;
  /** data arrival -> decision / -> final sim returned. */
  dataToDecisionMs?: number;
  dataToSimulatedMs?: number;
  /** Best expected net per direction (even below floor), lamports — of the chosen/first route. */
  best?: Record<PairDirection, { grossIn: string; expectedProfit: string; skipped: boolean } | null>;
  /** Per-route optimizer view (multi-route pairs): quote time, cache hit, best per direction. */
  routes?: Record<string, { quoteUs: number; cached: boolean; screenEvals: number; exactEvals: number; best: Record<PairDirection, { grossIn: string; expectedProfit: string; skipped: boolean } | null>; feasible: boolean }>;
  /** Route of the plan (if any). */
  route?: string;
  plan?: ReturnType<typeof pairPlanRecord>;
  forced?: boolean;
  sim?: { ok: boolean; reason?: string; slot?: number; simulatedProfit?: string; expectedProfit?: string; unitsConsumed?: number; fee?: string };
  txVersion?: "legacy" | 0;
  txSize?: number;
  /** Shred hint that woke this tick, if any: the competitor tx and hint receipt -> tick start / -> decision. */
  hint?: { slot: number; signature: string; feePayer: string; kind: string; hintToTickMs: number; hintToDecisionMs?: number } | null;
}

export type PairTickStatus = "stale" | "no-balance" | "missing-prereq" | "no-opportunity" | "held" | "build-failed" | "sim-rejected" | "risk-rejected" | "halted" | "simulated" | "sent";

export interface PairTickResult {
  status: PairTickStatus;
  slot: number;
  plan?: PairPlan;
  sim?: SimResult;
  outcome?: Realized;
  opt?: PairOptimizeResult;
}

/** Pending-activity hint filtered by pair (src/feeds/shreds.ts PendingActivity). */
export interface PairPendingHint extends PendingHint {
  competingArb(slot: number, pair?: string): { slot: number; signature: string; feePayer: string; kind?: string } | null;
  summary?(slot: number, pair?: string): Record<string, number>;
  /** Most recent non-own hit for the pair (latency marker). */
  latest?(pair?: string): { slot: number; signature: string; feePayer: string; kind: string; receivedAt: number } | null;
}

export interface PairEngineDeps {
  conn: PairEngineConnection;
  pair: PairSpec;
  cfg: Config;
  ledger: Ledger;
  /** Wallet traded / simulated as (default cfg.user). */
  user?: PublicKey;
  sender?: Sender;
  realize?: (signature: string, plan: PairPlan) => Promise<Realized>;
  log?: (msg: string) => void;
  stateProvider?: (sources: StateSource[], polling: StateManager) => StateProvider;
  pending?: PairPendingHint;
  risk?: RiskGuard;
  preparer?: TxPreparer;
  blockhash?: BlockhashCache;
  /** Optimizer options (tests). */
  search?: PairSearchOptions;
  /** Simulate mode only: build + simulate the best plan at most every N ms even below the floor (latency measurement). 0 = off. */
  forceSimEveryMs?: number;
  /** Per-tick observer (shadow.ts). */
  onTick?: (info: PairTickInfo) => void;
}

/** Venue hook: user accounts that must already exist (e.g. PumpSwap's user_volume_accumulator). */
type PrereqVenue = SwapVenue & { requiredUserAccounts?(user: PublicKey): { account: PublicKey; why: string }[] };

/** Tracks existence of the venues' required user accounts in the same snapshot. */
export class UserPrereqs implements StateSource {
  readonly list: { account: PublicKey; why: string }[];
  missing: { account: PublicKey; why: string }[] = [];
  seen = false;
  constructor(venues: SwapVenue[], user: PublicKey) {
    const m = new Map<string, { account: PublicKey; why: string }>();
    for (const v of venues as PrereqVenue[]) for (const r of v.requiredUserAccounts?.(user) ?? []) m.set(r.account.toBase58(), r);
    this.list = [...m.values()];
  }
  accounts(): PublicKey[] { return this.list.map((r) => r.account); }
  update(_slot: number, infos: Map<string, import("@solana/web3.js").AccountInfo<Buffer> | null>): void {
    this.missing = this.list.filter((r) => !infos.get(r.account.toBase58()));
    this.seen = true;
  }
}

const fmt = (l: bigint) => (Number(l) / 1e9).toFixed(9);
const r1 = (x: number) => Math.round(x * 10) / 10;

export class PairEngine {
  readonly name: string;
  readonly state: StateProvider;
  readonly latency: LatencyStats;
  readonly balances: TokenBalances;
  readonly user: PublicKey;
  readonly wsolAta: PublicKey;
  readonly tokenAta: PublicKey;
  readonly risk: RiskGuard;
  readonly sims = new SimRegistry();
  readonly blockhash: BlockhashCache;
  sessionNetLamports = 0n;
  inFlight = false;
  private readonly sender?: Sender;
  private log: (m: string) => void;
  private cuLearned: Record<string, number> = {};
  private optCache = new Map<string, { key: string; res: PairOptimizeResult }>();
  readonly routes: PairRoute[];
  readonly prereqs: UserPrereqs;
  private prereqWarned = "";
  private lastForced = 0;

  constructor(private d: PairEngineDeps) {
    this.name = d.pair.name;
    this.user = d.user ?? d.cfg.user;
    this.wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, this.user, true, TOKEN_PROGRAM_ID);
    this.tokenAta = getAssociatedTokenAddressSync(d.pair.tokenMint, this.user, true, d.pair.tokenProgram);
    this.balances = new TokenBalances(this.wsolAta, this.tokenAta);
    this.routes = d.pair.routes?.length ? d.pair.routes : [{ name: d.pair.name, a: d.pair.a, b: d.pair.b }];
    this.prereqs = new UserPrereqs(this.allVenues(), this.user);
    const sources: StateSource[] = [...this.allVenues(), this.balances, this.prereqs];
    const polling = new StateManager(d.conn, sources, d.cfg.commitment);
    this.state = d.stateProvider ? d.stateProvider(sources, polling) : polling;
    this.latency = new LatencyStats(d.cfg.latencySummaryMs ?? 60_000);
    this.log = d.log ?? ((m) => console.log(m));
    if (d.cfg.mode === "live" && (!d.sender || !d.cfg.keypair)) throw new Error("live mode needs a sender and keypair");
    if (d.cfg.mode === "live" && d.cfg.keypair && !d.cfg.keypair.publicKey.equals(this.user)) throw new Error("live mode: pair user must be the keypair");
    this.risk = d.risk ?? new RiskGuard(d.cfg.risk, { persist: false, log: this.log });
    this.sender = d.sender ? new GuardedSender(d.sender, { mode: d.cfg.mode, sims: this.sims, maxAgeMs: d.cfg.risk.simMaxAgeMs }) : undefined;
    this.blockhash = d.blockhash ?? new BlockhashCache(d.conn, { refreshMs: d.cfg.blockhashRefreshMs ?? 2_000, staleMs: d.cfg.blockhashStaleMs ?? 20_000, commitment: d.cfg.commitment, log: this.log });
  }

  close(): void {
    this.blockhash.stop();
  }

  /** Distinct venues across routes (shared venues once). */
  allVenues(): SwapVenue[] {
    const out: SwapVenue[] = [];
    for (const r of this.routes) for (const v of [r.a, r.b]) if (!out.includes(v)) out.push(v);
    return out;
  }

  /** First route's venues (single-route callers). */
  get venues() {
    return { a: this.routes[0].a, b: this.routes[0].b };
  }

  routeOf(plan: Pick<PairPlan, "pair">): PairRoute {
    const r = this.routes.find((x) => x.name === plan.pair);
    if (!r) throw new Error(`no route ${plan.pair}`);
    return r;
  }

  execPolicy(): ExecFeePolicy {
    const { cfg } = this.d;
    const r = cfg.risk;
    const maxPrio = r.maxPriorityFeeLamports < cfg.priorityFeeLamports ? r.maxPriorityFeeLamports : cfg.priorityFeeLamports;
    return { baseFeeLamports: cfg.baseFeeLamports, maxPriorityFeeLamports: maxPrio, maxTipLamports: r.maxTipLamports, maxShareBps: r.maxExecCostBpsOfProfit, tipEnabled: cfg.delivery === "jito" };
  }

  private profitFloor(): bigint {
    const { cfg } = this.d;
    const m = cfg.risk.minNetProfitLamports;
    return m > cfg.profitFloorLamports ? m : cfg.profitFloorLamports;
  }

  get lossLimitHit(): boolean {
    return this.sessionNetLamports < -this.d.cfg.maxSessionLossLamports;
  }

  private optimizeCached(route: PairRoute, slot: number, cap: bigint, floor: bigint, policy: ExecFeePolicy): { res: PairOptimizeResult; cached: boolean } {
    const { a, b } = route;
    const key = `${a.quoteKey()}|${b.quoteKey()}|${cap}|${floor}|${policy.tipEnabled}`;
    const hit = this.optCache.get(route.name);
    if (hit?.key === key) {
      const c = hit.res;
      const re = (p: PairPlan | null) => (p ? { ...p, slot } : null);
      return { res: { ...c, best: re(c.best), byDirection: { buyAsellB: re(c.byDirection.buyAsellB), buyBsellA: re(c.byDirection.buyBsellA) } }, cached: true };
    }
    const res = optimizePair({ a, b }, { profitFloor: floor, fees: policy, maxLamportsIn: cap, minLamportsIn: this.d.cfg.minTradeLamports }, slot, this.d.search, route.name);
    this.optCache.set(route.name, { key, res });
    return { res, cached: false };
  }

  /** Invalidate the optimizer cache (e.g. a shred hint says a pool is about to move). */
  invalidate(): void {
    this.optCache.clear();
  }

  private haltCheck() {
    for (const v of this.allVenues()) if ((v as { programStale?: boolean }).programStale) this.risk.trip("program-upgrade", `${v.name} reports a program upgrade (programStale)`);
    return this.risk.halt();
  }

  private riskReject(slot: number, stage: string, reasons: string[], extra: Record<string, unknown> = {}) {
    this.log(`[${this.name} ${slot}] risk rejected (${stage}): ${reasons.join("; ")}`);
    this.d.ledger.append("risk", { pair: this.name, slot, stage, reasons, ...extra });
  }

  private learnCu(dir: string, sim: SimResult): void {
    if (!sim.ok || !sim.unitsConsumed) { delete this.cuLearned[dir]; return; }
    const need = cuFromSim(Math.ceil(sim.unitsConsumed * 1.1), this.d.cfg.cuHeadroomBps);
    const prev = this.cuLearned[dir];
    this.cuLearned[dir] = prev && prev >= need && prev <= need * 1.5 ? prev : need;
  }

  async tick(trigger?: string): Promise<PairTickResult> {
    if (this.inFlight || this.risk.inFlight) throw new Error("tick() re-entered while a tx is in flight");
    const wallStart = Date.now();
    const halted = this.haltCheck();
    if (halted) return { status: "halted", slot: this.state.lastSlot };
    if (!this.blockhash.running) this.blockhash.start();
    const tickStart = performance.now();
    const { slot, updated } = await this.state.refresh();
    if (!updated) return { status: "stale", slot };
    const refreshed = performance.now();
    const marks: LatencyMarks = { received: Math.min(this.state.lastUpdateAt ?? tickStart, tickStart), tickStart, refreshed, dataAt: this.state.lastUpdateAt, ingestMs: this.state.lastIngestMs };
    const source = this.state.lastSource ?? this.state.name;
    const info: PairTickInfo = { pair: this.name, status: "no-opportunity", trigger, wallStart, slot, stateSource: source, pollMs: r1(refreshed - tickStart) };
    // shred hint for this pair woke the loop: requote now and keep a latency marker
    const hit = trigger?.startsWith(`shred:${this.name}:`) ? this.d.pending?.latest?.(this.name) : null;
    if (hit) info.hint = { slot: hit.slot, signature: hit.signature, feePayer: hit.feePayer, kind: hit.kind, hintToTickMs: r1(tickStart - hit.receivedAt) };
    const r = await this.evaluate(slot, marks, info, trigger);
    if (info.hint && marks.decided !== undefined && hit) info.hint.hintToDecisionMs = r1(marks.decided - hit.receivedAt);
    info.status = r.status;
    const lr = latencyRecord(slot, source, r.status, marks, trigger);
    this.latency.add(lr);
    const sum = this.latency.maybeFlush();
    if (sum) this.d.ledger.append("latency", { pair: this.name, ...sum });
    if (marks.dataAt !== undefined && marks.decided !== undefined) info.dataToDecisionMs = r1(marks.decided - marks.dataAt);
    if (marks.dataAt !== undefined && marks.simulated !== undefined) info.dataToSimulatedMs = r1(marks.simulated - marks.dataAt);
    this.d.onTick?.(info);
    return r;
  }

  private async evaluate(slot: number, marks: LatencyMarks, info: PairTickInfo, trigger?: string): Promise<PairTickResult> {
    const { cfg, ledger } = this.d;
    const wsol = this.balances.wsol;
    const tok = this.balances.rise;
    if (wsol === null || tok === null) {
      this.log(`[${this.name} ${slot}] user token accounts missing (wSOL ${this.wsolAta.toBase58()} / token ${this.tokenAta.toBase58()})`);
      return { status: "no-balance", slot };
    }
    // e.g. PumpSwap user_volume_accumulator: a buy would create it (one-time rent) inside the trade tx
    if (this.prereqs.missing.length) {
      const why = this.prereqs.missing.map((m) => `${m.account.toBase58()} (${m.why})`).join("; ");
      if (why !== this.prereqWarned) { this.log(`[${this.name} ${slot}] not trading: required user account missing: ${why}`); ledger.append("risk", { pair: this.name, slot, stage: "prereq", reasons: [`missing ${why}`] }); this.prereqWarned = why; }
      return { status: "missing-prereq", slot };
    }
    this.prereqWarned = "";
    const cap = [cfg.maxTradeLamports, cfg.maxWsolLamports, wsol, cfg.risk.maxInputLamports].reduce((a, b) => (a < b ? a : b));
    const floor = this.profitFloor();
    const policy = this.execPolicy();
    const q0 = performance.now();
    const bestOf = (r: PairOptimizeResult) => Object.fromEntries((["buyAsellB", "buyBsellA"] as PairDirection[]).map((k) => {
      const d = r.details[k];
      const p = d.best;
      return [k, p ? { grossIn: p.grossIn.toString(), expectedProfit: p.expectedProfit.toString(), skipped: d.skipped } : null];
    })) as NonNullable<PairTickInfo["best"]>;
    // every route each tick (shared venues were refreshed once); take the single best plan across routes
    const perRoute: { route: PairRoute; res: PairOptimizeResult; cached: boolean }[] = [];
    info.routes = {};
    let screenEvals = 0, exactEvals = 0, allCached = true;
    for (const route of this.routes) {
      const r0 = performance.now();
      const { res: rr, cached: rc } = this.optimizeCached(route, slot, cap, floor, policy);
      const se = rc ? 0 : rr.details.buyAsellB.screenEvals + rr.details.buyBsellA.screenEvals;
      const ee = rc ? 0 : rr.details.buyAsellB.exactEvals + rr.details.buyBsellA.exactEvals;
      screenEvals += se; exactEvals += ee; allCached &&= rc;
      info.routes[route.name] = { quoteUs: Math.round((performance.now() - r0) * 1000), cached: rc, screenEvals: se, exactEvals: ee, best: bestOf(rr), feasible: !!rr.best };
      perRoute.push({ route, res: rr, cached: rc });
    }
    const byProfit = (x: PairPlan | null, y: PairPlan | null) => (x && (!y || x.expectedProfit > y.expectedProfit) ? -1 : y && (!x || y.expectedProfit > x.expectedProfit) ? 1 : 0);
    const chosen = [...perRoute].sort((x, y) => byProfit(x.res.best, y.res.best))[0];
    const res = chosen.res;
    const cached = allCached;
    marks.decided = performance.now();
    info.wallDecided = Date.now();
    info.quoteUs = Math.round((marks.decided - q0) * 1000);
    info.cached = cached;
    info.screenEvals = screenEvals;
    info.exactEvals = exactEvals;
    info.best = bestOf(res);
    const force = cfg.mode === "simulate" && (this.d.forceSimEveryMs ?? 0) > 0 && Date.now() - this.lastForced >= this.d.forceSimEveryMs!;
    let plan = res.best;
    let forced = false;
    if (!plan && force) {
      // latency measurement only: the best (sub-floor) plan of either direction
      const cands = perRoute.flatMap((x) => [x.res.details.buyAsellB.best, x.res.details.buyBsellA.best]).filter((p): p is PairPlan => !!p && p.grossIn <= cap);
      cands.sort((x, y) => (x.expectedProfit > y.expectedProfit ? -1 : 1));
      plan = cands[0] ?? null;
      forced = !!plan;
    }
    if (!plan) return { status: "no-opportunity", slot, opt: res };
    if (forced) this.lastForced = Date.now();
    info.plan = pairPlanRecord(plan);
    info.route = plan.pair;
    info.forced = forced;
    const route = this.routeOf(plan);
    const venues = { a: route.a, b: route.b };
    const cuKey = `${plan.pair}:${plan.direction}`;
    if (!forced) {
      const pending = this.d.pending?.summary?.(slot, this.name);
      ledger.append("opportunity", { pair: this.name, slot, plan: pairPlanRecord(plan), other: Object.fromEntries(Object.entries(res.byDirection).map(([k, v]) => [k, v ? v.expectedProfit : null])), ...(pending ? { pending } : {}), trigger, latency: latencyRecord(slot, info.stateSource, "opportunity", marks, trigger) });
      this.log(`[${this.name} ${slot}] opportunity ${plan.direction} (${plan.buyVenue} -> ${plan.sellVenue}): in ${fmt(plan.grossIn)} SOL, token ${plan.token}, out ${fmt(plan.lamportsOut)} SOL, expected net ${fmt(plan.expectedProfit)} SOL`);
      if (cfg.holdOnCompetingArb && this.d.pending) {
        const c = this.d.pending.competingArb(slot, this.name);
        if (c) {
          ledger.append("hold", { pair: this.name, slot, direction: plan.direction, reason: "competing arb pending", competitor: c });
          return { status: "held", slot, plan, opt: res };
        }
      }
    }
    // --- risk gate 1: freshness, gross input cap ---
    {
      const reasons = this.risk.checkFreshness({ snapshotSlot: slot, snapshotReceivedAt: marks.received, nowPerf: performance.now(), providerStale: (this.state as { stale?: boolean }).stale === true });
      if (plan.grossIn > cfg.risk.maxInputLamports) reasons.push(`gross input ${plan.grossIn} > max ${cfg.risk.maxInputLamports}`);
      if (reasons.length && !forced) { this.riskReject(slot, "pre-build", reasons, { direction: plan.direction }); return { status: "risk-rejected", slot, plan, opt: res }; }
    }
    // --- build ---
    const b0 = performance.now();
    const { blockhash, lastValidBlockHeight } = await this.blockhash.getOrFetch();
    const signer = cfg.mode === "live" ? cfg.keypair : null;
    const tipAccount = plan.fees.tipLamports > 0n ? await this.d.preparer?.tipAccount?.() : undefined;
    const buildFloor = forced ? [floor, plan.lamportsOut - plan.lamportsIn - plan.minOutPad - plan.fees.totalLamports].reduce((a, b) => (a < b ? a : b)) : floor;
    const base = { user: this.user, profitFloorLamports: buildFloor, recentBlockhash: blockhash, execFees: plan.fees, tipAccount, lookupTables: this.d.pair.lookupTables };
    const feeFor = (cuLimit: number) => txFee(cuLimit, cuPriceFor(plan!.fees.priorityLamports, cuLimit), plan!.fees.baseLamports);
    const simBase = {
      wsolAta: this.wsolAta, riseAta: this.tokenAta, wsolPre: wsol, risePre: tok,
      profitFloorLamports: floor, toleranceLamports: cfg.simToleranceLamports, toleranceBps: cfg.simToleranceBps,
    };
    const simPlan = { lamportsIn: plan.lamportsIn, lamportsOut: plan.lamportsOut };
    const learned = this.cuLearned[cuKey];
    let built: PairBuiltTx;
    let buildMs = 0;
    try {
      if (learned) {
        built = buildPairTx(plan, venues, { ...base, cuLimit: learned, signer });
        marks.built = performance.now();
        buildMs = marks.built - b0;
      } else {
        const simTx = buildPairTx(plan, venues, { ...base, cuLimit: SIM_CU });
        marks.built = performance.now();
        buildMs = marks.built - b0;
        const sim = await simulateArb(this.d.conn, simTx.tx, simPlan, { ...simBase, tipLamports: simTx.tipLamports, feeForUnits: (u: number) => { const cuLimit = cuFromSim(u, cfg.cuHeadroomBps); return { cuLimit, fee: feeFor(cuLimit) }; } });
        marks.preSimulated = performance.now();
        info.preSimMs = r1(marks.preSimulated - marks.built);
        ledger.append("simulation", { pair: this.name, slot, stage: "pre", forced, direction: plan.direction, ...simRecord(sim) });
        if (!sim.unitsConsumed || (!sim.ok && !forced)) {
          this.log(`[${this.name} ${slot}] pre-sim rejected: ${sim.reason}`);
          info.sim = simInfo(sim);
          info.buildMs = r1(buildMs);
          return { status: "sim-rejected", slot, plan, sim, opt: res };
        }
        const bb = performance.now();
        built = buildPairTx(plan, venues, { ...base, cuLimit: cuFromSim(sim.unitsConsumed, cfg.cuHeadroomBps), signer });
        buildMs += performance.now() - bb;
      }
    } catch (e) {
      this.log(`[${this.name} ${slot}] build failed: ${(e as Error).message}`);
      ledger.append("error", { pair: this.name, slot, stage: "build", message: (e as Error).message });
      return { status: "build-failed", slot, plan, opt: res };
    }
    const pb = performance.now();
    const prepared = this.d.preparer
      ? await this.d.preparer.prepare(built as unknown as BuiltTx, { payer: this.user, signer, expectedGrossProfit: plan.grossProfit, priorityFeeLamports: built.feeLamports - cfg.baseFeeLamports, baseFeeLamports: cfg.baseFeeLamports })
      : { tx: built.tx, instructions: built.instructions, tipLamports: built.tipLamports };
    buildMs += performance.now() - pb;
    info.buildMs = r1(buildMs);
    info.txVersion = built.version;
    info.txSize = built.size;
    if ("reject" in prepared) { this.riskReject(slot, "prepare", [prepared.reject], { direction: plan.direction }); return { status: "risk-rejected", slot, plan, opt: res }; }
    const final: PairBuiltTx = { ...built, tx: prepared.tx, instructions: prepared.instructions };
    const tipLamports = prepared.tipLamports;
    marks.finalBuilt = performance.now();
    const sim2 = await simulateArb(this.d.conn, final.tx, simPlan, { ...simBase, tipLamports, feeForUnits: () => ({ cuLimit: final.cuLimit, fee: final.feeLamports }) });
    marks.simulated = performance.now();
    info.finalSimMs = r1(marks.simulated - marks.finalBuilt);
    info.sim = simInfo(sim2);
    this.learnCu(cuKey, sim2);
    ledger.append("simulation", { pair: this.name, slot, stage: "final", forced, direction: plan.direction, cuLimit: final.cuLimit, cuPrice: final.cuPriceMicroLamports, fee: final.feeLamports, txVersion: final.version, txSize: final.size, ...simRecord(sim2), latency: latencyRecord(slot, info.stateSource, sim2.ok ? "simulated" : "sim-rejected", marks, trigger) });
    if (!sim2.ok) {
      this.log(`[${this.name} ${slot}] final sim rejected${forced ? " (forced, sub-floor)" : ""}: ${sim2.reason}`);
      return { status: "sim-rejected", slot, plan, sim: sim2, opt: res };
    }
    if (forced) return { status: "simulated", slot, plan, sim: sim2, opt: res }; // never sendable
    this.log(`[${this.name} ${slot}] sim ok: profit ${fmt(sim2.simulatedProfit!)} SOL (expected ${fmt(sim2.expectedProfit!)}), CU ${sim2.unitsConsumed} -> limit ${final.cuLimit}, fee ${final.feeLamports}, ${final.version} ${final.size} B`);
    // --- risk gate 2 ---
    const msgHash = this.sims.record(final.tx, true);
    this.risk.noteSlot(sim2.slot);
    const oppKey = pairOpportunityKey(plan);
    {
      const reasons = this.risk.checkFreshness({ snapshotSlot: slot, snapshotReceivedAt: marks.received, nowPerf: performance.now(), providerStale: (this.state as { stale?: boolean }).stale === true });
      reasons.push(...this.risk.checkTrade({
        direction: "mintThenSell", // (unused by checkTrade; RISE Direction type)
        lamportsIn: plan.grossIn, expectedGrossProfit: plan.grossProfit,
        baseFeeLamports: cfg.baseFeeLamports, priorityFeeLamports: final.feeLamports - cfg.baseFeeLamports, tipLamports,
      }));
      const signature = cfg.mode === "live" ? signatureOf(final.tx) : `unsigned:${msgHash}`;
      reasons.push(...this.risk.checkDuplicate({ signature, messageHash: msgHash, oppKey, slot }));
      const h = this.haltCheck();
      if (h) reasons.push(`halted (${h.reason}): ${h.detail}`);
      if (reasons.length) { this.riskReject(slot, "pre-send", reasons, { direction: plan.direction, fee: final.feeLamports, tip: tipLamports }); return { status: "risk-rejected", slot, plan, sim: sim2, opt: res }; }
    }
    if (cfg.mode !== "live") {
      this.log(`[${this.name} ${slot}] simulate mode: would send ${plan.direction} with final min-out ${final.finalMinOut}`);
      return { status: "simulated", slot, plan, sim: sim2, opt: res };
    }
    const outcome = await this.send(final, lastValidBlockHeight, slot, marks, { sim: sim2, tipLamports, messageHash: msgHash, oppKey });
    return { status: "sent", slot, plan, sim: sim2, outcome, opt: res };
  }

  private async send(b: PairBuiltTx, lastValidBlockHeight: number, slot: number, marks: LatencyMarks, x: { sim: SimResult; tipLamports: bigint; messageHash: string; oppKey: string }): Promise<Realized> {
    const { ledger, cfg } = this.d;
    const plan = b.plan;
    const sender = this.sender!;
    const signature = signatureOf(b.tx);
    this.risk.beginSubmission({ signature, messageHash: x.messageHash, oppKey: x.oppKey, slot }, { lastValidBlockHeight, feeLamports: b.feeLamports, tipLamports: x.tipLamports, delivery: sender.name });
    this.inFlight = true;
    try {
      ledger.append("submission", { pair: this.name, slot, signature, direction: plan.direction, sender: sender.name, cuLimit: b.cuLimit, cuPrice: b.cuPriceMicroLamports, fee: b.feeLamports, tip: x.tipLamports, messageHash: x.messageHash, leg1Limit: b.leg1Limit, finalMinOut: b.finalMinOut, lastValidBlockHeight });
      let res;
      try {
        res = await sender.send(b.tx, lastValidBlockHeight);
      } catch (e) {
        if (e instanceof SubmitRefused) {
          this.risk.abortSubmission(signature, e.message);
          ledger.append("risk", { pair: this.name, slot, stage: "submit", reasons: [e.message], signature });
          throw e;
        }
        res = await resolveSignature(this.d.conn as unknown as StatusConnection, signature, lastValidBlockHeight, { commitment: cfg.commitment, log: this.log });
      }
      const landedAt = performance.now();
      if (res.firstSentAt !== undefined) marks.sent = res.firstSentAt;
      this.risk.noteSlot(res.slot);
      const realize = this.d.realize ?? ((sig: string) => fetchRealized(this.d.conn as unknown as Connection, sig, this.user.toBase58(), this.wsolAta.toBase58(), this.tokenAta.toBase58(), { kind: "other", attempts: res.status === "expired" ? 3 : 10 }));
      let outcome: Realized;
      try { outcome = await realize(res.signature, plan); } catch { outcome = droppedOutcome(res.signature, "other"); }
      if (!outcome.landed && res.status !== "expired") outcome = unrealizedLandedOutcome(res.signature, "other", res.status, b.feeLamports, x.tipLamports);
      const rec = reconcileOutcome(outcome, { wsolDelta: x.sim.wsolDelta ?? 0n, riseDelta: x.sim.riseDelta ?? 0n, feeLamports: b.feeLamports, baseFeeLamports: cfg.baseFeeLamports, tipLamports: x.tipLamports });
      const halt = this.risk.recordOutcome({ signature: res.signature, landed: outcome.landed, success: outcome.success, feeLamports: outcome.fee, tipLamports: rec.tipLamports, netLamports: outcome.netLamports });
      const rel = (t?: number) => (t !== undefined ? r1(t - marks.received) : undefined);
      ledger.append("outcome", {
        ...outcome, pair: this.name, direction: plan.direction, user: this.user.toBase58(), delivery: res.delivery ?? sender.name, sendStatus: res.status, expectedProfit: plan.expectedProfit,
        // token residue mark (lamports per token unit ×1e9) for valuing the residual separately
        tokenMarkLamportsPerTokenE9: plan.token > 0n ? (plan.lamportsOut * 1_000_000_000n) / plan.token : undefined,
        exec: { base: rec.baseFeeLamports, priority: rec.priorityFeeLamports, tip: rec.tipLamports, total: rec.execCostLamports },
        tradingProfit: rec.tradingProfitLamports, failedCost: rec.failedCostLamports, residualToken: rec.residualRise,
        expected: { wsolDelta: x.sim.wsolDelta, tokenDelta: x.sim.riseDelta, fee: b.feeLamports, tip: x.tipLamports, simulatedProfit: x.sim.simulatedProfit },
        drift: rec.drift,
        latencyMs: { decision: rel(marks.decided), simulated: rel(marks.simulated), sent: rel(res.firstSentAt), landed: rel(landedAt), slotsToLand: res.slot !== undefined ? res.slot - slot : undefined },
      });
      this.sessionNetLamports += outcome.netLamports;
      this.log(`[${this.name} ${slot}] realized: landed=${outcome.landed} ok=${outcome.success} fee=${outcome.fee} net=${fmt(outcome.netLamports)} SOL`);
      if (halt) this.log(`[${this.name} ${slot}] trading halted: ${halt.reason}`);
      return outcome;
    } finally {
      this.inFlight = false;
    }
  }
}

function simRecord(s: SimResult) {
  const { logs, ...rest } = s;
  return { ...rest, logsTail: s.ok ? undefined : logs?.slice(-6) };
}

function simInfo(s: SimResult): NonNullable<PairTickInfo["sim"]> {
  return { ok: s.ok, reason: s.reason, slot: s.slot, simulatedProfit: s.simulatedProfit?.toString(), expectedProfit: s.expectedProfit?.toString(), unitsConsumed: s.unitsConsumed, fee: s.fee?.toString() };
}
