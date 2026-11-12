// Generic pair engine (MAX: PumpSwap <-> DLMM) against synthetic SwapVenues.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, AddressLookupTableAccount } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadConfig, type Config } from "../src/config.js";
import { Ledger, toJson } from "../src/engine/ledger.js";
import { bruteForcePair, optimizePair, roundTrip, searchPairDirection, PAIR_DIRECTIONS, type PairParams } from "../src/engine/pair-optimizer.js";
import { buildPairTx, compileFitting, pairFinalMinOut } from "../src/engine/pair.js";
import { PairEngine } from "../src/engine/pair-engine.js";
import { chooseExecutionFees } from "../src/engine/fees.js";
import { BinVenue, CpVenue, ladder, pairChain } from "./pair-fakes.js";

const MAX = new PublicKey("5qaP7oKUqKffwwo5DaEqDoTtsBLMpdbQTxEkCDaTpump");
const policy = { baseFeeLamports: 5_000n, maxPriorityFeeLamports: 50_000n, maxTipLamports: 50_000n, maxShareBps: 1_000n, tipEnabled: false };
const params = (over: Partial<PairParams> = {}): PairParams => ({ profitFloor: 100_000n, fees: policy, maxLamportsIn: 100_000_000n, minLamportsIn: 1_000_000n, ...over });

/** Deterministic PRNG. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// PumpSwap-like CP pool: ~600 SOL / ~X tokens at price `p` lamports per 1e6 token units.
const cp = (p: bigint, sol = 600_000_000_000n, fee = 125n) => new CpVenue("pumpswap:fake", sol, (sol * 1_000_000n) / p, fee);
const bins = (p: bigint, depth = 3_000_000_000n, fee = 100n, rebate = 2n) => new BinVenue("dlmm:fake", ladder(p, 30, 100n, depth), 30, fee, rebate);

test("pair optimizer: two-stage matches dense exact brute force (CP vs bins, both directions, perturbed states)", () => {
  const r = rng(7);
  let checked = 0, skippedOk = 0;
  for (let k = 0; k < 40; k++) {
    const p = 20_000n + BigInt(Math.floor(r() * 5_000));
    const a = cp(p, BigInt(Math.floor(200 + r() * 800)) * 1_000_000_000n, BigInt(20 + Math.floor(r() * 110)));
    const b = bins(p, BigInt(Math.floor(1 + r() * 8)) * 1_000_000_000n, BigInt(25 + Math.floor(r() * 100)), BigInt(Math.floor(r() * 3)));
    // competitor swap moves one pool by up to ~8 SOL in a random direction
    const moved = r() < 0.5 ? a : b;
    const sol = BigInt(Math.floor(r() * 30e9));
    if (r() < 0.5) moved.apply("buy", sol); else moved.apply("sell", (sol * 1_000_000n) / p);
    const pp = params();
    for (const [dir, noBoundSkip] of PAIR_DIRECTIONS.flatMap((d) => [[d, false], [d, true]] as const)) {
      const two = searchPairDirection(dir, { a, b }, pp, 0, { noBoundSkip });
      const bf = bruteForcePair(dir, { a, b }, pp, 4_000, 400);
      if (!bf) continue;
      const got = two.best?.grossProfit ?? -(1n << 62n);
      if (two.skipped) {
        // the bound skip must be sound: the dense best cannot reach the floor either
        const net = bf.gross - chooseExecutionFees(bf.gross, policy).totalLamports;
        assert.ok(net < pp.profitFloor, `skipped ${dir} but brute force nets ${net}`);
        skippedOk++;
        continue;
      }
      // tiny tolerance: 0.001% of the max input or 50 lamports
      const tol = 1_000n;
      assert.ok(got >= bf.gross - tol, `${dir} k=${k}: two-stage ${got} < brute ${bf.gross} - ${tol} (x ${two.best?.grossIn} vs ${bf.x})`);
      checked++;
    }
  }
  assert.ok(checked >= 60, `only ${checked} non-skipped cases`);
  assert.ok(skippedOk >= 1);
});

test("pair optimizer: no price gap => skipped after one round trip; gap => feasible plan in the right direction", () => {
  const a = cp(25_000n), b = bins(25_000n);
  const res = optimizePair({ a, b }, params());
  assert.equal(res.best, null);
  for (const d of PAIR_DIRECTIONS) { assert.equal(res.details[d].skipped, true); assert.equal(res.details[d].screenEvals, 1); }
  // DLMM 3% cheaper: buy on B, sell on A
  const b2 = bins(23_500n);
  const r2 = optimizePair({ a, b: b2 }, params(), 9, undefined, "max");
  assert.ok(r2.best);
  assert.equal(r2.best!.direction, "buyBsellA");
  assert.equal(r2.best!.pair, "max");
  assert.equal(r2.best!.slot, 9);
  assert.ok(r2.best!.grossIn <= 100_000_000n);
  assert.ok(r2.best!.expectedProfit - r2.best!.minOutPad >= 100_000n);
  assert.equal(r2.details.buyAsellB.skipped, true);
  // fees: priority <= 50k, priority+tip <= 10% of gross
  const f = r2.best!.fees;
  assert.ok(f.priorityLamports <= 50_000n && f.priorityLamports + f.tipLamports <= r2.best!.grossProfit / 10n);
  // leg-1 SOL rebate is padded into the final min-out (treated as not guaranteed)
  assert.equal(r2.best!.minOutPad, r2.best!.grossIn - r2.best!.lamportsIn);
});

test("pair optimizer: cap and min trade respected; wSOL balance below min => no plan", () => {
  const a = cp(25_000n), b = bins(23_000n, 50_000_000_000n);
  const r = optimizePair({ a, b }, params({ maxLamportsIn: 40_000_000n }));
  assert.ok(r.best && r.best.grossIn <= 40_000_000n);
  const r0 = optimizePair({ a, b }, params({ maxLamportsIn: 500_000n }));
  assert.equal(r0.best, null);
});

test("pair tx: leg mins, final min-out = lamportsIn + pad + exec + floor; legacy when it fits, v0 + ALT otherwise", () => {
  const a = cp(25_000n), b = bins(23_500n);
  const plan = optimizePair({ a, b }, params()).best!;
  const user = Keypair.generate().publicKey;
  const built = buildPairTx(plan, { a, b }, { user, profitFloorLamports: 100_000n, cuLimit: 200_000, recentBlockhash: "11111111111111111111111111111111", execFees: plan.fees });
  assert.equal(built.version, "legacy");
  assert.equal(built.leg1Limit, plan.token);
  assert.equal(built.finalMinOut, plan.lamportsIn + plan.minOutPad + plan.fees.totalLamports + 100_000n);
  // 2 compute budget + buy (on B) + sell (on A)
  const ixs = built.instructions;
  assert.equal(ixs.length, 4);
  assert.ok(ixs[2].programId.equals(b.programId) && ixs[3].programId.equals(a.programId));
  assert.equal(ixs[2].data.readBigUInt64LE(1), plan.grossIn);
  assert.equal(ixs[2].data.readBigUInt64LE(9), plan.token);
  assert.equal(ixs[3].data.readBigUInt64LE(1), plan.token);
  assert.equal(ixs[3].data.readBigUInt64LE(9), built.finalMinOut);
  assert.ok(built.feeLamports <= plan.fees.baseLamports + plan.fees.priorityLamports);
  assert.throws(() => pairFinalMinOut({ ...plan, lamportsOut: plan.lamportsIn }, 100_000n, plan.fees.totalLamports), /cannot clear floor/);
  // too many accounts for a legacy message: needs a lookup table
  const extra = Array.from({ length: 40 }, () => Keypair.generate().publicKey);
  a.extraAccounts = extra.slice(0, 20); b.extraAccounts = extra.slice(20);
  assert.throws(() => buildPairTx(plan, { a, b }, { user, profitFloorLamports: 100_000n, cuLimit: 200_000, recentBlockhash: "11111111111111111111111111111111", execFees: plan.fees }), /PAIR_LOOKUP_TABLES/);
  const alt = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: extra } });
  const v0 = buildPairTx(plan, { a, b }, { user, profitFloorLamports: 100_000n, cuLimit: 200_000, recentBlockhash: "11111111111111111111111111111111", execFees: plan.fees, lookupTables: [alt] });
  assert.equal(v0.version, 0);
  assert.ok(v0.size <= 1232);
  assert.ok(compileFitting(user, "11111111111111111111111111111111", built.instructions).version === "legacy");
});

function cfgWith(over: Partial<Config> = {}): Config {
  return { ...loadConfig({ LEDGER_PATH: "/dev/null" } as NodeJS.ProcessEnv), ...over };
}

function setup(over: Partial<Config> = {}, opts: { forceSimEveryMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pair-"));
  const ledger = new Ledger(join(dir, "l.jsonl"));
  const user = Keypair.generate().publicKey;
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID);
  const tokenAta = getAssociatedTokenAddressSync(MAX, user, true, TOKEN_2022_PROGRAM_ID);
  const a = cp(25_000n), b = bins(25_000n);
  const ch = pairChain([a, b], wsolAta, tokenAta, { wsol: 1_000_000_000n, tok: 0n });
  const ticks: unknown[] = [];
  const eng = new PairEngine({
    conn: ch.conn as never, cfg: cfgWith(over), ledger, user, log: () => {},
    pair: { name: "max", a, b, tokenMint: MAX, tokenProgram: TOKEN_2022_PROGRAM_ID },
    onTick: (i) => ticks.push(i), forceSimEveryMs: opts.forceSimEveryMs,
  });
  return { eng, a, b, ch, ledger, ticks, done: () => { eng.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("pair engine: no gap => no-opportunity; competitor moves a pool => opportunity, mandatory simulation passes, simulate mode never sends", async () => {
  const s = setup();
  try {
    const r0 = await s.eng.tick("timeout");
    assert.equal(r0.status, "no-opportunity");
    // a competitor sells ~6 SOL worth of tokens into the CP pool: CP price drops, buy A sell B
    s.a.apply("sell", s.a.y / 20n);
    s.ch.bump();
    const r1 = await s.eng.tick("shred:arb");
    assert.equal(r1.status, "simulated", toJson(r1.sim ?? null));
    assert.equal(r1.plan!.direction, "buyAsellB");
    assert.ok(r1.sim!.ok && r1.sim!.simulatedProfit! >= 100_000n);
    // pre-sim (CU) + final sim on the first tick of a direction
    assert.equal(s.ch.sims.length, 2);
    const ticks = s.ticks as { status: string; pollMs?: number; quoteUs?: number; buildMs?: number; preSimMs?: number; finalSimMs?: number; trigger?: string }[];
    const t = ticks.at(-1)!;
    assert.equal(t.status, "simulated");
    assert.equal(t.trigger, "shred:arb");
    for (const k of ["pollMs", "quoteUs", "buildMs", "preSimMs", "finalSimMs"] as const) assert.ok(typeof t[k] === "number", k);
    // second tick on new slot, same state: CU learned => one sim only; optimizer cached
    s.ch.bump();
    const n = s.ch.sims.length;
    const r2 = await s.eng.tick();
    assert.equal(r2.status, "simulated");
    assert.equal(s.ch.sims.length, n + 1);
    const evs = Ledger.read(s.ledger.path);
    assert.ok(evs.some((e) => e.type === "opportunity" && e.pair === "max"));
    assert.ok(!evs.some((e) => e.type === "submission"));
  } finally { s.done(); }
});

test("pair engine: sim mismatch (pool moved after the quote) => final sim rejected", async () => {
  const s = setup();
  try {
    s.a.apply("sell", s.a.y / 20n);
    s.ch.bump();
    await s.eng.tick();
    // the chain moves between snapshot and simulation: patch the fake sim to see a worse CP pool
    const orig = s.a.quoteExactIn.bind(s.a);
    s.ch.bump();
    s.eng.invalidate();
    const realX = s.a.x;
    let calls = 0;
    s.a.quoteExactIn = (side, amt) => { calls++; return orig(side, amt); };
    const origSim = s.ch.conn.simulateTransaction;
    s.ch.conn.simulateTransaction = async (tx, cfg) => { s.a.x = realX * 2n; try { return await origSim(tx, cfg); } finally { s.a.x = realX; } };
    const r = await s.eng.tick();
    assert.equal(r.status, "sim-rejected");
    assert.ok(calls > 0);
  } finally { s.done(); }
});

test("pair engine: forced latency sims (simulate mode) never pass as opportunities", async () => {
  const s = setup({}, { forceSimEveryMs: 1 });
  try {
    const r = await s.eng.tick();
    assert.ok(r.status === "sim-rejected" || r.status === "simulated");
    const t = (s.ticks as { forced?: boolean; sim?: { ok: boolean } }[]).at(-1)!;
    assert.equal(t.forced, true);
    assert.equal(t.sim?.ok, false, "sub-floor forced sim must fail the floor check");
    assert.ok(!Ledger.read(s.ledger.path).some((e) => e.type === "opportunity"));
  } finally { s.done(); }
});

test("pair engine: risk caps apply (gross input over the risk max is never planned)", async () => {
  const s = setup({ maxTradeLamports: 500_000_000n });
  try {
    s.a.apply("sell", s.a.y / 5n);
    s.ch.bump();
    const r = await s.eng.tick();
    assert.ok(r.plan && r.plan.grossIn <= 100_000_000n, `grossIn ${r.plan?.grossIn}`);
  } finally { s.done(); }
});

test("roundTrip: gross = out − netIn; token residual = leg-1 out − leg-2 netIn", () => {
  const a = cp(25_000n), b = bins(24_000n, 3_000_000_000n, 100n, 5n);
  const p = roundTrip("buyBsellA", { a, b }, 50_000_000n, { fees: policy })!;
  assert.equal(p.grossProfit, p.lamportsOut - p.lamportsIn);
  assert.equal(p.tokenResidual, p.token - p.sellQuote.netIn);
  assert.ok(p.lamportsIn < p.grossIn);
});
