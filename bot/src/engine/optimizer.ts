// Trade-size optimizer. Uses the venues' synchronous exact quotes. Profit is not
// assumed unimodal (DLMM bins are discrete, integer rounding, fees): coarse
// log-spaced scan -> golden-section refinement around the best few grid points
// -> integer pattern search around the overall best.
import type { PublicKey } from "@solana/web3.js";
import type { Direction, DlmmVenue, Opportunity, RiseVenue } from "../types.js";

export const BPS = 10_000n;

export interface OptimizerParams {
  /** Required min expected net profit (after txCost). */
  profitFloor: bigint;
  /** Estimated tx cost: base fee + priority fee. */
  txCost: bigint;
  /** Upper bound on lamports spent in leg 1: min(max trade, available wSOL, max wSOL). */
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
   * buyThenRedeem: lamports quoted for the exact-out DLMM buy (before slippage).
   */
  leg1Quote: bigint;
  /** DLMM bin arrays returned by the quote used for the DLMM leg. */
  binArrays: PublicKey[];
}

export interface Venues {
  rise: RiseVenue;
  dlmm: DlmmVenue;
}

export const applySlippageDown = (x: bigint, bps: bigint) => (x * (BPS - bps)) / BPS;
export const applySlippageUp = (x: bigint, bps: bigint) => (x * (BPS + bps) + BPS - 1n) / BPS;

/**
 * Evaluate one trade size. All amounts are conservative (worst case within the
 * configured slippage), so `lamportsOut - lamportsIn - txCost` is what a landed
 * tx is guaranteed to clear when the final leg's min-out = lamportsIn + floor + txCost.
 *  - mintThenSell: x = lamports into RISE Buy.
 *  - buyThenRedeem: x = exact RISE bought on DLMM and redeemed.
 */
export function evaluate(dir: Direction, v: Venues, x: bigint, p: Pick<OptimizerParams, "txCost" | "legSlippageBps">, slot = 0): Plan | null {
  if (x <= 0n) return null;
  if (dir === "mintThenSell") {
    const rq = v.rise.quoteBuy(x);
    if (rq === null || rq <= 0n) return null;
    const rise = applySlippageDown(rq, p.legSlippageBps);
    if (rise <= 0n) return null;
    const q = v.dlmm.quoteExactIn("sellRise", rise);
    if (!q) return null;
    return {
      direction: dir, slot, lamportsIn: x, rise, lamportsOut: q.out,
      expectedProfit: q.out - x - p.txCost, txCostLamports: p.txCost,
      leg1Quote: rq, binArrays: q.binArrays,
    };
  } else {
    const q = v.dlmm.quoteExactOut("buyRise", x);
    if (!q || q.inp <= 0n) return null;
    const out = v.rise.quoteSell(x);
    if (out === null) return null;
    const maxIn = applySlippageUp(q.inp, p.legSlippageBps);
    return {
      direction: dir, slot, lamportsIn: maxIn, rise: x, lamportsOut: out,
      expectedProfit: out - maxIn - p.txCost, txCostLamports: p.txCost,
      leg1Quote: q.inp, binArrays: q.binArrays,
    };
  }
}

export interface MaximizeOptions {
  gridPoints?: number;
  refineTop?: number;
  maxLocalIters?: number;
  /** Half-width of the final exhaustive integer scan around the best point. */
  finalWindow?: number;
}

/** Maximize an integer function on [lo, hi]. null = infeasible (-inf). Not assumed unimodal. */
export function maximize(f: (x: bigint) => bigint | null, lo: bigint, hi: bigint, o: MaximizeOptions = {}): { x: bigint; value: bigint; evals: number } | null {
  if (lo < 1n) lo = 1n;
  if (hi < lo) return null;
  const N = o.gridPoints ?? 96;
  const K = o.refineTop ?? 5;
  const memo = new Map<bigint, bigint | null>();
  let best: { x: bigint; value: bigint } | null = null;
  const F = (x: bigint): bigint | null => {
    if (x < lo) x = lo;
    if (x > hi) x = hi;
    if (memo.has(x)) return memo.get(x)!;
    const val = f(x);
    memo.set(x, val);
    if (val !== null && (best === null || val > best.value || (val === best.value && x < best.x))) best = { x, value: val };
    return val;
  };
  const gt = (a: bigint | null, b: bigint | null) => a !== null && (b === null || a > b);

  // 1. coarse log-spaced grid (plus linear points when the range is small)
  const grid = new Set<bigint>([lo, hi]);
  if (hi - lo <= BigInt(N)) for (let x = lo; x <= hi; x++) grid.add(x);
  else {
    const l = Number(lo), h = Number(hi), r = h / l;
    for (let i = 1; i < N - 1; i++) grid.add(BigInt(Math.round(l * Math.pow(r, i / (N - 1)))));
    // a few linear points too, so the top of the range is not undersampled
    for (let i = 1; i < 16; i++) grid.add(lo + ((hi - lo) * BigInt(i)) / 16n);
  }
  const g = [...grid].filter((x) => x >= lo && x <= hi).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const vals = g.map(F);

  // 2. golden-section refinement in the brackets around the top-K grid points
  const order = g.map((_, i) => i).filter((i) => vals[i] !== null).sort((a, b) => (gt(vals[a], vals[b]) ? -1 : gt(vals[b], vals[a]) ? 1 : 0));
  for (const i of order.slice(0, K)) {
    let a = g[Math.max(0, i - 1)], b = g[Math.min(g.length - 1, i + 1)];
    while (b - a > 4n) {
      const c = a + ((b - a) * 382n) / 1000n;
      const d = a + ((b - a) * 618n) / 1000n;
      const fc = F(c), fd = F(d);
      if (gt(fd, fc)) a = c;
      else if (gt(fc, fd)) b = d;
      else { a = c; b = d; } // tie (plateau / rounding): keep the middle
    }
    for (let x = a; x <= b; x++) F(x);
  }
  if (best === null) return null;

  // 3. integer pattern search around the best point
  let cur: { x: bigint; value: bigint } = best;
  let step = (hi - lo) / BigInt(N * 8);
  if (step < 1n) step = 1n;
  for (let it = 0; it < (o.maxLocalIters ?? 400) && step >= 1n; it++) {
    const cands = [cur.x - step, cur.x + step].filter((x) => x >= lo && x <= hi);
    let moved = false;
    for (const x of cands) {
      const v = F(x);
      if (v !== null && v > cur.value) { cur = { x, value: v }; moved = true; }
    }
    if (!moved) step /= 2n;
  }
  // 4. exhaustive integer window around the best (integer rounding makes the top jagged)
  const W = BigInt(o.finalWindow ?? 32);
  const c0: bigint = (best as { x: bigint }).x;
  for (let x = c0 - W; x <= c0 + W; x++) if (x >= lo && x <= hi) F(x);
  const b: { x: bigint; value: bigint } = best;
  return { x: b.x, value: b.value, evals: memo.size };
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

/** Best plan for one direction, or null if none clears the profit floor. */
export function optimizeDirection(dir: Direction, v: Venues, p: OptimizerParams, slot = 0, o?: MaximizeOptions): Plan | null {
  if (p.maxLamportsIn < p.minLamportsIn || p.maxLamportsIn <= 0n) return null;
  let lo: bigint, hi: bigint;
  if (dir === "mintThenSell") {
    lo = p.minLamportsIn > 0n ? p.minLamportsIn : 1n;
    hi = p.maxLamportsIn;
  } else {
    // domain is RISE amount; bound it so the (worst-case) lamports in stays within limits
    const cost = (r: bigint) => evaluate(dir, v, r, p)?.lamportsIn ?? null;
    const within = (r: bigint) => { const c = cost(r); return c !== null && c <= p.maxLamportsIn; };
    const h = maxFeasible(within, 1n, 1n << 80n);
    if (h === null) return null;
    hi = h;
    const l = minFeasible((r) => { const c = cost(r); return c !== null && c >= p.minLamportsIn; }, 1n, hi);
    if (l === null) return null;
    lo = l;
  }
  const r = maximize((x) => evaluate(dir, v, x, p)?.expectedProfit ?? null, lo, hi, o);
  if (!r) return null;
  const plan = evaluate(dir, v, r.x, p, slot);
  if (!plan || plan.lamportsIn > p.maxLamportsIn) return null;
  if (plan.expectedProfit < p.profitFloor) return null;
  return plan;
}

/** Best plan across both directions. */
export function optimize(v: Venues, p: OptimizerParams, slot = 0): { best: Plan | null; byDirection: Record<Direction, Plan | null> } {
  const byDirection = {
    mintThenSell: optimizeDirection("mintThenSell", v, p, slot),
    buyThenRedeem: optimizeDirection("buyThenRedeem", v, p, slot),
  };
  const cands = Object.values(byDirection).filter((x): x is Plan => x !== null);
  cands.sort((a, b) => (a.expectedProfit > b.expectedProfit ? -1 : a.expectedProfit < b.expectedProfit ? 1 : 0));
  return { best: cands[0] ?? null, byDirection };
}
