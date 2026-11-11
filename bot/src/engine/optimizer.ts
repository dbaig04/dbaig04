// Trade-size optimizer, two-stage:
//
//  1. Shortlist on an approximate objective: RISE *Fast quotes (interpolated grid, built
//     once per RISE state change) + exact DLMM quotes (synchronous bigint, µs). Coarse grid
//     -> golden-section refinement in the brackets of the best few grid points. If even the
//     optimistic approximate best cannot reach the net-profit floor, the direction is skipped
//     without a single exact RISE call.
//  2. Verify the best few candidates with exact RISE quotes (LiteSVM, ~1-2 ms each), then
//     re-centre each once on a locally corrected model (approx scaled by exact/approx at the
//     candidate) and verify that point too. At most `maxExact` exact RISE quotes per direction.
//
// Objective: NET profit after protocol fees, price impact, DLMM host-fee rebate and
// execution costs (base + priority + tip, chosen by fees.ts from the expected gross profit;
// net is monotone in gross, so the search maximizes gross and the policy is applied after).
// Without fast quotes (synthetic venues) stage 1 runs the full exact search below.
import type { PublicKey } from "@solana/web3.js";
import type { Direction, DlmmVenue, Opportunity, RiseVenue } from "../types.js";
import { chooseExecutionFees, minGrossForNet, type ExecFeePolicy, type ExecFees } from "./fees.js";

export const BPS = 10_000n;

export interface OptimizerParams {
  /** Required min expected NET profit (after all execution costs). */
  profitFloor: bigint;
  /** Fixed execution cost (base + priority) used when `fees` is not given. */
  txCost: bigint;
  /** Execution-cost policy (base + priority + tip as a function of gross profit). Overrides txCost. */
  fees?: ExecFeePolicy;
  /** Upper bound on lamports pulled by leg 1: min(max trade, available wSOL, max wSOL). */
  maxLamportsIn: bigint;
  /** Lower bound on lamports spent in leg 1. */
  minLamportsIn: bigint;
  /** Slippage applied to the intermediate leg (0 = exact quoted amount). */
  legSlippageBps: bigint;
}

/** An Opportunity plus what the tx builder needs to reproduce it exactly. */
export interface Plan extends Opportunity {
  /**
   * mintThenSell: RISE quoted by the Buy (leg-1 min out is derived from it).
   * buyThenRedeem: NET lamports quoted for the exact-out DLMM buy (gross − host-fee rebate,
   * before slippage). lamportsIn − leg1Quote is the slippage padding.
   */
  leg1Quote: bigint;
  /** DLMM bin arrays returned by the quote used for the DLMM leg. */
  binArrays: PublicKey[];
  /** Lamports leg 1 may pull from the wSOL ATA before any rebate (mintThenSell: the buy input; buyThenRedeem: DLMM max-in). */
  grossIn: bigint;
  /** lamportsOut − lamportsIn: profit after protocol fees and price impact, before execution costs. */
  grossProfit: bigint;
  /** Execution costs chosen for this plan (txCostLamports = fees.totalLamports). */
  fees: ExecFees;
  /** DLMM host-fee rebate in the DLMM input token (RISE for mintThenSell, lamports for buyThenRedeem). */
  hostRebate: bigint;
  /** RISE expected to be left over in the RISE ATA (mintThenSell: host rebate + slippage pad). Not counted as profit. */
  riseResidual: bigint;
  /**
   * Extra lamports added to the final min-out on top of lamportsIn + fees + floor
   * (buyThenRedeem: the part of the SOL host rebate that a fee-rate drop between quote and
   * landing could take away, + per-bin rounding). 0 for mintThenSell.
   */
  minOutPad: bigint;
}

/** Optional approximate RISE quotes (RiseNative implements them). */
export interface FastRise {
  quoteBuyFast(lamportsIn: bigint): bigint | null;
  quoteSellFast(riseIn: bigint): bigint | null;
}

/** Optional extra DLMM quote fields (MeteoraDlmm returns them). */
interface DlmmExtras {
  netIn?: bigint;
  hostFee?: bigint;
  lastFeeRate?: bigint;
}

export interface Venues {
  rise: RiseVenue & Partial<FastRise>;
  dlmm: DlmmVenue & { baseFeeRate?(): bigint | null };
}

export const applySlippageDown = (x: bigint, bps: bigint) => (x * (BPS - bps)) / BPS;
export const applySlippageUp = (x: bigint, bps: bigint) => (x * (BPS + bps) + BPS - 1n) / BPS;

type Quote = (x: bigint) => bigint | null;
type EvalParams = Pick<OptimizerParams, "txCost" | "legSlippageBps" | "fees">;

/** Execution costs for a plan with this gross profit. */
export function execFeesFor(gross: bigint, p: Pick<OptimizerParams, "txCost" | "fees">): ExecFees {
  if (p.fees) return chooseExecutionFees(gross, p.fees);
  return { baseLamports: p.txCost, priorityLamports: 0n, tipLamports: 0n, totalLamports: p.txCost };
}

/**
 * Part of a SOL host-fee rebate that is not guaranteed at landing: if every bin's fee rate
 * fell to the base rate, the rebate would shrink by up to host·(rate − base)/rate, and the
 * net spend can rise by at most that much (the exact-out max-in caps the gross). Plus 1
 * lamport per bin array crossed of rounding (per-bin floors), +2.
 */
function rebateAtRisk(host: bigint, lastRate: bigint | undefined, baseRate: bigint | null | undefined, bins: number): bigint {
  if (host <= 0n) return 0n;
  const slack = BigInt(bins) + 2n;
  if (lastRate === undefined || baseRate === undefined || baseRate === null || lastRate <= 0n) return host + slack;
  if (lastRate <= baseRate) return slack;
  return (host * (lastRate - baseRate) + lastRate - 1n) / lastRate + slack;
}

function evalWith(dir: Direction, v: Venues, x: bigint, p: EvalParams, buy: Quote, sell: Quote, slot: number): Plan | null {
  if (x <= 0n) return null;
  if (dir === "mintThenSell") {
    const rq = buy(x);
    if (rq === null || rq <= 0n) return null;
    const rise = applySlippageDown(rq, p.legSlippageBps);
    if (rise <= 0n) return null;
    const q = v.dlmm.quoteExactIn("sellRise", rise) as ({ out: bigint; binArrays: PublicKey[] } & DlmmExtras) | null;
    if (!q) return null;
    const hostRebate = q.netIn !== undefined ? rise - q.netIn : 0n;
    const gross = q.out - x;
    const fees = execFeesFor(gross, p);
    return {
      direction: dir, slot, lamportsIn: x, rise, lamportsOut: q.out,
      expectedProfit: gross - fees.totalLamports, txCostLamports: fees.totalLamports,
      leg1Quote: rq, binArrays: q.binArrays, grossIn: x, grossProfit: gross, fees,
      hostRebate, riseResidual: rq - rise + hostRebate, minOutPad: 0n,
    };
  }
  const q = v.dlmm.quoteExactOut("buyRise", x) as ({ inp: bigint; binArrays: PublicKey[] } & DlmmExtras) | null;
  if (!q || q.inp <= 0n) return null;
  const out = sell(x);
  if (out === null) return null;
  const netIn = q.netIn ?? q.inp;
  const host = q.inp - netIn;
  const maxIn = applySlippageUp(q.inp, p.legSlippageBps);
  const lamportsIn = maxIn - host; // worst-case net spend: max-in pulled, quoted rebate back
  const gross = out - lamportsIn;
  const fees = execFeesFor(gross, p);
  return {
    direction: dir, slot, lamportsIn, rise: x, lamportsOut: out,
    expectedProfit: gross - fees.totalLamports, txCostLamports: fees.totalLamports,
    leg1Quote: netIn, binArrays: q.binArrays, grossIn: maxIn, grossProfit: gross, fees,
    hostRebate: host, riseResidual: 0n,
    minOutPad: rebateAtRisk(host, q.lastFeeRate, v.dlmm.baseFeeRate?.(), q.binArrays.length),
  };
}

/**
 * Evaluate one trade size with EXACT quotes. `lamportsOut − lamportsIn − txCost` is what a
 * landed tx is guaranteed to clear when the final leg's min-out = lamportsIn + minOutPad + fees + floor.
 *  - mintThenSell: x = lamports into RISE Buy.
 *  - buyThenRedeem: x = exact RISE bought on DLMM and redeemed.
 */
export function evaluate(dir: Direction, v: Venues, x: bigint, p: EvalParams, slot = 0): Plan | null {
  return evalWith(dir, v, x, p, (a) => v.rise.quoteBuy(a), (a) => v.rise.quoteSell(a), slot);
}

/** Same with the venue's approximate RISE quotes (exact when the venue has none). */
export function evaluateApprox(dir: Direction, v: Venues, x: bigint, p: EvalParams, slot = 0): Plan | null {
  const r = v.rise;
  const buy: Quote = r.quoteBuyFast ? (a) => r.quoteBuyFast!(a) : (a) => r.quoteBuy(a);
  const sell: Quote = r.quoteSellFast ? (a) => r.quoteSellFast!(a) : (a) => r.quoteSell(a);
  return evalWith(dir, v, x, p, buy, sell, slot);
}

/** Feasible = clears the floor including the min-out pad, within the input cap. */
export function feasible(plan: Plan | null, p: Pick<OptimizerParams, "profitFloor" | "maxLamportsIn">): plan is Plan {
  return !!plan && plan.grossIn <= p.maxLamportsIn && plan.expectedProfit - plan.minOutPad >= p.profitFloor;
}

export interface MaximizeOptions {
  gridPoints?: number;
  refineTop?: number;
  maxLocalIters?: number;
  /** Half-width of the final exhaustive integer scan around the best point. */
  finalWindow?: number;
}

const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Coarse log+linear grid, then golden-section refinement in the brackets of the top-K grid
 * points. Returns each bracket's best point (deduped, best first) and the memo of all evals.
 */
export function maximizeCandidates(f: (x: bigint) => bigint | null, lo: bigint, hi: bigint, o: MaximizeOptions = {}) {
  if (lo < 1n) lo = 1n;
  const memo = new Map<bigint, bigint | null>();
  const F = (x: bigint): bigint | null => {
    if (x < lo) x = lo;
    if (x > hi) x = hi;
    if (memo.has(x)) return memo.get(x)!;
    const val = f(x);
    memo.set(x, val);
    return val;
  };
  if (hi < lo) return { cands: [] as { x: bigint; value: bigint }[], F, memo };
  const gt = (a: bigint | null, b: bigint | null) => a !== null && (b === null || a > b);
  const N = o.gridPoints ?? 96;
  const K = o.refineTop ?? 5;
  const grid = new Set<bigint>([lo, hi]);
  if (hi - lo <= BigInt(N)) for (let x = lo; x <= hi; x++) grid.add(x);
  else {
    const l = Number(lo), h = Number(hi), r = h / l;
    for (let i = 1; i < N - 1; i++) grid.add(BigInt(Math.round(l * Math.pow(r, i / (N - 1)))));
    // linear points too, so the top of the range is not undersampled
    const L = BigInt(Math.max(4, Math.round(N / 6)));
    for (let i = 1n; i < L; i++) grid.add(lo + ((hi - lo) * i) / L);
  }
  const g = [...grid].filter((x) => x >= lo && x <= hi).sort(cmp);
  const vals = g.map(F);
  const order = g.map((_, i) => i).filter((i) => vals[i] !== null).sort((a, b) => (gt(vals[a], vals[b]) ? -1 : gt(vals[b], vals[a]) ? 1 : 0));
  const cands: { x: bigint; value: bigint }[] = [];
  for (const i of order.slice(0, K)) {
    let a = g[Math.max(0, i - 1)], b = g[Math.min(g.length - 1, i + 1)];
    let best = { x: g[i], value: vals[i]! };
    const take = (x: bigint) => { const y = F(x); if (y !== null && (y > best.value || (y === best.value && x < best.x))) best = { x, value: y }; return y; };
    while (b - a > 4n) {
      const c = a + ((b - a) * 382n) / 1000n;
      const d = a + ((b - a) * 618n) / 1000n;
      const fc = take(c), fd = take(d);
      if (gt(fd, fc)) a = c;
      else if (gt(fc, fd)) b = d;
      else { a = c; b = d; } // tie (plateau / rounding): keep the middle
    }
    for (let x = a; x <= b; x++) take(x);
    if (!cands.some((c) => c.x === best.x)) cands.push(best);
  }
  cands.sort((p, q) => (q.value > p.value ? 1 : q.value < p.value ? -1 : cmp(p.x, q.x)));
  return { cands, F, memo };
}

/** Maximize an integer function on [lo, hi]. null = infeasible (-inf). Not assumed unimodal. */
export function maximize(f: (x: bigint) => bigint | null, lo: bigint, hi: bigint, o: MaximizeOptions = {}): { x: bigint; value: bigint; evals: number } | null {
  if (lo < 1n) lo = 1n;
  if (hi < lo) return null;
  const N = o.gridPoints ?? 96;
  const { cands, F, memo } = maximizeCandidates(f, lo, hi, o);
  if (cands.length === 0) return null;
  let best = cands[0];
  const take = (x: bigint) => { const y = F(x); if (y !== null && (y > best.value || (y === best.value && x < best.x))) best = { x, value: y }; return y; };
  // integer pattern search around the best point
  let cur = best;
  let step = (hi - lo) / BigInt(N * 8);
  if (step < 1n) step = 1n;
  for (let it = 0; it < (o.maxLocalIters ?? 400) && step >= 1n; it++) {
    let moved = false;
    for (const x of [cur.x - step, cur.x + step]) {
      if (x < lo || x > hi) continue;
      const v = take(x);
      if (v !== null && v > cur.value) { cur = { x, value: v }; moved = true; }
    }
    if (!moved) step /= 2n;
  }
  // exhaustive integer window around the best (integer rounding makes the top jagged)
  const W = BigInt(o.finalWindow ?? 32);
  const c0 = best.x;
  for (let x = c0 - W; x <= c0 + W; x++) if (x >= lo && x <= hi) take(x);
  return { x: best.x, value: best.value, evals: memo.size };
}

/** Largest x in [lo, cap] with pred(x) true, assuming pred is monotone (true then false). */
export function maxFeasible(pred: (x: bigint) => boolean, lo: bigint, cap: bigint): bigint | null {
  if (lo > cap || !pred(lo)) return null;
  let good = lo;
  let bad = cap + 1n;
  for (let probe = lo * 2n; ; probe *= 2n) {
    if (probe >= cap) { if (pred(cap)) return cap; bad = cap; break; }
    if (pred(probe)) good = probe; else { bad = probe; break; }
  }
  while (bad - good > 1n) {
    const m = (good + bad) / 2n;
    if (pred(m)) good = m; else bad = m;
  }
  return good;
}

/** Smallest x in [lo, hi] with pred(x) true (pred monotone false->true). */
export function minFeasible(pred: (x: bigint) => boolean, lo: bigint, hi: bigint): bigint | null {
  if (lo > hi || !pred(hi)) return null;
  if (pred(lo)) return lo;
  let bad = lo, good = hi;
  while (good - bad > 1n) {
    const m = (good + bad) / 2n;
    if (pred(m)) good = m; else bad = m;
  }
  return good;
}

export interface TwoStageOptions {
  /** Max exact RISE quotes per direction in stage 2 (default 4). */
  maxExact?: number;
  /** Candidates from stage 1 to verify (default 2). */
  verifyTop?: number;
  /** Approximation error allowance for the skip test and candidate filter: lamports + bps of max input. */
  approxMarginLamports?: bigint;
  approxMarginBps?: bigint;
  /** Stage-1 search options (approximate objective). */
  stage1?: MaximizeOptions;
  /** Search options when there are no fast quotes (exact search). */
  exact?: MaximizeOptions;
}

export interface DirectionResult {
  /** Best feasible plan, or null. */
  plan: Plan | null;
  /** Best exactly-verified plan even if it misses the floor (diagnostics); null when skipped. */
  bestExact: Plan | null;
  /** Best approximate gross profit from stage 1 (null when nothing was quotable). */
  approxGross: bigint | null;
  /** Skipped after stage 1: even the optimistic approximate best cannot reach the floor. */
  skipped: boolean;
  /** RISE quote calls made in stage 2 (exact) and approximate evaluations in stage 1. */
  exactEvals: number;
  approxEvals: number;
  /** Search domain (lamports for mintThenSell, RISE for buyThenRedeem). */
  lo?: bigint;
  hi?: bigint;
}

const STAGE1: MaximizeOptions = { gridPoints: 40, refineTop: 3 };

/** Search domain for a direction (DLMM-only probes for buyThenRedeem; µs each). */
export function domainFor(dir: Direction, v: Venues, p: OptimizerParams): { lo: bigint; hi: bigint } | null {
  if (p.maxLamportsIn < p.minLamportsIn || p.maxLamportsIn <= 0n) return null;
  if (dir === "mintThenSell") return { lo: p.minLamportsIn > 0n ? p.minLamportsIn : 1n, hi: p.maxLamportsIn };
  // domain is RISE amount; bound it so the gross lamports pulled stays within limits
  const cost = (r: bigint) => { const q = v.dlmm.quoteExactOut("buyRise", r); return q ? applySlippageUp(q.inp, p.legSlippageBps) : null; };
  const hi = maxFeasible((r) => { const c = cost(r); return c !== null && c <= p.maxLamportsIn; }, 1n, 1n << 80n);
  if (hi === null) return null;
  const lo = minFeasible((r) => { const c = cost(r); return c !== null && c >= p.minLamportsIn; }, 1n, hi);
  if (lo === null) return null;
  return { lo, hi };
}

/** Full result for one direction (two-stage when the RISE venue has fast quotes). */
export function searchDirection(dir: Direction, v: Venues, p: OptimizerParams, slot = 0, o: TwoStageOptions = {}): DirectionResult {
  const res: DirectionResult = { plan: null, bestExact: null, approxGross: null, skipped: false, exactEvals: 0, approxEvals: 0 };
  const dom = domainFor(dir, v, p);
  if (!dom) return res;
  const { lo, hi } = dom;
  res.lo = lo;
  res.hi = hi;
  const hasFast = dir === "mintThenSell" ? !!v.rise.quoteBuyFast : !!v.rise.quoteSellFast;
  const better = (a: Plan | null, b: Plan | null) => !!a && (!b || a.expectedProfit > b.expectedProfit || (a.expectedProfit === b.expectedProfit && a.lamportsIn < b.lamportsIn));

  if (!hasFast) {
    // exact objective is cheap (synthetic venues): full exact search
    const r = maximize((x) => evaluate(dir, v, x, p)?.grossProfit ?? null, lo, hi, o.exact);
    res.approxEvals = r?.evals ?? 0;
    if (!r) return res;
    res.approxGross = r.value;
    const plan = evaluate(dir, v, r.x, p, slot);
    res.bestExact = plan;
    res.plan = feasible(plan, p) ? plan : null;
    return res;
  }

  // ---- stage 1: approximate objective ----
  const fA = (x: bigint) => evaluateApprox(dir, v, x, p)?.grossProfit ?? null;
  const s1 = maximizeCandidates(fA, lo, hi, o.stage1 ?? STAGE1);
  res.approxEvals = s1.memo.size;
  if (s1.cands.length === 0) return res;
  const bestA = s1.cands[0].value;
  res.approxGross = bestA;
  // error allowance of the approximation, in lamports of profit
  const topLamports = dir === "mintThenSell" ? hi : p.maxLamportsIn;
  const margin = (o.approxMarginLamports ?? 2_000n) + (topLamports * (o.approxMarginBps ?? 2n)) / BPS;
  const needGross = p.fees ? minGrossForNet(p.profitFloor, p.fees) : p.profitFloor + p.txCost;
  if (bestA + margin < needGross) { res.skipped = true; return res; }

  // ---- stage 2: exact verification of the best few candidates ----
  const maxExact = o.maxExact ?? 4;
  const cands = s1.cands.slice(0, o.verifyTop ?? 2).filter((c) => c.value + 2n * margin >= bestA);
  const seen = new Map<bigint, Plan | null>();
  const exact = (x: bigint): Plan | null => {
    if (seen.has(x)) return seen.get(x)!;
    if (res.exactEvals >= maxExact) return null;
    res.exactEvals++;
    const pl = evaluate(dir, v, x, p, slot);
    seen.set(x, pl);
    if (better(pl, res.bestExact)) res.bestExact = pl;
    return pl;
  };
  // per-candidate local correction: scale the approximate RISE quote by exact/approx at the candidate
  const fastQ = dir === "mintThenSell" ? v.rise.quoteBuyFast!.bind(v.rise) : v.rise.quoteSellFast!.bind(v.rise);
  for (const c of cands) {
    if (res.exactEvals >= maxExact) break;
    const e = exact(c.x);
    if (!e || res.exactEvals >= maxExact) continue;
    const exactRise = dir === "mintThenSell" ? e.leg1Quote : e.lamportsOut;
    const approxRise = fastQ(c.x);
    if (approxRise === null || approxRise <= 0n || approxRise === exactRise) continue;
    const corr: Quote = (a) => { const y = fastQ(a); return y === null ? null : (y * exactRise) / approxRise; };
    const buy: Quote = dir === "mintThenSell" ? corr : (a) => v.rise.quoteBuy(a);
    const sell: Quote = dir === "mintThenSell" ? (a) => v.rise.quoteSell(a) : corr;
    // re-maximize locally (± a few % of the domain around the candidate) on the corrected model
    const w = (hi - lo) / 20n + 64n;
    const a0 = c.x - w < lo ? lo : c.x - w, b0 = c.x + w > hi ? hi : c.x + w;
    const local = maximize((x) => evalWith(dir, v, x, p, buy, sell, slot)?.grossProfit ?? null, a0, b0, { gridPoints: 16, refineTop: 2, maxLocalIters: 64, finalWindow: 0 });
    if (local) { res.approxEvals += local.evals; if (local.x !== c.x) exact(local.x); }
  }
  res.plan = feasible(res.bestExact, p) ? res.bestExact : null;
  return res;
}

/** Best plan for one direction, or null if none clears the profit floor. */
export function optimizeDirection(dir: Direction, v: Venues, p: OptimizerParams, slot = 0, o?: TwoStageOptions): Plan | null {
  return searchDirection(dir, v, p, slot, o).plan;
}

export interface OptimizeResult {
  best: Plan | null;
  byDirection: Record<Direction, Plan | null>;
  details: Record<Direction, DirectionResult>;
}

/** Best plan across both directions. */
export function optimize(v: Venues, p: OptimizerParams, slot = 0, o?: TwoStageOptions): OptimizeResult {
  const details = {
    mintThenSell: searchDirection("mintThenSell", v, p, slot, o),
    buyThenRedeem: searchDirection("buyThenRedeem", v, p, slot, o),
  };
  const byDirection = { mintThenSell: details.mintThenSell.plan, buyThenRedeem: details.buyThenRedeem.plan };
  const cands = Object.values(byDirection).filter((x): x is Plan => x !== null);
  cands.sort((a, b) => (a.expectedProfit > b.expectedProfit ? -1 : a.expectedProfit < b.expectedProfit ? 1 : 0));
  return { best: cands[0] ?? null, byDirection, details };
}
