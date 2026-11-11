// One tick of the pipeline: refresh state -> optimize both directions ->
// build -> simulate (always) -> [live] send -> track realized outcome.
// Strictly serialized: tick() never returns while a tx is in flight, and the
// caller never runs two ticks concurrently.
import type { Connection, PublicKey } from "@solana/web3.js";
import type { Config } from "../config.js";
import type { DlmmVenue, RiseVenue, StateSource } from "../types.js";
import { optimize, type OptimizeResult, type Plan } from "./optimizer.js";
import { BlockhashCache } from "./blockhash.js";
import type { ExecFeePolicy } from "./fees.js";
import { StateManager, TokenBalances, type StateConnection, type StateProvider } from "./state.js";
import { LatencyStats, latencyRecord, type LatencyMarks } from "./latency.js";
import { buildArbTx, cuFromSim, cuPriceFor, estimatedTxCost, SIM_CU, txFee, type BuiltTx } from "./tx.js";
import { simulateArb, type SimConnection, type SimResult } from "./simulate.js";
import { GuardedSender, messageHash, resolveSignature, signatureOf, SimRegistry, SubmitRefused, type Sender, type StatusConnection, type TxPreparer } from "./sender.js";
import { droppedOutcome, fetchRealized, reconcileOutcome, type Ledger, type Realized } from "./ledger.js";
import { opportunityKey, RiskGuard } from "./risk.js";
import { atasFor } from "./setup.js";

export type EngineConnection = StateConnection & SimConnection & Pick<Connection, "getLatestBlockhash">;

export interface EngineDeps {
  conn: EngineConnection;
  rise: RiseVenue;
  dlmm: DlmmVenue;
  cfg: Config;
  ledger: Ledger;
  /** Required in live mode. */
  sender?: Sender;
  /** Realized-outcome fetcher (defaults to getTransaction via conn). */
  realize?: (signature: string, plan: Plan) => Promise<Realized>;
  log?: (msg: string) => void;
  /**
   * State provider factory (e.g. GrpcProvider). Gets the engine's full source list
   * (venues + token balances) and the default polling StateManager over them.
   * Defaults to that polling StateManager.
   */
  stateProvider?: (sources: StateSource[], polling: StateManager) => StateProvider;
  /** Unconfirmed-activity hint (ShredStream). Only consulted when cfg.holdOnCompetingArb. */
  pending?: PendingHint;
  /** Risk limits / halts. Default: an in-memory RiskGuard from cfg.risk (main.ts passes the persistent one). */
  risk?: RiskGuard;
  /** Turns the built tx into the exact tx to final-simulate and send (Jito: adds the tip ix). Default: unchanged. */
  preparer?: TxPreparer;
  /** Blockhash source (default: a background-refreshed BlockhashCache over conn). */
  blockhash?: BlockhashCache;
}

/** What the engine needs from a pending-activity feed (src/feeds/shreds.ts PendingActivity). */
export interface PendingHint {
  /** A competing (non-own) arb on the pool seen at slot >= `slot`, or null. */
  competingArb(slot: number): { slot: number; signature: string; feePayer: string } | null;
  summary?(slot: number): Record<string, number>;
}

export type TickStatus = "stale" | "no-balance" | "no-opportunity" | "held" | "sim-rejected" | "risk-rejected" | "halted" | "simulated" | "sent";

export interface TickResult {
  status: TickStatus;
  slot: number;
  plan?: Plan;
  sim?: SimResult;
  outcome?: Realized;
  /** Optimizer stats for this tick (exact/approx quote counts, skipped directions, cache hit). */
  opt?: { cached: boolean; exactEvals: number; approxEvals: number; skipped: string[] };
}

const fmt = (l: bigint) => (Number(l) / 1e9).toFixed(9);

export class ArbEngine {
  readonly state: StateProvider;
  readonly latency: LatencyStats;
  readonly balances: TokenBalances;
  readonly wsolAta: PublicKey;
  readonly riseAta: PublicKey;
  sessionNetLamports = 0n;
  inFlight = false;
  readonly risk: RiskGuard;
  /** Exact messages whose simulation passed (the sender refuses anything else). */
  readonly sims = new SimRegistry();
  private readonly sender?: Sender;
  private log: (m: string) => void;
  readonly blockhash: BlockhashCache;
  /** CU limit learned from the last OK final simulation per direction (lets the ready tx skip the pre-sim). */
  private cuLearned: Partial<Record<Plan["direction"], number>> = {};
  /** Last optimizer result and the venue-state key it was computed for. */
  private optCache: { key: string; res: OptimizeResult } | null = null;

  constructor(private d: EngineDeps) {
    const { wsolAta, riseAta } = atasFor(d.cfg.user);
    this.wsolAta = wsolAta;
    this.riseAta = riseAta;
    this.balances = new TokenBalances(wsolAta, riseAta);
    const sources: StateSource[] = [d.rise, d.dlmm, this.balances];
    const polling = new StateManager(d.conn, sources, d.cfg.commitment);
    this.state = d.stateProvider ? d.stateProvider(sources, polling) : polling;
    this.latency = new LatencyStats(d.cfg.latencySummaryMs ?? 60_000);
    this.log = d.log ?? ((m) => console.log(m));
    if (d.cfg.mode === "live" && (!d.sender || !d.cfg.keypair)) throw new Error("live mode needs a sender and keypair");
    this.risk = d.risk ?? new RiskGuard(d.cfg.risk, { persist: false, log: this.log });
    // Every submission goes through the guard: live mode only, exact message simulated OK recently, no duplicates.
    this.sender = d.sender ? new GuardedSender(d.sender, { mode: d.cfg.mode, sims: this.sims, maxAgeMs: d.cfg.risk.simMaxAgeMs }) : undefined;
    this.blockhash = d.blockhash ?? new BlockhashCache(d.conn, { refreshMs: d.cfg.blockhashRefreshMs ?? 2_000, staleMs: d.cfg.blockhashStaleMs ?? 20_000, commitment: d.cfg.commitment, log: this.log });
    // RISE fast quotes: a small exact grid over the allowed trade-size range (rebuilt only when RISE state changes)
    (d.rise as { setFastRange?(r: { lo: bigint; hi: bigint; points?: number }): void }).setFastRange?.({ lo: d.cfg.minTradeLamports, hi: d.cfg.maxTradeLamports, points: 3 });
  }

  /** Stop background work (blockhash refresh). */
  close(): void {
    this.blockhash.stop();
  }

  /** Execution-cost policy for the optimizer / min-out (fees.ts). Tip only with a tipping delivery. */
  execPolicy(): ExecFeePolicy {
    const { cfg } = this.d;
    const r = cfg.risk;
    const maxPrio = r && r.maxPriorityFeeLamports < cfg.priorityFeeLamports ? r.maxPriorityFeeLamports : cfg.priorityFeeLamports;
    return {
      baseFeeLamports: cfg.baseFeeLamports,
      maxPriorityFeeLamports: maxPrio,
      maxTipLamports: r?.maxTipLamports ?? 0n,
      maxShareBps: r?.maxExecCostBpsOfProfit ?? 1_000n,
      tipEnabled: cfg.delivery === "jito",
    };
  }

  /** Net-profit floor: the stricter of PROFIT_FLOOR_LAMPORTS and the risk minimum. */
  private profitFloor(): bigint {
    const { cfg } = this.d;
    const m = cfg.risk?.minNetProfitLamports ?? 0n;
    return m > cfg.profitFloorLamports ? m : cfg.profitFloorLamports;
  }

  /**
   * Optimize both directions, reusing the previous result when neither venue's quote-relevant
   * state nor the limits changed (venues expose stateVersion / quoteKey()).
   */
  private optimizeCached(slot: number, cap: bigint, floor: bigint, policy: ExecFeePolicy): { res: OptimizeResult; cached: boolean } {
    const { cfg } = this.d;
    const rv = (this.d.rise as { stateVersion?: number }).stateVersion;
    const dk = (this.d.dlmm as { quoteKey?(): string }).quoteKey?.();
    const key = rv !== undefined && dk !== undefined ? `${rv}|${dk}|${cap}|${floor}|${policy.tipEnabled}` : null;
    if (key && this.optCache?.key === key) {
      const c = this.optCache.res;
      const re = (p: Plan | null) => (p ? { ...p, slot } : null);
      const byDirection = { mintThenSell: re(c.byDirection.mintThenSell), buyThenRedeem: re(c.byDirection.buyThenRedeem) };
      return { res: { ...c, best: re(c.best), byDirection }, cached: true };
    }
    // warm the RISE fast grid for this state (no-op when unchanged) before the search
    (this.d.rise as { prepareFast?(): void }).prepareFast?.();
    const res = optimize(
      { rise: this.d.rise, dlmm: this.d.dlmm },
      { profitFloor: floor, txCost: 0n, fees: policy, maxLamportsIn: cap, minLamportsIn: cfg.minTradeLamports, legSlippageBps: cfg.legSlippageBps },
      slot,
    );
    this.optCache = key ? { key, res } : null;
    return { res, cached: false };
  }

  /** Risk halt check run before any work in a tick (kill file, latched halts, daily limits, RISE upgrade flag). */
  private haltCheck() {
    if ((this.d.rise as { programStale?: boolean }).programStale) this.risk.trip("program-upgrade", "RISE venue reports a program upgrade (programStale)");
    return this.risk.halt();
  }

  private riskReject(slot: number, stage: string, reasons: string[], extra: Record<string, unknown> = {}): TickResult & { status: "risk-rejected" } {
    this.log(`[${slot}] risk rejected (${stage}): ${reasons.join("; ")}`);
    this.d.ledger.append("risk", { slot, stage, reasons, ...extra });
    return { status: "risk-rejected", slot };
  }

  /** True once the session loss limit is hit; the caller should stop. */
  get lossLimitHit(): boolean {
    return this.sessionNetLamports < -this.d.cfg.maxSessionLossLamports;
  }

  private feeParams() {
    return { priorityFeeLamports: this.d.cfg.priorityFeeLamports, baseFeeLamports: this.d.cfg.baseFeeLamports, signatures: 1 };
  }

  /** @param trigger why this tick runs (logged with latency), e.g. "grpc", "shred:arb", "timeout". */
  async tick(trigger?: string): Promise<TickResult> {
    if (this.inFlight || this.risk.inFlight) throw new Error("tick() re-entered while a tx is in flight");
    const halted = this.haltCheck();
    if (halted) return { status: "halted", slot: this.state.lastSlot };
    if (!this.blockhash.running) this.blockhash.start();
    const tickStart = performance.now();
    const { slot, updated } = await this.state.refresh();
    if (!updated) return { status: "stale", slot };
    const marks: LatencyMarks = { received: Math.min(this.state.lastUpdateAt ?? tickStart, tickStart), tickStart, refreshed: performance.now(), dataAt: this.state.lastUpdateAt, ingestMs: this.state.lastIngestMs };
    const source = this.state.lastSource ?? this.state.name;
    // Ticks with an opportunity carry their latency on the opportunity / final simulation /
    // hold / outcome ledger rows; every tick also feeds the periodic "latency" summary row.
    this.lat = (status: string) => latencyRecord(slot, source, status, marks, trigger);
    const r = await this.evaluate(slot, marks);
    if (this.d.cfg.tickLatencyRows) this.d.ledger.append("latency", { kind: "tick", ...this.lat(r.status), ...(r.opt ? { opt: r.opt } : {}) });
    this.latency.add(this.lat(r.status));
    const sum = this.latency.maybeFlush();
    if (sum) this.d.ledger.append("latency", sum);
    return r;
  }

  private lat: (status: string) => ReturnType<typeof latencyRecord> = () => { throw new Error("no tick"); };

  /**
   * Remember the CU limit for the direction's next ready tx: simulated units x headroom, +10%
   * margin (never below what this sim needed). Any failed final sim forgets it, so the next
   * tick measures again with a pre-sim.
   */
  private learnCu(dir: Plan["direction"], sim: SimResult): void {
    if (!sim.ok || !sim.unitsConsumed) { delete this.cuLearned[dir]; return; }
    const need = cuFromSim(Math.ceil(sim.unitsConsumed * 1.1), this.d.cfg.cuHeadroomBps);
    const prev = this.cuLearned[dir];
    // keep the current limit while it has room and is not wasteful (> 1.5x need lowers the CU price)
    this.cuLearned[dir] = prev && prev >= need && prev <= need * 1.5 ? prev : need;
  }

  private async evaluate(slot: number, marks: LatencyMarks): Promise<TickResult> {
    const { cfg, ledger } = this.d;
    const wsol = this.balances.wsol;
    if (wsol === null || this.balances.rise === null) {
      this.log(`[${slot}] user token accounts missing (wSOL ${this.wsolAta.toBase58()} / RISE ${this.riseAta.toBase58()}); run setup`);
      return { status: "no-balance", slot };
    }
    const cap = [cfg.maxTradeLamports, cfg.maxWsolLamports, wsol].reduce((a, b) => (a < b ? a : b));
    const fees = this.feeParams();
    const floor = this.profitFloor();
    // bench only (simulate mode): no floor in the search so a plan is always built + simulated
    const force = cfg.benchForceBuild && cfg.mode === "simulate";
    const { res: optRes, cached } = this.optimizeCached(slot, cap, force ? -(1n << 62n) : floor, this.execPolicy());
    const { best, byDirection } = optRes;
    marks.decided = performance.now();
    const det = Object.values(optRes.details ?? {});
    const opt = { cached, exactEvals: cached ? 0 : det.reduce((a, d) => a + d.exactEvals, 0), approxEvals: cached ? 0 : det.reduce((a, d) => a + d.approxEvals, 0), skipped: Object.entries(optRes.details ?? {}).filter(([, d]) => d.skipped).map(([k]) => k) };
    if (!best) return { status: "no-opportunity", slot, opt };
    const plan = best;
    const pending = this.d.pending?.summary?.(slot);
    ledger.append("opportunity", { slot, plan: planRecord(plan), other: Object.fromEntries(Object.entries(byDirection).map(([k, v]) => [k, v ? v.expectedProfit : null])), ...(pending ? { pending } : {}), latency: this.lat("opportunity") });
    if (cfg.holdOnCompetingArb && this.d.pending) {
      const c = this.d.pending.competingArb(slot);
      if (c) {
        this.log(`[${slot}] hold: competing arb ${c.signature.slice(0, 16)}… by ${c.feePayer} pending in slot ${c.slot}`);
        ledger.append("hold", { slot, direction: plan.direction, reason: "competing arb pending", competitor: c, latency: this.lat("held") });
        return { status: "held", slot, plan };
      }
    }
    this.log(`[${slot}] opportunity ${plan.direction}: in ${fmt(plan.lamportsIn)} SOL, rise ${plan.rise}, out ${fmt(plan.lamportsOut)} SOL, expected net ${fmt(plan.expectedProfit)} SOL`);
    // --- risk gate 1 (before building): stale state, input cap ---
    {
      const reasons = this.risk.checkFreshness({ snapshotSlot: slot, snapshotReceivedAt: marks.received, nowPerf: performance.now(), providerStale: (this.state as { stale?: boolean }).stale === true });
      if (plan.lamportsIn > cfg.risk.maxInputLamports) reasons.push(`input ${plan.lamportsIn} > max ${cfg.risk.maxInputLamports}`);
      if (reasons.length) return { ...this.riskReject(slot, "pre-build", reasons, { direction: plan.direction }), plan };
    }

    // --- build: blockhash from the background cache (RPC only if it is stale), fees/tip from
    // the plan (min-out = lamportsIn + pad + base + priority + tip + floor). With a CU limit
    // learned from an earlier final sim of this direction the ready tx is the final one and
    // the pre-sim is skipped; otherwise pre-sim with a generous limit to measure CU. ---
    const { blockhash, lastValidBlockHeight } = await this.blockhash.getOrFetch();
    const signer = cfg.mode === "live" ? cfg.keypair : null;
    // tipping delivery (Jito): a random tip account for the tip ix tx.ts appends (tip is budgeted in the min-out)
    const tipAccount = plan.fees.tipLamports > 0n ? await this.d.preparer?.tipAccount?.() : undefined;
    // (bench force-build: min-out at what the plan can clear, so the tx builds; the sims still judge against the real floor)
    const buildFloor = force ? [floor, plan.lamportsOut - plan.lamportsIn - plan.minOutPad - plan.fees.totalLamports].reduce((a, b) => (a < b ? a : b)) : floor;
    const base = { ...fees, user: cfg.user, profitFloorLamports: buildFloor, recentBlockhash: blockhash, execFees: plan.fees, tipAccount };
    const feeFor = (cuLimit: number) => txFee(cuLimit, cuPriceFor(plan.fees.priorityLamports, cuLimit), plan.fees.baseLamports);
    const simBase = {
      wsolAta: this.wsolAta, riseAta: this.riseAta, wsolPre: wsol, risePre: this.balances.rise,
      profitFloorLamports: floor, toleranceLamports: cfg.simToleranceLamports, toleranceBps: cfg.simToleranceBps,
    };
    const learned = this.cuLearned[plan.direction];
    let built: BuiltTx;
    let sim: SimResult | undefined;
    if (learned) {
      built = buildArbTx(plan, this.d, { ...base, cuLimit: learned, signer });
      marks.built = performance.now();
    } else {
      const simTx = buildArbTx(plan, this.d, { ...base, cuLimit: SIM_CU });
      marks.built = performance.now();
      sim = await simulateArb(this.d.conn, simTx.tx, plan, { ...simBase, feeForUnits: (u: number) => { const cuLimit = cuFromSim(u, cfg.cuHeadroomBps); return { cuLimit, fee: feeFor(cuLimit) }; } });
      marks.preSimulated = performance.now();
      ledger.append("simulation", { slot, stage: "pre", direction: plan.direction, ...simRecord(sim) });
      if (!sim.ok) {
        this.log(`[${slot}] sim rejected: ${sim.reason}`);
        return { status: "sim-rejected", slot, plan, sim, opt };
      }
      // --- final tx with CU from the sim; simulate the exact final message again ---
      built = buildArbTx(plan, this.d, { ...base, cuLimit: sim.cuLimit!, signer });
    }
    // exact tx to final-simulate and send (Jito: + tip ix, re-signed)
    const prepared = this.d.preparer
      ? await this.d.preparer.prepare(built, { payer: cfg.user, signer: cfg.mode === "live" ? cfg.keypair : null, expectedGrossProfit: plan.lamportsOut - plan.lamportsIn, priorityFeeLamports: built.feeLamports - cfg.baseFeeLamports, baseFeeLamports: cfg.baseFeeLamports })
      : { tx: built.tx, instructions: built.instructions, tipLamports: 0n };
    if ("reject" in prepared) return { ...this.riskReject(slot, "prepare", [prepared.reject], { direction: plan.direction }), plan, sim };
    const final: BuiltTx = { ...built, tx: prepared.tx, instructions: prepared.instructions };
    const tipLamports = prepared.tipLamports;
    const builtAt = performance.now();
    if (learned) marks.built = builtAt;
    marks.finalBuilt = builtAt;
    // the final sim judges the exact final message at its exact fee
    const sim2 = await simulateArb(this.d.conn, final.tx, plan, { ...simBase, feeForUnits: () => ({ cuLimit: final.cuLimit, fee: final.feeLamports }) });
    marks.simulated = performance.now();
    this.learnCu(plan.direction, sim2);
    ledger.append("simulation", { slot, stage: "final", direction: plan.direction, cuLimit: final.cuLimit, cuPrice: final.cuPriceMicroLamports, fee: final.feeLamports, ...simRecord(sim2), latency: this.lat(sim2.ok ? "simulated" : "sim-rejected") });
    if (!sim2.ok) {
      this.log(`[${slot}] final sim rejected: ${sim2.reason}`);
      return { status: "sim-rejected", slot, plan, sim: sim2 };
    }
    this.log(`[${slot}] sim ok: profit ${fmt(sim2.simulatedProfit!)} SOL (expected ${fmt(sim2.expectedProfit!)}), CU ${sim2.unitsConsumed} -> limit ${final.cuLimit}, fee ${final.feeLamports}`);
    // --- risk gate 2 (before submit, both modes): freshness again, spending limits, duplicates, halts ---
    const msgHash = this.sims.record(final.tx, true);
    this.risk.noteSlot(sim2.slot);
    {
      const reasons = this.risk.checkFreshness({ snapshotSlot: slot, snapshotReceivedAt: marks.received, nowPerf: performance.now(), providerStale: (this.state as { stale?: boolean }).stale === true });
      reasons.push(...this.risk.checkTrade({
        direction: plan.direction, lamportsIn: plan.lamportsIn, expectedGrossProfit: plan.lamportsOut - plan.lamportsIn,
        baseFeeLamports: cfg.baseFeeLamports, priorityFeeLamports: final.feeLamports - cfg.baseFeeLamports, tipLamports,
      }));
      const signature = cfg.mode === "live" ? signatureOf(final.tx) : `unsigned:${msgHash}`;
      reasons.push(...this.risk.checkDuplicate({ signature, messageHash: msgHash, oppKey: opportunityKey(plan), slot }));
      const h = this.haltCheck();
      if (h) reasons.push(`halted (${h.reason}): ${h.detail}`);
      if (reasons.length) return { ...this.riskReject(slot, "pre-send", reasons, { direction: plan.direction, fee: final.feeLamports, tip: tipLamports }), plan, sim: sim2 };
    }
    if (cfg.mode !== "live") {
      this.log(`[${slot}] simulate mode: would send ${plan.direction} with final min-out ${final.finalMinOut}`);
      return { status: "simulated", slot, plan, sim: sim2 };
    }
    const outcome = await this.send(final, lastValidBlockHeight, slot, marks, { sim: sim2, tipLamports, builtAt, messageHash: msgHash });
    return { status: "sent", slot, plan, sim: sim2, outcome };
  }

  private async send(b: BuiltTx, lastValidBlockHeight: number, slot: number, marks: LatencyMarks | undefined, x: { sim: SimResult; tipLamports: bigint; builtAt: number; messageHash: string }): Promise<Realized> {
    const { ledger, cfg } = this.d;
    const plan = b.plan;
    const sender = this.sender!;
    const signature = signatureOf(b.tx);
    // exactly one tx in flight (throws if another is unresolved, on a halt, or on a duplicate)
    this.risk.beginSubmission({ signature, messageHash: x.messageHash, oppKey: opportunityKey(plan), slot }, { lastValidBlockHeight, feeLamports: b.feeLamports, tipLamports: x.tipLamports, delivery: sender.name });
    this.inFlight = true;
    try {
      ledger.append("submission", { slot, signature, direction: plan.direction, sender: sender.name, cuLimit: b.cuLimit, cuPrice: b.cuPriceMicroLamports, fee: b.feeLamports, tip: x.tipLamports, messageHash: x.messageHash, leg1Limit: b.leg1Limit, finalMinOut: b.finalMinOut, lastValidBlockHeight });
      let res;
      try {
        res = await sender.send(b.tx, lastValidBlockHeight);
      } catch (e) {
        if (e instanceof SubmitRefused) {
          this.risk.abortSubmission(signature, e.message);
          ledger.append("risk", { slot, stage: "submit", reasons: [e.message], signature });
          throw e;
        }
        // Unknown state: it may have been broadcast. Resolve its final status before releasing.
        this.log(`[${slot}] sender error, resolving ${signature.slice(0, 16)}… before continuing: ${(e as Error).message}`);
        res = await resolveSignature(this.d.conn as unknown as StatusConnection, signature, lastValidBlockHeight, { commitment: cfg.commitment, log: this.log });
      }
      const landedAt = performance.now();
      if (marks && res.firstSentAt !== undefined) marks.sent = res.firstSentAt;
      this.risk.noteSlot(res.slot);
      this.log(`[${slot}] ${res.signature} -> ${res.status}${res.err ? " " + JSON.stringify(res.err) : ""} (${res.broadcasts} broadcasts)`);
      const realize = this.d.realize ?? ((sig: string, p: Plan) =>
        fetchRealized(this.d.conn as unknown as Connection, sig, this.d.cfg.user.toBase58(), this.wsolAta.toBase58(), this.riseAta.toBase58(), { kind: p.direction, attempts: res.status === "expired" ? 3 : 10 }));
      let outcome: Realized;
      try {
        outcome = await realize(res.signature, plan);
      } catch (e) {
        this.log(`realize failed: ${(e as Error).message}`);
        outcome = droppedOutcome(res.signature, plan.direction);
      }
      // reconcile actual vs expected (final sim + built fee + tip); split trading profit / execution costs / RISE residue
      const rec = reconcileOutcome(outcome, { wsolDelta: x.sim.wsolDelta ?? 0n, riseDelta: x.sim.riseDelta ?? 0n, feeLamports: b.feeLamports, baseFeeLamports: cfg.baseFeeLamports, tipLamports: x.tipLamports });
      const halt = this.risk.recordOutcome({ signature: res.signature, landed: outcome.landed, success: outcome.success, feeLamports: outcome.fee, tipLamports: rec.tipLamports, netLamports: outcome.netLamports });
      const mark = plan.rise > 0n ? ((plan.direction === "mintThenSell" ? plan.lamportsIn : plan.lamportsOut) * 1_000_000_000n) / plan.rise : undefined;
      const rel = (t?: number) => (marks && t !== undefined ? Math.round((t - marks.received) * 10) / 10 : undefined);
      ledger.append("outcome", {
        ...outcome, user: cfg.user.toBase58(), delivery: res.delivery ?? sender.name, latency: this.lat("sent"), sendStatus: res.status, expectedProfit: plan.expectedProfit, riseMarkLamportsPerRiseE9: mark,
        exec: { base: rec.baseFeeLamports, priority: rec.priorityFeeLamports, tip: rec.tipLamports, total: rec.execCostLamports },
        tradingProfit: rec.tradingProfitLamports, failedCost: rec.failedCostLamports, residualRise: rec.residualRise,
        expected: { wsolDelta: x.sim.wsolDelta, riseDelta: x.sim.riseDelta, fee: b.feeLamports, tip: x.tipLamports, simulatedProfit: x.sim.simulatedProfit },
        drift: rec.drift,
        latencyMs: { decision: rel(marks?.decided), built: rel(x.builtAt), simulated: rel(marks?.simulated), sent: rel(res.firstSentAt), landed: rel(landedAt), slotsToLand: res.slot !== undefined ? res.slot - slot : undefined },
      });
      this.sessionNetLamports += outcome.netLamports;
      this.log(`[${slot}] realized: landed=${outcome.landed} ok=${outcome.success} fee=${outcome.fee} tip=${rec.tipLamports} wSOLΔ=${outcome.wsolDelta} RISEΔ=${outcome.riseDelta} net=${fmt(outcome.netLamports)} SOL (session ${fmt(this.sessionNetLamports)}; day exec ${this.risk.dailyExecCost}, day net ${this.risk.dailyRealized}, fail streak ${this.risk.consecutiveFailures})`);
      if (halt) this.log(`[${slot}] trading halted: ${halt.reason}`);
      return outcome;
    } finally {
      this.inFlight = false;
    }
  }
}

export function planRecord(p: Plan) {
  return { direction: p.direction, slot: p.slot, lamportsIn: p.lamportsIn, rise: p.rise, lamportsOut: p.lamportsOut, expectedProfit: p.expectedProfit, txCostLamports: p.txCostLamports, leg1Quote: p.leg1Quote, binArrays: p.binArrays.map((b) => b.toBase58()) };
}

function simRecord(s: SimResult) {
  const { logs, ...rest } = s;
  return { ...rest, logsTail: s.ok ? undefined : logs?.slice(-6) };
}
