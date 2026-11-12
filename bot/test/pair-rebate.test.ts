// Regression (audit): on a fee-on-output DLMM pool (OnlyY, H6Bcgds…) the leg-2 sell's host-fee
// rebate is folded into `out` and the program's min_amount_out is lowered by the QUOTED rebate. If the
// pool pays exactly that program min-out at landing (price moved against us), the rebate it pays is
// smaller than quoted (it scales with the gross output), so the user received less than the final
// min-out and the realized net fell below the floor (e.g. 78,221 < 100,000 lamports on a recorded
// snapshot). The optimizer now pads the min-out by the part of that rebate that is not guaranteed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { MAX_DLMM_POOL, maxPairSpec } from "../src/engine/pair-venues.js";
import { searchPairDirection, type PairParams } from "../src/engine/pair-optimizer.js";
import { pairLegInstructions } from "../src/engine/pair.js";
import type { DlmmQuoteCtx } from "../src/meteora/venue.js";

const DIR = "test/fixtures/pair";
type Fx = { slot: number; accounts: Record<string, { owner: string; lamports: number; executable: boolean; data: string } | null> };
const fixtures = readdirSync(DIR).filter((f) => f.endsWith(".json.gz")).map((f) => JSON.parse(gunzipSync(readFileSync(join(DIR, f))).toString()) as Fx).filter((fx) => fx.accounts[MAX_DLMM_POOL]);
const policy = { baseFeeLamports: 5_000n, maxPriorityFeeLamports: 50_000n, maxTipLamports: 50_000n, maxShareBps: 1_000n, tipEnabled: false };
const params: PairParams = { profitFloor: 100_000n, fees: policy, maxLamportsIn: 100_000_000n, minLamportsIn: 1_000_000n };
const USER = new PublicKey("8pY1AukbuPgUE3EetyLa59rFLMimJGT94ZzbMEZcQF4w");

test("OnlyY leg-2 rebate: worst landing that just clears the program min-out still nets >= floor", () => {
  assert.ok(fixtures.length >= 1);
  let checked = 0;
  for (const fx of fixtures) {
    for (const move of [80_000_000_000n, 150_000_000_000n]) {
      const spec = maxPairSpec({ ...process.env, MAX_DLMM_POOLS: MAX_DLMM_POOL });
      const infos = new Map<string, AccountInfo<Buffer> | null>(Object.entries(fx.accounts).map(([k, a]) => [k, a ? { owner: new PublicKey(a.owner), lamports: a.lamports, executable: a.executable, data: Buffer.from(a.data, "base64"), rentEpoch: 0 } : null]));
      for (let i = 0; i < 3; i++) { spec.pumpswap.update(fx.slot, infos); spec.dlmmVenues[0].update(fx.slot, infos); }
      // synthetic competitor dump on PumpSwap opens buy-PumpSwap / sell-DLMM
      const t = spec.pumpswap.quoteExactIn("buy", move)!.out;
      spec.pumpswap.applyQuote(spec.pumpswap.quoteExactIn("sell", t)!);
      const b = spec.dlmmVenues[0];
      const venues = { a: spec.pumpswap, b };
      const plan = searchPairDirection("buyAsellB", venues, params, fx.slot, {}, "max:H6Bcgd").plan;
      if (!plan) continue;
      const reb = (plan.sellQuote.ctx as DlmmQuoteCtx).rebateInOut;
      assert.ok(reb > 0n, "H6Bcgds sells pay the host fee into the wSOL output");
      const { ixs, finalMin } = pairLegInstructions(plan, venues, USER, params.profitFloor, plan.fees.totalLamports);
      const programMin = ixs[1].data.readBigUInt64LE(16);
      assert.equal(programMin, finalMin - reb);
      // smallest leg-2 fill whose swap output (rebate excluded) clears the program min-out
      let lo = 1n, hi = plan.token;
      while (lo < hi) {
        const m = (lo + hi) / 2n;
        const s = b.quoteExactIn("sell", m)!;
        if (s.out - (s.ctx as DlmmQuoteCtx).rebateInOut >= programMin) hi = m; else lo = m + 1n;
      }
      const received = b.quoteExactIn("sell", lo)!.out; // swap output + rebate actually paid
      const net = received - plan.lamportsIn - plan.fees.totalLamports;
      assert.ok(net >= params.profitFloor, `slot ${fx.slot} move ${move}: worst-case net ${net} < floor (pad ${plan.minOutPad}, rebate ${reb})`);
      assert.ok(plan.minOutPad < reb / 4n, "only the at-risk part of the rebate pads the min-out");
      checked++;
    }
  }
  assert.ok(checked >= 2, `checked ${checked}`);
});
