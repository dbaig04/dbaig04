// One tick of the pipeline: refresh state -> optimize both directions ->
// build -> simulate (always) -> [live] send -> track realized outcome.
// Strictly serialized: tick() never returns while a tx is in flight, and the
// caller never runs two ticks concurrently.
import type { Connection, PublicKey } from "@solana/web3.js";
import type { Config } from "../config.js";
import type { DlmmVenue, RiseVenue, StateSource } from "../types.js";
import { optimize, type Plan } from "./optimizer.js";
import { StateManager, TokenBalances, type StateConnection, type StateProvider } from "./state.js";
import { LatencyStats, latencyRecord, type LatencyMarks } from "./latency.js";
import { buildArbTx, cuFromSim, cuPriceFor, estimatedTxCost, SIM_CU, txFee, type BuiltTx } from "./tx.js";
import { simulateArb, type SimConnection, type SimResult } from "./simulate.js";
import { signatureOf, type Sender } from "./sender.js";
import { droppedOutcome, fetchRealized, type Ledger, type Realized } from "./ledger.js";
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
}

/** What the engine needs from a pending-activity feed (src/feeds/shreds.ts PendingActivity). */
export interface PendingHint {
  /** A competing (non-own) arb on the pool seen at slot >= `slot`, or null. */
  competingArb(slot: number): { slot: number; signature: string; feePayer: string } | null;
  summary?(slot: number): Record<string, number>;
}

export type TickStatus = "stale" | "no-balance" | "no-opportunity" | "held" | "sim-rejected" | "simulated" | "sent";

export interface TickResult {
  status: TickStatus;
  slot: number;
  plan?: Plan;
  sim?: SimResult;
  outcome?: Realized;
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
  private log: (m: string) => void;

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
    if (this.inFlight) throw new Error("tick() re-entered while a tx is in flight");
    const tickStart = performance.now();
    const { slot, updated } = await this.state.refresh();
    if (!updated) return { status: "stale", slot };
    const marks: LatencyMarks = { received: Math.min(this.state.lastUpdateAt ?? tickStart, tickStart), tickStart, refreshed: performance.now() };
    const source = this.state.lastSource ?? this.state.name;
    // Ticks with an opportunity carry their latency on the opportunity / final simulation /
    // hold / outcome ledger rows; every tick also feeds the periodic "latency" summary row.
    this.lat = (status: string) => latencyRecord(slot, source, status, marks, trigger);
    const r = await this.evaluate(slot, marks);
    this.latency.add(this.lat(r.status));
    const sum = this.latency.maybeFlush();
    if (sum) this.d.ledger.append("latency", sum);
    return r;
  }

  private lat: (status: string) => ReturnType<typeof latencyRecord> = () => { throw new Error("no tick"); };

  private async evaluate(slot: number, marks: LatencyMarks): Promise<TickResult> {
    const { cfg, ledger } = this.d;
    const wsol = this.balances.wsol;
    if (wsol === null || this.balances.rise === null) {
      this.log(`[${slot}] user token accounts missing (wSOL ${this.wsolAta.toBase58()} / RISE ${this.riseAta.toBase58()}); run setup`);
      return { status: "no-balance", slot };
    }
    const cap = [cfg.maxTradeLamports, cfg.maxWsolLamports, wsol].reduce((a, b) => (a < b ? a : b));
    const fees = this.feeParams();
    const txCost = estimatedTxCost(fees);
    const { best, byDirection } = optimize(
      { rise: this.d.rise, dlmm: this.d.dlmm },
      { profitFloor: cfg.profitFloorLamports, txCost, maxLamportsIn: cap, minLamportsIn: cfg.minTradeLamports, legSlippageBps: cfg.legSlippageBps },
      slot,
    );
    marks.decided = performance.now();
    if (!best) return { status: "no-opportunity", slot };
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

    // --- build + simulate (sim tx uses a generous CU limit; real limit comes from the sim) ---
    const { blockhash, lastValidBlockHeight } = await this.d.conn.getLatestBlockhash(cfg.commitment);
    const base = { ...fees, user: cfg.user, profitFloorLamports: cfg.profitFloorLamports, recentBlockhash: blockhash };
    const simTx = buildArbTx(plan, this.d, { ...base, cuLimit: SIM_CU });
    const simParams = {
      wsolAta: this.wsolAta, riseAta: this.riseAta, wsolPre: wsol, risePre: this.balances.rise,
      profitFloorLamports: cfg.profitFloorLamports, toleranceLamports: cfg.simToleranceLamports, toleranceBps: cfg.simToleranceBps,
      feeForUnits: (u: number) => { const cuLimit = cuFromSim(u, cfg.cuHeadroomBps); return { cuLimit, fee: txFee(cuLimit, cuPriceFor(fees.priorityFeeLamports, cuLimit), fees.baseFeeLamports) }; },
    };
    const sim = await simulateArb(this.d.conn, simTx.tx, plan, simParams);
    ledger.append("simulation", { slot, stage: "pre", direction: plan.direction, ...simRecord(sim) });
    if (!sim.ok) {
      this.log(`[${slot}] sim rejected: ${sim.reason}`);
      return { status: "sim-rejected", slot, plan, sim };
    }

    // --- final tx with CU from the sim; simulate the exact final message again ---
    const final = buildArbTx(plan, this.d, { ...base, cuLimit: sim.cuLimit!, signer: cfg.mode === "live" ? cfg.keypair : null });
    const sim2 = await simulateArb(this.d.conn, final.tx, plan, simParams);
    marks.simulated = performance.now();
    ledger.append("simulation", { slot, stage: "final", direction: plan.direction, cuLimit: final.cuLimit, cuPrice: final.cuPriceMicroLamports, fee: final.feeLamports, ...simRecord(sim2), latency: this.lat(sim2.ok ? "simulated" : "sim-rejected") });
    if (!sim2.ok) {
      this.log(`[${slot}] final sim rejected: ${sim2.reason}`);
      return { status: "sim-rejected", slot, plan, sim: sim2 };
    }
    this.log(`[${slot}] sim ok: profit ${fmt(sim2.simulatedProfit!)} SOL (expected ${fmt(sim2.expectedProfit!)}), CU ${sim2.unitsConsumed} -> limit ${final.cuLimit}, fee ${final.feeLamports}`);
    if (cfg.mode !== "live") {
      this.log(`[${slot}] simulate mode: would send ${plan.direction} with final min-out ${final.finalMinOut}`);
      return { status: "simulated", slot, plan, sim: sim2 };
    }
    const outcome = await this.send(final, lastValidBlockHeight, slot, marks);
    return { status: "sent", slot, plan, sim: sim2, outcome };
  }

  private async send(b: BuiltTx, lastValidBlockHeight: number, slot: number, marks?: LatencyMarks): Promise<Realized> {
    const { ledger } = this.d;
    const plan = b.plan;
    this.inFlight = true;
    try {
      ledger.append("submission", { slot, signature: signatureOf(b.tx), direction: plan.direction, sender: this.d.sender!.name, cuLimit: b.cuLimit, cuPrice: b.cuPriceMicroLamports, fee: b.feeLamports, leg1Limit: b.leg1Limit, finalMinOut: b.finalMinOut, lastValidBlockHeight });
      const res = await this.d.sender!.send(b.tx, lastValidBlockHeight);
      if (marks && res.firstSentAt !== undefined) marks.sent = res.firstSentAt;
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
      const mark = plan.rise > 0n ? ((plan.direction === "mintThenSell" ? plan.lamportsIn : plan.lamportsOut) * 1_000_000_000n) / plan.rise : undefined;
      ledger.append("outcome", { ...outcome, latency: this.lat("sent"), sendStatus: res.status, expectedProfit: plan.expectedProfit, riseMarkLamportsPerRiseE9: mark });
      this.sessionNetLamports += outcome.netLamports;
      this.log(`[${slot}] realized: landed=${outcome.landed} ok=${outcome.success} fee=${outcome.fee} wSOLΔ=${outcome.wsolDelta} RISEΔ=${outcome.riseDelta} net=${fmt(outcome.netLamports)} SOL (session ${fmt(this.sessionNetLamports)})`);
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
