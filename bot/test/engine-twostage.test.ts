// Two-stage optimizer (approximate shortlist + exact verification), the execution-fee
// policy, and the final min-out with fees + tip. Synthetic venues plus the recorded
// mainnet snapshots in fixtures/bench/ (when present).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { evaluate, optimize, searchDirection, domainFor, type OptimizerParams, type Venues } from "../src/engine/optimizer.js";
import { chooseExecutionFees, minGrossForNet, netAfterExecution, type ExecFeePolicy } from "../src/engine/fees.js";
import { buildArbTx, finalMinOut } from "../src/engine/tx.js";
import type { Direction } from "../src/types.js";
import { BinDlmm, CpDlmm, decodeFakeIx, LinearRise, tokenAccountInfo } from "./engine-fakes.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, REFERENCE_WALLET } from "../src/config.js";
import { ArbEngine } from "../src/engine/engine.js";
import { Ledger } from "../src/engine/ledger.js";
import { BlockhashCache } from "../src/engine/blockhash.js";
import { atasFor } from "../src/engine/setup.js";
import { BENCH_FIXTURE, benchVenues, benchParams, perturb } from "../src/engine/bench.js";

const RPC_POLICY: ExecFeePolicy = { baseFeeLamports: 5_000n, maxPriorityFeeLamports: 50_000n, maxTipLamports: 50_000n, maxShareBps: 1_000n, tipEnabled: false };
const JITO_POLICY: ExecFeePolicy = { ...RPC_POLICY, tipEnabled: true };

/** LinearRise with approximate *Fast quotes (smooth relative error up to `err`) and an exact-call counter. */
class FastLinearRise extends LinearRise {
  exactCalls = 0;
  constructor(priceE9: bigint, feeBps: bigint, public err = 3e-5) { super(priceE9, feeBps); }
  quoteBuy(l: bigint) { this.exactCalls++; return super.quoteBuy(l); }
  quoteSell(r: bigint) { this.exactCalls++; return super.quoteSell(r); }
  private wobble(x: bigint) { return 1 + this.err * Math.sin(Number(x) / 3.7e4 + 0.3); }
  quoteBuyFast(l: bigint) { const y = super.quoteBuy(l); return BigInt(Math.floor(Number(y) * this.wobble(l))); }
  quoteSellFast(r: bigint) { const y = super.quoteSell(r); return BigInt(Math.floor(Number(y) * this.wobble(r))); }
}

/** Constant-product DLMM with a host-fee rebate on the input (2% of the fee, like Meteora's 20% of the 10% protocol share). */
class RebateDlmm extends CpDlmm {
  quoteExactIn(side: "sellRise" | "buyRise", a: bigint) {
    const q = super.quoteExactIn(side, a);
    if (!q) return null;
    const fee = (a * this.feeBps) / 10_000n, hostFee = (fee * 2n) / 100n;
    return { ...q, netIn: a - hostFee, hostFee, lastFeeRate: 12_000_000n };
  }
  quoteExactOut(side: "sellRise" | "buyRise", out: bigint) {
    const q = super.quoteExactOut(side, out);
    if (!q) return null;
    const fee = (q.inp * this.feeBps) / 10_000n, hostFee = (fee * 2n) / 100n;
    return { ...q, netIn: q.inp - hostFee, hostFee, lastFeeRate: 12_000_000n };
  }
  baseFeeRate() { return 10_000_000n; }
}

/** Exhaustive exact search of the gross profit over the optimizer's domain (fake venues: cheap). */
function bruteGross(dir: Direction, v: Venues, p: OptimizerParams): bigint | null {
  const d = domainFor(dir, v, p);
  if (!d) return null;
  let best: bigint | null = null;
  for (let x = d.lo; x <= d.hi; x++) {
    const e = evaluate(dir, v, x, p);
    if (e && e.grossIn <= p.maxLamportsIn && (best === null || e.grossProfit > best)) best = e.grossProfit;
  }
  return best;
}

const NOFLOOR = -(1n << 60n);

test("fee policy: 10% of expected profit, capped per component; tip only when enabled", () => {
  assert.deepEqual(chooseExecutionFees(200_000n, RPC_POLICY), { baseLamports: 5_000n, priorityLamports: 20_000n, tipLamports: 0n, totalLamports: 25_000n });
  assert.deepEqual(chooseExecutionFees(2_000_000n, RPC_POLICY), { baseLamports: 5_000n, priorityLamports: 50_000n, tipLamports: 0n, totalLamports: 55_000n });
  assert.deepEqual(chooseExecutionFees(700_000n, JITO_POLICY), { baseLamports: 5_000n, priorityLamports: 50_000n, tipLamports: 20_000n, totalLamports: 75_000n });
  assert.deepEqual(chooseExecutionFees(10_000_000n, JITO_POLICY), { baseLamports: 5_000n, priorityLamports: 50_000n, tipLamports: 50_000n, totalLamports: 105_000n });
  assert.deepEqual(chooseExecutionFees(700_000n, { ...JITO_POLICY, tipFirst: true }), { baseLamports: 5_000n, priorityLamports: 20_000n, tipLamports: 50_000n, totalLamports: 75_000n });
  // no profit -> base fee only; never negative components
  assert.deepEqual(chooseExecutionFees(-5n, JITO_POLICY), { baseLamports: 5_000n, priorityLamports: 0n, tipLamports: 0n, totalLamports: 5_000n });
  // the caps hold for every gross
  for (const g of [0n, 1n, 99_999n, 123_456n, 499_999n, 500_000n, 1_000_001n, 10n ** 12n]) {
    for (const pol of [RPC_POLICY, JITO_POLICY]) {
      const f = chooseExecutionFees(g, pol);
      assert.ok(f.priorityLamports <= 50_000n && f.tipLamports <= 50_000n);
      assert.ok(f.priorityLamports + f.tipLamports <= (g > 0n ? g / 10n : 0n), `g=${g}`);
      if (!pol.tipEnabled) assert.equal(f.tipLamports, 0n);
    }
  }
  // net is monotone in gross; minGrossForNet is the exact threshold
  let prev = netAfterExecution(0n, JITO_POLICY);
  for (let g = 1n; g < 2_000_000n; g += 9_973n) { const n = netAfterExecution(g, JITO_POLICY); assert.ok(n >= prev); prev = n; }
  for (const pol of [RPC_POLICY, JITO_POLICY]) {
    const g = minGrossForNet(100_000n, pol);
    assert.ok(netAfterExecution(g, pol) >= 100_000n && netAfterExecution(g - 1n, pol) < 100_000n, `g=${g}`);
  }
  assert.equal(minGrossForNet(100_000n, RPC_POLICY), 116_666n); // g - 5000 - floor(g/10) >= 100000
});

test("two-stage vs brute-force exact: synthetic venues, <= 4 exact RISE quotes per direction", () => {
  const bids: [bigint, bigint][] = [];
  const asks: [bigint, bigint][] = [];
  for (let i = 0; i < 40; i++) {
    bids.push([1_080_000_000n - BigInt(i) * 7_000_000n, 3_000n + BigInt((i * 37) % 11) * 500n]);
    asks.push([930_000_000n + BigInt(i) * 7_000_000n, 3_500n + BigInt((i * 53) % 7) * 400n]);
  }
  const cases: { name: string; v: Venues & { rise: FastLinearRise }; p: OptimizerParams }[] = [];
  const P: OptimizerParams = { profitFloor: NOFLOOR, txCost: 0n, maxLamportsIn: 120_000n, minLamportsIn: 1n, legSlippageBps: 0n };
  for (const err of [0, 1e-5, 3e-5, 1e-4]) {
    cases.push({ name: `bins err=${err}`, v: { rise: new FastLinearRise(1_000_000_000n, 30n, err), dlmm: new BinDlmm(bids, asks, 10n, 37n) }, p: P });
    cases.push({ name: `cp-sell err=${err}`, v: { rise: new FastLinearRise(1_000_000_000n, 10n, err), dlmm: new RebateDlmm(1_000_000n, 900_000n, 25n) }, p: { ...P, maxLamportsIn: 300_000n } });
    cases.push({ name: `cp-buy err=${err}`, v: { rise: new FastLinearRise(1_000_000_000n, 10n, err), dlmm: new RebateDlmm(1_000_000n, 1_150_000n, 25n) }, p: { ...P, maxLamportsIn: 300_000n } });
  }
  for (const c of cases) {
    for (const dir of ["mintThenSell", "buyThenRedeem"] as Direction[]) {
      const b = bruteGross(dir, c.v, c.p);
      c.v.rise.exactCalls = 0;
      const r = searchDirection(dir, c.v, c.p);
      assert.ok(r.exactEvals <= 4, `${c.name} ${dir}: ${r.exactEvals} exact`);
      assert.ok(c.v.rise.exactCalls <= 4, `${c.name} ${dir}: ${c.v.rise.exactCalls} exact calls`);
      if (b === null) { assert.equal(r.bestExact, null); continue; }
      assert.ok(r.bestExact, `${c.name} ${dir}`);
      // within 3 lamports or 0.01% of the brute-force optimum (approximation error up to 1e-4)
      const tol = 3n + (b > 0n ? b / 10_000n : 0n);
      assert.ok(r.bestExact!.grossProfit >= b - tol, `${c.name} ${dir}: two-stage ${r.bestExact!.grossProfit} vs brute ${b}`);
    }
  }
});

test("two-stage skips a direction without exact quotes when even the optimistic estimate misses the floor", () => {
  const v = { rise: new FastLinearRise(1_000_000_000n, 30n, 1e-5), dlmm: new RebateDlmm(1_000_000_000_000n, 1_000_000_000_000n, 25n) };
  const p: OptimizerParams = { profitFloor: 100_000n, txCost: 0n, fees: RPC_POLICY, maxLamportsIn: 100_000_000n, minLamportsIn: 1_000_000n, legSlippageBps: 0n };
  v.rise.exactCalls = 0;
  const r = optimize(v, p);
  assert.equal(r.best, null);
  assert.ok(r.details.mintThenSell.skipped && r.details.buyThenRedeem.skipped);
  assert.equal(v.rise.exactCalls, 0);
});

test("net objective: buyThenRedeem pays DLMM netIn (gross − host rebate); mintThenSell reports the RISE rebate as residual, not profit", () => {
  const v = { rise: new FastLinearRise(1_000_000_000n, 10n, 0), dlmm: new RebateDlmm(1_000_000_000_000n, 1_060_000_000_000n, 25n) };
  const p: OptimizerParams = { profitFloor: 100_000n, txCost: 0n, fees: RPC_POLICY, maxLamportsIn: 100_000_000n, minLamportsIn: 1_000_000n, legSlippageBps: 0n };
  const b = evaluate("buyThenRedeem", v, 50_000_000_000n, p)!;
  const q = v.dlmm.quoteExactOut("buyRise", 50_000_000_000n)!;
  assert.equal(b.grossIn, q.inp);
  assert.equal(b.lamportsIn, q.netIn);
  assert.equal(b.hostRebate, q.hostFee);
  assert.equal(b.grossProfit, b.lamportsOut - q.netIn);
  assert.equal(b.expectedProfit, b.grossProfit - chooseExecutionFees(b.grossProfit, RPC_POLICY).totalLamports);
  assert.equal(b.riseResidual, 0n);
  // rate above base -> part of the rebate is at risk and padded into the min-out
  assert.ok(b.minOutPad > 0n && b.minOutPad < q.hostFee, `pad ${b.minOutPad} host ${q.hostFee}`);
  const v2 = { rise: new FastLinearRise(1_000_000_000n, 10n, 0), dlmm: new RebateDlmm(1_000_000_000_000n, 950_000_000_000n, 25n) };
  const m = evaluate("mintThenSell", v2, 50_000_000n, p)!;
  const qi = v2.dlmm.quoteExactIn("sellRise", m.rise)!;
  assert.equal(m.lamportsIn, 50_000_000n);
  assert.equal(m.grossProfit, qi.out - 50_000_000n); // rebate (RISE) not in the SOL profit
  assert.equal(m.riseResidual, qi.hostFee);
  assert.equal(m.minOutPad, 0n);
});

test("final min-out = lamportsIn + pad + base + priority + tip + floor, with the tip ix; a landed tx nets >= floor", () => {
  const user = Keypair.generate();
  const tipAccount = PublicKey.unique();
  for (const [dir, dlmm] of [["mintThenSell", new RebateDlmm(1_000_000_000_000n, 950_000_000_000n, 25n)], ["buyThenRedeem", new RebateDlmm(1_000_000_000_000n, 1_060_000_000_000n, 25n)]] as const) {
    const v = { rise: new FastLinearRise(1_000_000_000n, 10n, 2e-5), dlmm };
    const p: OptimizerParams = { profitFloor: 100_000n, txCost: 0n, fees: JITO_POLICY, maxLamportsIn: 100_000_000n, minLamportsIn: 1_000_000n, legSlippageBps: 0n };
    const plan = searchDirection(dir, v, p).plan!;
    assert.ok(plan, dir);
    assert.ok(plan.fees.tipLamports > 0n && plan.fees.priorityLamports > 0n);
    assert.equal(plan.txCostLamports, plan.fees.totalLamports);
    const b = buildArbTx(plan, v, { priorityFeeLamports: 0n, baseFeeLamports: 5_000n, user: user.publicKey, profitFloorLamports: 100_000n, cuLimit: 420_000, recentBlockhash: "11111111111111111111111111111111", signer: user, execFees: plan.fees, tipAccount });
    const want = plan.lamportsIn + plan.minOutPad + plan.fees.totalLamports + 100_000n;
    assert.equal(b.finalMinOut, want);
    assert.equal(finalMinOut(plan, 100_000n, plan.fees.totalLamports), want);
    const legs = b.instructions.slice(2, 4).map(decodeFakeIx);
    if (dir === "mintThenSell") assert.deepEqual(legs[1], { tag: 3, args: [plan.rise, want] });
    else { assert.deepEqual(legs[0], { tag: 6, args: [plan.rise, plan.grossIn] }); assert.deepEqual(legs[1], { tag: 2, args: [plan.rise, want] }); }
    const tipIx = b.instructions[4];
    assert.ok(tipIx.programId.equals(SystemProgram.programId));
    assert.equal(tipIx.data.readBigUInt64LE(4), plan.fees.tipLamports);
    assert.ok(tipIx.keys[1].pubkey.equals(tipAccount));
    assert.ok(b.feeLamports <= plan.fees.baseLamports + plan.fees.priorityLamports);
    assert.equal(b.tipLamports, plan.fees.tipLamports);
    // worst landed case: final leg pays exactly the min-out; wSOL spend = lamportsIn + pad
    const net = want - (plan.lamportsIn + plan.minOutPad) - b.feeLamports - b.tipLamports;
    assert.ok(net >= 100_000n, `${dir} net ${net}`);
    // a tip without a tip account is refused (it would not be budgeted consistently)
    assert.throws(() => buildArbTx(plan, v, { priorityFeeLamports: 0n, baseFeeLamports: 5_000n, user: user.publicKey, profitFloorLamports: 100_000n, cuLimit: 420_000, recentBlockhash: "11111111111111111111111111111111", execFees: plan.fees }), /tip account/);
  }
});

test("recorded mainnet snapshots: two-stage best within a tiny tolerance of dense brute-force exact", { skip: !fs.existsSync(BENCH_FIXTURE) && "no fixtures/bench/snapshots.json.gz (run bench.ts record)" }, () => {
  const { snaps, rise, dlmm } = benchVenues();
  const v: Venues = { rise, dlmm };
  const p = { ...benchParams(), profitFloor: NOFLOOR };
  try {
    // recorded states as-is, plus two with a synthetic competitor swap applied to the real pool (creates arbs)
    const picks: [number, number | null][] = [[0, null], [Math.floor(snaps.length / 2), null], [snaps.length - 1, null], [0, 1], [snaps.length - 1, 3]];
    for (const [i, pert] of picks) {
      const s = snaps[i];
      rise.update(s.slot, s.infos);
      dlmm.update(s.slot, s.infos);
      if (pert !== null) perturb(dlmm, pert);
      rise.prepareFast();
      for (const dir of ["mintThenSell", "buyThenRedeem"] as Direction[]) {
        const before = rise.exactCalls;
        const r = searchDirection(dir, v, p, s.slot);
        assert.ok(rise.exactCalls - before <= 4, `${dir} exact calls ${rise.exactCalls - before}`);
        const d = domainFor(dir, v, p)!;
        // dense exact grid (161 points) + a 41-point exact refinement around the best grid point
        const G = 160n;
        let best = { x: d.lo, g: -(1n << 62n) };
        const at = (x: bigint) => { const e = evaluate(dir, v, x, p); if (e && e.grossProfit > best.g) best = { x, g: e.grossProfit }; };
        for (let k = 0n; k <= G; k++) at(d.lo + ((d.hi - d.lo) * k) / G);
        const step = (d.hi - d.lo) / G;
        const c = best.x;
        for (let k = -20n; k <= 20n; k++) { const x = c + (step * k) / 10n; if (x >= d.lo && x <= d.hi) at(x); }
        assert.ok(r.bestExact, `${dir} slot ${s.slot}`);
        const tol = 20n; // lamports (exact quotes on both sides; differences are integer rounding)
        assert.ok(r.bestExact!.grossProfit >= best.g - tol, `${dir} slot ${s.slot}: two-stage ${r.bestExact!.grossProfit} @${r.bestExact!.lamportsIn} vs brute ${best.g} @${best.x}`);
      }
    }
  } finally {
    rise.close();
  }
});

// ---------------------------------------------------------------- engine hot path


function hotChain(v: { rise: LinearRise; dlmm: CpDlmm }, user: PublicKey, bal: { wsol: bigint; rise: bigint }) {
  const { wsolAta, riseAta } = atasFor(user);
  let slot = 100;
  const calls = { blockhash: 0, sims: [] as VersionedTransaction[] };
  const exec = (tx: VersionedTransaction) => {
    const nb = { ...bal };
    const keys = tx.message.staticAccountKeys;
    for (const ix of tx.message.compiledInstructions) {
      if (keys[ix.programIdIndex].equals(ComputeBudgetProgram.programId)) continue;
      const d = Buffer.from(ix.data);
      const a = d.readBigUInt64LE(1);
      if (d[0] === 1) { nb.wsol -= a; nb.rise += v.rise.quoteBuy(a)!; }
      else if (d[0] === 2) { nb.rise -= a; nb.wsol += v.rise.quoteSell(a)!; }
      else if (d[0] === 3) { nb.rise -= a; nb.wsol += v.dlmm.quoteExactIn("sellRise", a)!.out; }
      else if (d[0] === 6) { nb.wsol -= v.dlmm.quoteExactOut("buyRise", a)!.inp; nb.rise += a; }
    }
    return nb;
  };
  const conn = {
    async getSlot() { return slot; },
    async getMultipleAccountsInfoAndContext(ks: PublicKey[]) {
      return { context: { slot }, value: ks.map((k) => (k.equals(wsolAta) ? tokenAccountInfo(bal.wsol) : k.equals(riseAta) ? tokenAccountInfo(bal.rise) : null)) };
    },
    async getLatestBlockhash() { calls.blockhash++; return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1000 }; },
    async simulateTransaction(tx: VersionedTransaction) {
      calls.sims.push(tx);
      const b = exec(tx);
      const acc = (x: bigint) => ({ data: [tokenAccountInfo(x).data.toString("base64"), "base64"], executable: false, lamports: 1, owner: PublicKey.default.toBase58(), rentEpoch: 0 });
      return { context: { slot }, value: { err: null, logs: [], unitsConsumed: 300_000, accounts: [acc(b.wsol), acc(b.rise)] } };
    },
  };
  return { conn, calls, bump: () => { slot++; } };
}

test("engine hot path: cached blockhash, learned CU skips the pre-sim, plan fees in the min-out", async () => {
  const user = new PublicKey(REFERENCE_WALLET);
  const v = { rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000_000_000n, 950_000_000_000n, 25n) };
  const c = hotChain(v, user, { wsol: 10_000_000_000n, rise: 0n });
  const dir = mkdtempSync(join(tmpdir(), "hot-"));
  try {
    const ledger = new Ledger(join(dir, "l.jsonl"));
    const cfg = { ...loadConfig({ LEDGER_PATH: "/dev/null", RISK_STATE_PATH: join(dir, "risk.json"), KILL_FILE: join(dir, "STOP") } as NodeJS.ProcessEnv), user, tickLatencyRows: true };
    const eng = new ArbEngine({ conn: c.conn as never, ...v, cfg, ledger, log: () => {} });
    const r1 = await eng.tick();
    assert.equal(r1.status, "simulated");
    assert.equal(c.calls.sims.length, 2); // first time: pre-sim measures CU
    const plan = r1.plan!;
    assert.equal(plan.txCostLamports, plan.fees.totalLamports);
    assert.ok(plan.fees.priorityLamports <= 50_000n && plan.fees.tipLamports === 0n); // plain RPC delivery: no tip
    c.bump();
    const r2 = await eng.tick();
    assert.equal(r2.status, "simulated");
    assert.equal(c.calls.sims.length, 3); // learned CU: the ready tx is final, one sim
    const finalCu = Buffer.from(c.calls.sims[2].message.compiledInstructions[0].data).readUInt32LE(1);
    assert.equal(finalCu, Math.ceil(Math.ceil(300_000 * 1.1) * 1.15));
    assert.equal(c.calls.blockhash, 1); // background cache: one fetch for both ticks
    const rows = Ledger.read(ledger.path).filter((e) => e.type === "latency" && e.kind === "tick");
    assert.equal(rows.length, 2);
    assert.ok(typeof rows[1].builtMs === "number" && typeof rows[1].dataToBuiltMs === "number");
    eng.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("BlockhashCache: serves the cached value until stale, then fetches synchronously", async () => {
  let now = 0, n = 0;
  const bc = new BlockhashCache({ async getLatestBlockhash() { n++; return { blockhash: `h${n}`, lastValidBlockHeight: n }; } } as never, { staleMs: 1000, now: () => now });
  assert.equal(bc.get(), null);
  assert.equal((await bc.getOrFetch()).blockhash, "h1");
  now = 500;
  assert.equal((await bc.getOrFetch()).blockhash, "h1");
  assert.equal(n, 1);
  now = 1600;
  assert.equal(bc.get(), null);
  assert.equal((await bc.getOrFetch()).blockhash, "h2");
  assert.equal(bc.syncFetches, 2);
});
