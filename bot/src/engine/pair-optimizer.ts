// Trade-size optimizer for a generic two-venue token/SOL round trip (e.g. MAX:
// PumpSwap <-> Meteora DLMM). Venues implement SwapVenue (exact, synchronous quotes).
//
// Round trip for direction (buy on X, sell on Y):
//   leg 1: exact-in BUY on X:  x lamports  -> t tokens   (q1 = X.quoteExactIn("buy", x))
//   leg 2: exact-in SELL on Y: t tokens    -> o lamports (q2 = Y.quoteExactIn("sell", q1.out))
//   gross = o − q1.netIn              (profit before execution costs; SOL rebates of leg 1 included)
//   net   = gross − (base + priority + tip)   (fees.ts chooseExecutionFees, monotone in gross)
//
// Two stages per direction:
//   1. screening, O(1) + coarse: one exact round trip at the minimum size gives the marginal
//      return r = o/netIn. Each venue's output is concave in its input (constant-product /
//      bin walk with non-decreasing price impact), so the round trip's output is concave in x
//      and gross(x) ≤ (r − 1)·x. If r ≤ 1, or (r − 1)·cap cannot reach the gross needed for
//      the net floor, the direction is skipped after ONE round trip. Otherwise a coarse
//      log+linear grid of exact round trips (µs each) brackets the optimum.
//   2. exact refinement of the best brackets: golden-section on exact round trips, integer
//      pattern search, and an exhaustive integer window around the best point.
// The full transaction is then simulated by the engine (pair-engine.ts) before anything else.
import type { SwapQuote, SwapVenue } from "../types.js";
import { chooseExecutionFees, minGrossForNet, type ExecFeePolicy, type ExecFees } from "./fees.js";
import { maximizeCandidates, type MaximizeOptions } from "./optimizer.js";

export type PairDirection = "buyAsellB" | "buyBsellA";
export const PAIR_DIRECTIONS: PairDirection[] = ["buyAsellB", "buyBsellA"];

export interface PairVenues {
  a: SwapVenue;
  b: SwapVenue;
}

export interface PairParams {
  /** Required min expected NET profit (after base + priority + tip). */
  profitFloor: bigint;
  fees: ExecFeePolicy;
  /** Max GROSS lamports leg 1 may spend: min(max trade, wSOL balance, max wSOL). */
  maxLamportsIn: bigint;
  minLamportsIn: bigint;
}

/** A sized round trip, ready for the tx builder. */
export interface PairPlan {
  pair: string;
  direction: PairDirection;
  slot: number;
  buyVenue: string;
  sellVenue: string;
  /** Gross lamports into the leg-1 buy (exact-in amount; the risk cap applies to this). */
  grossIn: bigint;
  /** Actual lamports leg 1 takes from the wSOL account (grossIn − any SOL rebate to the user). */
  lamportsIn: bigint;
  /** Tokens out of leg 1 = leg-1 min-out = exact leg-2 input. */
  token: bigint;
  /** Lamports out of leg 2 (quoted). */
  lamportsOut: bigint;
  /** lamportsOut − lamportsIn. */
  grossProfit: bigint;
  fees: ExecFees;
  /** grossProfit − fees.totalLamports. */
  expectedProfit: bigint;
  txCostLamports: bigint;
  /** Added to the final min-out: the leg-1 SOL rebate (not guaranteed at landing). */
  minOutPad: bigint;
  /** Tokens left in the token account (leg-2 rebate in tokens). Not counted as profit. */
  tokenResidual: bigint;
  buyQuote: SwapQuote;
  sellQuote: SwapQuote;
}

export function venuesFor(dir: PairDirection, v: PairVenues): { buy: SwapVenue; sell: SwapVenue } {
  return dir === "buyAsellB" ? { buy: v.a, sell: v.b } : { buy: v.b, sell: v.a };
}

/**
 * Optional venue hook: the part of a buy quote's SOL rebate (amountIn − netIn) that is NOT
 * guaranteed at landing. Default (hook absent): the whole rebate is treated as at risk.
 */
type RebateAware = { rebateAtRisk?(side: "buy" | "sell", amountIn: bigint, q: SwapQuote): bigint };

/** Exact round trip at x lamports gross in. null = a venue rejects the trade. */
export function roundTrip(dir: PairDirection, v: PairVenues, x: bigint, p: Pick<PairParams, "fees">, slot = 0, pair = ""): PairPlan | null {
  if (x <= 0n) return null;
  const { buy, sell } = venuesFor(dir, v);
  const q1 = buy.quoteExactIn("buy", x);
  if (!q1 || q1.out <= 0n) return null;
  const q2 = sell.quoteExactIn("sell", q1.out);
  if (!q2) return null;
  const gross = q2.out - q1.netIn;
  const fees = chooseExecutionFees(gross, p.fees);
  const rebate = x - q1.netIn;
  const hook = (buy as SwapVenue & RebateAware).rebateAtRisk;
  const pad = rebate <= 0n ? 0n : hook ? hook.call(buy, "buy", x, q1) : rebate;
  return {
    pair, direction: dir, slot, buyVenue: buy.name, sellVenue: sell.name,
    grossIn: x, lamportsIn: q1.netIn, token: q1.out, lamportsOut: q2.out,
    grossProfit: gross, fees, expectedProfit: gross - fees.totalLamports, txCostLamports: fees.totalLamports,
    minOutPad: pad, tokenResidual: q1.out - q2.netIn, buyQuote: q1, sellQuote: q2,
  };
}

/** Clears the floor after the min-out pad, within the cap. */
export function pairFeasible(plan: PairPlan | null, p: Pick<PairParams, "profitFloor" | "maxLamportsIn">): plan is PairPlan {
  return !!plan && plan.grossIn <= p.maxLamportsIn && plan.expectedProfit - plan.minOutPad >= p.profitFloor;
}

export interface PairSearchOptions {
  /** Coarse grid points of stage 1 (default 24). */
  gridPoints?: number;
  /** Brackets refined in stage 2 (default 3). */
  refineTop?: number;
  /** Exhaustive integer window half-width around the best point (default 16). */
  finalWindow?: number;
  /** Disable the concavity bound skip (tests / non-concave venues). */
  noBoundSkip?: boolean;
  /** Slack on the concavity bound for per-bin rounding: lamports + ppm of the cap (default 2,000 + 10 ppm). */
  boundSlackLamports?: bigint;
  boundSlackPpm?: bigint;
}

export interface PairDirectionResult {
  plan: PairPlan | null;
  /** Best plan found even if below the floor (diagnostics). */
  best: PairPlan | null;
  /** Stage 1 skipped the direction (marginal-return bound). */
  skipped: boolean;
  skipReason?: string;
  /** Marginal return at the minimum size, ×1e6. */
  marginalE6?: bigint;
  /** Round trips evaluated in stage 1 / stage 2. */
  screenEvals: number;
  exactEvals: number;
  /** µs spent in stage 1 / stage 2. */
  screenUs: number;
  exactUs: number;
}

const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

export function searchPairDirection(dir: PairDirection, v: PairVenues, p: PairParams, slot = 0, o: PairSearchOptions = {}, pair = ""): PairDirectionResult {
  const res: PairDirectionResult = { plan: null, best: null, skipped: false, screenEvals: 0, exactEvals: 0, screenUs: 0, exactUs: 0 };
  const lo = p.minLamportsIn > 0n ? p.minLamportsIn : 1n;
  const hi = p.maxLamportsIn;
  if (hi < lo) { res.skipped = true; res.skipReason = "no balance / cap below min trade"; return res; }
  const t0 = performance.now();
  const gross = (x: bigint): bigint | null => roundTrip(dir, v, x, p)?.grossProfit ?? null;

  // ---- stage 1a: marginal-return bound (one exact round trip) ----
  const probe = roundTrip(dir, v, lo, p);
  res.screenEvals++;
  const needGross = minGrossForNet(p.profitFloor, p.fees);
  if (probe && probe.lamportsIn > 0n) {
    res.marginalE6 = (probe.lamportsOut * 1_000_000n) / probe.lamportsIn;
    if (!o.noBoundSkip) {
      // concave output: o(x) ≤ r·x  =>  gross(x) ≤ (r − 1)·x ≤ (r − 1)·hi  (+ slack for per-bin rounding)
      const slack = (o.boundSlackLamports ?? 2_000n) + (hi * (o.boundSlackPpm ?? 10n)) / 1_000_000n;
      const bound = ((probe.lamportsOut - probe.lamportsIn) * hi) / probe.lamportsIn + slack;
      if (bound < needGross) {
        res.skipped = true;
        res.skipReason = `marginal return ${Number(res.marginalE6) / 1e6} at ${lo}: bound ${bound} < needed gross ${needGross}`;
        res.best = probe ? { ...probe, slot, pair } : null;
        res.screenUs = (performance.now() - t0) * 1000;
        return res;
      }
    }
  }

  // ---- stage 1b: coarse grid of exact round trips; stage 2: refine the best brackets ----
  const stage: MaximizeOptions = { gridPoints: o.gridPoints ?? 24, refineTop: o.refineTop ?? 3 };
  let nScreen = 0;
  const s = maximizeCandidates((x) => { nScreen++; return gross(x); }, lo, hi, { ...stage, refineTop: 0 });
  // (refineTop: 0 => only the grid is evaluated here)
  res.screenEvals += nScreen;
  const t1 = performance.now();
  res.screenUs = (t1 - t0) * 1000;
  const gridPts = [...s.memo.entries()].filter(([, y]) => y !== null).sort((x, y) => cmp(x[0], y[0])) as [bigint, bigint][];
  if (!gridPts.length) return res;
  const ranked = gridPts.map((g, i) => ({ i, y: g[1] })).sort((a, b) => cmp(b.y, a.y));
  const memo = new Map<bigint, bigint | null>(s.memo);
  let nExact = 0;
  const F = (x: bigint) => {
    if (x < lo) x = lo;
    if (x > hi) x = hi;
    if (memo.has(x)) return memo.get(x)!;
    nExact++;
    const y = gross(x);
    memo.set(x, y);
    return y;
  };
  let best = { x: gridPts[ranked[0].i][0], y: ranked[0].y };
  const take = (x: bigint) => { if (x < lo) x = lo; if (x > hi) x = hi; const y = F(x); if (y !== null && (y > best.y || (y === best.y && x < best.x))) best = { x, y }; return y; };
  const gt = (a: bigint | null, b: bigint | null) => a !== null && (b === null || a > b);
  for (const r of ranked.slice(0, stage.refineTop)) {
    let a = gridPts[Math.max(0, r.i - 1)][0], b = gridPts[Math.min(gridPts.length - 1, r.i + 1)][0];
    while (b - a > 8n) {
      const c = a + ((b - a) * 382n) / 1000n;
      const d = a + ((b - a) * 618n) / 1000n;
      const fc = take(c), fd = take(d);
      if (gt(fd, fc)) a = c; else if (gt(fc, fd)) b = d; else { a = c; b = d; }
    }
    for (let x = a; x <= b; x++) take(x);
  }
  // integer pattern search + exhaustive window (rounding makes the top jagged)
  let step = (hi - lo) / 4096n;
  if (step < 1n) step = 1n;
  for (let it = 0; it < 200 && step >= 1n; it++) {
    const before = best.x;
    take(best.x - step);
    take(best.x + step);
    if (best.x === before) step /= 2n;
  }
  const W = BigInt(o.finalWindow ?? 16);
  const c0 = best.x;
  for (let x = c0 - W; x <= c0 + W; x++) if (x >= lo && x <= hi) take(x);
  res.exactEvals = nExact;
  const plan = roundTrip(dir, v, best.x, p, slot, pair);
  res.best = plan;
  res.plan = pairFeasible(plan, p) ? plan : null;
  res.exactUs = (performance.now() - t1) * 1000;
  return res;
}

export interface PairOptimizeResult {
  best: PairPlan | null;
  byDirection: Record<PairDirection, PairPlan | null>;
  details: Record<PairDirection, PairDirectionResult>;
}

export function optimizePair(v: PairVenues, p: PairParams, slot = 0, o?: PairSearchOptions, pair = ""): PairOptimizeResult {
  const details = {
    buyAsellB: searchPairDirection("buyAsellB", v, p, slot, o, pair),
    buyBsellA: searchPairDirection("buyBsellA", v, p, slot, o, pair),
  };
  const byDirection = { buyAsellB: details.buyAsellB.plan, buyBsellA: details.buyBsellA.plan };
  const c = Object.values(byDirection).filter((x): x is PairPlan => x !== null).sort((a, b) => cmp(b.expectedProfit, a.expectedProfit));
  return { best: c[0] ?? null, byDirection, details };
}

/** Dense exact brute force (tests / audits): `points` evenly spaced sizes + integer window around the best. */
export function bruteForcePair(dir: PairDirection, v: PairVenues, p: PairParams, points = 20_000, window = 2_000): { x: bigint; gross: bigint } | null {
  const lo = p.minLamportsIn > 0n ? p.minLamportsIn : 1n, hi = p.maxLamportsIn;
  if (hi < lo) return null;
  let best: { x: bigint; gross: bigint } | null = null;
  const take = (x: bigint) => {
    const g = roundTrip(dir, v, x, p)?.grossProfit;
    if (g !== undefined && (!best || g > best.gross)) best = { x, gross: g };
  };
  const n = BigInt(points);
  for (let i = 0n; i <= n; i++) take(lo + ((hi - lo) * i) / n);
  const b0 = best as { x: bigint; gross: bigint } | null;
  if (b0) {
    const step = (hi - lo) / n;
    const w = step + BigInt(window);
    const inc = w / BigInt(window) > 0n ? w / BigInt(window) : 1n;
    for (let x = b0.x - w; x <= b0.x + w; x += inc) if (x >= lo && x <= hi) take(x);
  }
  return best;
}
