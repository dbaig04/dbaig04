// Replay of recorded mainnet MAX snapshots (PumpSwap Eoe22Hd… + DLMM H6Bcgds…) through the real venues.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { createMaxVenues } from "../src/engine/pair-venues.js";
import type { SwapVenue } from "../src/types.js";

const DIR = "test/fixtures/pair";
type Fx = { slot: number; accounts: Record<string, { owner: string; lamports: number; executable: boolean; data: string } | null> };
const fixtures = readdirSync(DIR).filter((f) => f.endsWith(".json.gz")).map((f) => JSON.parse(gunzipSync(readFileSync(join(DIR, f))).toString()) as Fx);

function load(fx: Fx) {
  const v = createMaxVenues();
  const infos = new Map<string, AccountInfo<Buffer> | null>(Object.entries(fx.accounts).map(([k, a]) => [k, a ? { owner: new PublicKey(a.owner), lamports: a.lamports, executable: a.executable, data: Buffer.from(a.data, "base64"), rentEpoch: 0 } : null]));
  for (let i = 0; i < 3; i++) { v.pumpswap.update(fx.slot, infos); v.dlmm.update(fx.slot, infos); }
  return v;
}

test("replay: recorded MAX snapshots load into both real venues and quote both ways", () => {
  assert.ok(fixtures.length >= 1);
  for (const fx of fixtures) {
    const { pumpswap, dlmm } = load(fx);
    assert.ok(pumpswap.ready() && dlmm.ready(), `slot ${fx.slot}: venues not ready`);
    for (const v of [pumpswap, dlmm] as SwapVenue[]) {
      const b = v.quoteExactIn("buy", 50_000_000n)!;
      assert.ok(b && b.out > 0n && b.netIn <= 50_000_000n, v.name);
      const s = v.quoteExactIn("sell", b.out)!;
      assert.ok(s && s.out > 0n && s.out < 50_000_000n, `${v.name}: same-venue round trip must lose to fees`);
    }
  }
});

import { bruteForcePair, PAIR_DIRECTIONS, searchPairDirection, type PairParams } from "../src/engine/pair-optimizer.js";
import { chooseExecutionFees } from "../src/engine/fees.js";

const policy = { baseFeeLamports: 5_000n, maxPriorityFeeLamports: 50_000n, maxTipLamports: 50_000n, maxShareBps: 1_000n, tipEnabled: false };
const params: PairParams = { profitFloor: 100_000n, fees: policy, maxLamportsIn: 100_000_000n, minLamportsIn: 1_000_000n };

/** Synthetic competitor swap on the PumpSwap pool, applied to its cached reserves. */
function moveCp(fx: Fx, side: "buy" | "sell", lamports: bigint) {
  const v = load(fx);
  const amt = side === "buy" ? lamports : v.pumpswap.quoteExactIn("buy", lamports)?.out;
  const q = amt ? v.pumpswap.quoteExactIn(side, amt) : null;
  if (q) v.pumpswap.applyQuote(q);
  return v;
}

test("replay: two-stage == dense exact brute force on real snapshots and after synthetic competitor swaps", () => {
    // the MAX round trip is ~8-13% out of the money at rest (both pools' fees + DLMM spread), so only
  // large competitor swaps (~12% PumpSwap move: ~150 SOL on a ~1,200 SOL pool) open an arb
  const moves: ["buy" | "sell" | null, bigint][] = [[null, 0n], ["buy", 2_000_000_000n], ["sell", 2_000_000_000n], ["buy", 80_000_000_000n], ["sell", 80_000_000_000n], ["buy", 150_000_000_000n], ["sell", 150_000_000_000n], ["buy", 300_000_000_000n]];
  let compared = 0, feasible = 0, skips = 0;
  for (const fx of fixtures) {
    for (const [side, amt] of moves) {
      const v = side ? moveCp(fx, side, amt) : load(fx);
      const venues = { a: v.pumpswap, b: v.dlmm };
      for (const [dir, noBoundSkip] of PAIR_DIRECTIONS.flatMap((d) => [[d, false], [d, true]] as const)) {
        const bf = bruteForcePair(dir, venues, params, 2_000, 200);
        if (!bf) continue;
        const two = searchPairDirection(dir, venues, params, 0, { noBoundSkip });
        if (two.skipped) {
          const net = bf.gross - chooseExecutionFees(bf.gross, policy).totalLamports;
          assert.ok(net < params.profitFloor, `${fx.slot} ${side}${amt} ${dir}: skipped but brute nets ${net}`);
          skips++;
          continue;
        }
        const got = two.best?.grossProfit ?? -(1n << 62n);
        assert.ok(got >= bf.gross - 1_000n, `${fx.slot} ${side}${amt} ${dir}: two-stage ${got} < brute ${bf.gross}`);
        compared++;
        if (two.plan) feasible++;
      }
    }
  }
  assert.ok(compared >= 20, `compared ${compared}`);
  assert.ok(feasible >= 1, "large competitor swaps should open a floor-clearing arb");
  assert.ok(skips >= 1);
});
