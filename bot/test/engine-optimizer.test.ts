import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, maximize, maxFeasible, minFeasible, optimize, optimizeDirection, type OptimizerParams, type Venues } from "../src/engine/optimizer.js";
import type { Direction } from "../src/types.js";
import { BinDlmm, CpDlmm, LinearRise } from "./engine-fakes.js";

const P0: OptimizerParams = { profitFloor: 0n, txCost: 0n, maxLamportsIn: 300_000n, minLamportsIn: 1n, legSlippageBps: 0n };

/** Exhaustive search over the same domain the optimizer uses. */
function brute(dir: Direction, v: Venues, p: OptimizerParams): { x: bigint; profit: bigint } | null {
  let best: { x: bigint; profit: bigint } | null = null;
  const consider = (x: bigint) => {
    const e = evaluate(dir, v, x, p);
    if (!e || e.lamportsIn > p.maxLamportsIn || e.lamportsIn < p.minLamportsIn) return;
    if (!best || e.expectedProfit > best.profit) best = { x, profit: e.expectedProfit };
  };
  if (dir === "mintThenSell") for (let x = p.minLamportsIn; x <= p.maxLamportsIn; x++) consider(x);
  else for (let x = 1n; ; x++) { const e = evaluate(dir, v, x, p); if (!e || e.lamportsIn > p.maxLamportsIn) break; consider(x); }
  return best;
}

test("constant-product mintThenSell matches brute force", () => {
  const v = { rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000n, 900_000n, 25n) };
  const b = brute("mintThenSell", v, P0)!;
  const o = optimizeDirection("mintThenSell", v, P0)!;
  assert.ok(b.profit > 0n);
  assert.equal(o.expectedProfit, b.profit);
  assert.equal(o.lamportsOut - o.lamportsIn - o.txCostLamports, o.expectedProfit);
});

test("constant-product buyThenRedeem matches brute force", () => {
  const v = { rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000n, 1_150_000n, 25n) };
  const b = brute("buyThenRedeem", v, P0)!;
  const o = optimizeDirection("buyThenRedeem", v, P0)!;
  assert.ok(b.profit > 0n);
  // The integer top is a ~1000-wide plateau of ±1-lamport rounding noise; within 2 lamports is optimal.
  assert.ok(b.profit - o.expectedProfit <= 2n, `optimizer ${o.expectedProfit} vs brute ${b.profit}`);
  assert.ok(o.lamportsIn <= P0.maxLamportsIn);
});

test("stepwise bins with per-bin dust fee: within 0.1% of brute force, both directions", () => {
  // bids above mint price for a few bins, then below
  const bids: [bigint, bigint][] = [];
  const asks: [bigint, bigint][] = [];
  for (let i = 0; i < 40; i++) {
    bids.push([1_080_000_000n - BigInt(i) * 7_000_000n, 3_000n + BigInt((i * 37) % 11) * 500n]);
    asks.push([930_000_000n + BigInt(i) * 7_000_000n, 3_500n + BigInt((i * 53) % 7) * 400n]);
  }
  const v = { rise: new LinearRise(1_000_000_000n, 30n), dlmm: new BinDlmm(bids, asks, 10n, 37n) };
  const p = { ...P0, maxLamportsIn: 120_000n };
  for (const dir of ["mintThenSell", "buyThenRedeem"] as Direction[]) {
    const b = brute(dir, v, p)!;
    const o = optimizeDirection(dir, v, p)!;
    assert.ok(b.profit > 0n, dir);
    assert.ok(o, dir);
    assert.ok(o.expectedProfit * 1000n >= b.profit * 999n, `${dir}: optimizer ${o.expectedProfit} vs brute ${b.profit}`);
  }
});

test("maximize finds the global peak of a multimodal function", () => {
  const tri = (x: bigint, c: bigint, w: bigint, h: bigint) => { const d = x > c ? x - c : c - x; return d >= w ? 0n : (h * (w - d)) / w; };
  const f = (x: bigint) => tri(x, 2_000n, 1_500n, 100n) + tri(x, 61_234n, 9_000n, 150n) + (x % 7n === 0n ? 1n : 0n) - 1n;
  const r = maximize(f, 1n, 100_000n)!;
  let best = -1000n;
  for (let x = 1n; x <= 100_000n; x++) { const y = f(x); if (y > best) best = y; }
  assert.equal(r.value, best);
  assert.ok(r.evals < 2_000, `evals ${r.evals}`);
});

test("maximize handles null (infeasible) regions and tiny domains", () => {
  assert.equal(maximize(() => null, 1n, 1000n), null);
  assert.deepEqual(maximize((x) => -x, 5n, 5n)?.x, 5n);
  const r = maximize((x) => (x > 500n ? null : x), 1n, 10_000n)!;
  assert.equal(r.x, 500n);
});

test("profit floor, size caps and no-arb", () => {
  const v = { rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000n, 900_000n, 25n) };
  const o = optimizeDirection("mintThenSell", v, P0)!;
  assert.equal(optimizeDirection("mintThenSell", v, { ...P0, profitFloor: o.expectedProfit + 1n }), null);
  assert.ok(optimizeDirection("mintThenSell", v, { ...P0, profitFloor: o.expectedProfit }));
  // tx cost reduces profit one-for-one
  const withCost = optimizeDirection("mintThenSell", v, { ...P0, txCost: 1000n })!;
  assert.equal(withCost.expectedProfit, o.expectedProfit - 1000n);
  // cap below optimum -> best is at the cap
  const capped = optimizeDirection("mintThenSell", v, { ...P0, maxLamportsIn: 10_000n })!;
  assert.ok(capped.lamportsIn <= 10_000n);
  assert.equal(capped.expectedProfit, evaluate("mintThenSell", v, 10_000n, P0)!.expectedProfit);
  // min trade above everything profitable -> null
  assert.equal(optimizeDirection("mintThenSell", v, { ...P0, minLamportsIn: 250_000n, maxLamportsIn: 300_000n, profitFloor: 1n }), null);
  // aligned prices -> nothing either way
  const flat = { rise: new LinearRise(1_000_000_000n, 30n), dlmm: new CpDlmm(1_000_000n, 1_000_000n, 25n) };
  const r = optimize(flat, { ...P0, profitFloor: 1n });
  assert.equal(r.best, null);
});

test("slippage: leg-2 sells the slippage-reduced RISE, buy max-in is padded", () => {
  const v = { rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000n, 900_000n, 25n) };
  const e = evaluate("mintThenSell", v, 10_000n, { txCost: 0n, legSlippageBps: 100n })!;
  assert.equal(e.rise, (e.leg1Quote * 9900n) / 10000n);
  const v2 = { rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000n, 1_150_000n, 25n) };
  const b = evaluate("buyThenRedeem", v2, 10_000n, { txCost: 0n, legSlippageBps: 100n })!;
  assert.ok(b.lamportsIn > b.leg1Quote);
  assert.equal(b.expectedProfit, b.lamportsOut - b.lamportsIn);
});

test("optimize picks the better direction and the domain helpers", () => {
  const v = { rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000n, 900_000n, 25n) };
  const r = optimize(v, P0);
  assert.equal(r.best?.direction, "mintThenSell");
  assert.equal(r.byDirection.buyThenRedeem, null);
  assert.equal(maxFeasible((x) => x <= 12_345n, 1n, 1n << 40n), 12_345n);
  assert.equal(maxFeasible((x) => x <= 12_345n, 1n, 100n), 100n);
  assert.equal(minFeasible((x) => x >= 777n, 1n, 10_000n), 777n);
});
