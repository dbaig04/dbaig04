// Offline tests for the generalized MeteoraDlmm + DlmmSwapVenue adapter on MAX/SOL pools.
// Fixtures (fixtures/meteora/):
//  - max-5nwdWt-sim.json.gz (InputOnly fees) and max-Gt5wsV-sim.json.gz (OnlyY fees: sells pay the fee
//    in wSOL and the host rebate lands in the output account): per-case account snapshots (lb_pair,
//    mints, traversed bin arrays) + Clock, verified to the base unit against mainnet simulation by
//    src/meteora/validate-max.ts --write-fixtures.
//  - max-lbpairs.json: lb_pair accounts of Gt5wsV / H6Bcgd + MAX / wSOL mints (for ix layout checks).
//  - ../pumpswap/research-txs.json: the research wallet's DLMM swap2 CPIs (Gt5wsV, H6Bcgd).
// The RISE default pool keeps its own tests in test/meteora.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import bs58 from "bs58";
import { AccountInfo, PublicKey } from "@solana/web3.js";
import { MeteoraDlmm } from "../src/meteora/index.js";
import { DlmmSwapVenue, DlmmQuoteCtx } from "../src/meteora/venue.js";
import { decodeClock } from "../src/meteora/layout.js";
import { POOL as RISE_POOL, PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, ata } from "../src/meteora/pda.js";
import { MAX_MINT, WSOL_MINT } from "../src/types.js";

const fx = (p: string) => new URL(`../fixtures/${p}`, import.meta.url);
const sims = ["max-5nwdWt-sim.json.gz", "max-Gt5wsV-sim.json.gz"].map((f) => JSON.parse(gunzipSync(readFileSync(fx(`meteora/${f}`))).toString()));
const lbpairs = JSON.parse(readFileSync(fx("meteora/max-lbpairs.json"), "utf8"));
const txs: any[] = JSON.parse(readFileSync(fx("pumpswap/research-txs.json"), "utf8"));
const MAXK = new PublicKey(MAX_MINT);
const WSOL = new PublicKey(WSOL_MINT);

function infosFrom(entries: [string, { owner: string; data: string }][]): Map<string, AccountInfo<Buffer> | null> {
  const m = new Map<string, AccountInfo<Buffer> | null>();
  for (const [k, v] of entries) m.set(k, { data: Buffer.from(v.data, "base64"), owner: new PublicKey(v.owner), lamports: 0, executable: false });
  return m;
}
function caseVenue(sim: any, c: any): DlmmSwapVenue {
  const v = new DlmmSwapVenue({ pool: sim.pool, tokenMint: MAX_MINT, binArrayWindow: 12 });
  v.update(c.slot, infosFrom(Object.entries<string>(c.accounts).map(([k, h]) => [k, sim.blobs[h]])));
  v.dlmm.clock = decodeClock(Buffer.from(c.clock, "base64"));
  return v;
}

test("generic DLMM venue reproduces simulated MAX swaps exactly on both fee modes", () => {
  for (const sim of sims) {
    assert.ok(sim.cases.length >= 10, sim.pool);
    let sellRebate = 0;
    for (const c of sim.cases) {
      const v = caseVenue(sim, c);
      const q = v.quoteExactIn(c.side, BigInt(c.amount));
      assert.ok(q, `${sim.pool} ${c.side} ${c.amount}`);
      assert.equal(q.out.toString(), c.out, `${sim.pool} ${c.side} ${c.amount} out`);
      assert.equal(q.netIn.toString(), c.netIn, `${sim.pool} ${c.side} ${c.amount} netIn`);
      const ctx = q.ctx as DlmmQuoteCtx;
      assert.equal(ctx.q.hostFee.toString(), c.hostFee);
      if (ctx.rebateInOut > 0n) sellRebate++;
    }
    // OnlyY pool: sells (X -> Y) pay the fee in wSOL, the rebate is part of `out`
    if (sim.pool.startsWith("Gt5ws")) assert.ok(sellRebate > 0);
    else assert.equal(sellRebate, 0);
  }
});

test("token programs come from the mint owners; ATAs, host account and min-out per fee mode", () => {
  for (const sim of sims) {
    const c = sim.cases.find((x: any) => x.side === "sell");
    const v = caseVenue(sim, c);
    assert.ok(v.dlmm.tokenProgramX!.equals(TOKEN_2022_PROGRAM));
    assert.ok(v.dlmm.tokenProgramY!.equals(TOKEN_PROGRAM));
    const user = new PublicKey("8pY1AukbuPgUE3EetyLa59rFLMimJGT94ZzbMEZcQF4w");
    const uMax = ata(user, MAXK, TOKEN_2022_PROGRAM);
    const uW = ata(user, WSOL, TOKEN_PROGRAM);
    for (const side of ["buy", "sell"] as const) {
      const amt = side === "buy" ? 10_000_000n : BigInt(c.amount);
      const q = v.quoteExactIn(side, amt)!;
      const [ix] = v.swapExactInIxs(user, side, amt, q.out, q);
      const k = ix.keys.map((x) => x.pubkey);
      assert.ok(k[0].equals(new PublicKey(sim.pool)));
      assert.ok(k[4].equals(side === "buy" ? uW : uMax) && k[5].equals(side === "buy" ? uMax : uW));
      assert.ok(k[11].equals(TOKEN_2022_PROGRAM) && k[12].equals(TOKEN_PROGRAM));
      const ctx = q.ctx as DlmmQuoteCtx;
      const feeOnInput = v.dlmm.feeIsOnInput(ctx.side);
      assert.ok(k[9].equals(feeOnInput ? k[4] : uW), "host_fee_in = user's fee-token account");
      // program min_amount_out excludes a rebate paid into the output account
      assert.equal(ix.data.readBigUInt64LE(16), q.out - ctx.rebateInOut);
    }
  }
});

test("DLMM swap2 accounts match the research wallet's on-chain CPIs (Gt5wsV OnlyY sell, H6Bcgd)", () => {
  const m = infosFrom(Object.entries<any>(lbpairs.infos));
  let n = 0;
  for (const t of txs)
    for (const ix of t.dlmmIxs) {
      const keys = ix.accounts;
      const pool = keys[0].pubkey;
      const v = new DlmmSwapVenue({ pool, tokenMint: MAX_MINT });
      v.update(lbpairs.slot, m);
      const data = Buffer.from(bs58.decode(ix.data));
      assert.equal(data.subarray(0, 8).toString("hex"), "414b3f4ceb5b5b88"); // swap2
      const user = new PublicKey(keys[10].pubkey);
      const side = keys[4].pubkey === ata(user, MAXK, TOKEN_2022_PROGRAM).toBase58() ? "sell" : "buy";
      const binArrays = keys.slice(16).map((k: any) => new PublicKey(k.pubkey));
      const mine = v.dlmm.swapExactInIx(user, v.sideOf(side), data.readBigUInt64LE(8), data.readBigUInt64LE(16), binArrays);
      // the research program pads swap2 data with 28 zero bytes after RemainingAccountsInfo{slices: []}
      assert.ok(mine.data.equals(data.subarray(0, mine.data.length)));
      assert.ok(data.subarray(mine.data.length).every((b) => b === 0));
      assert.deepEqual(mine.keys.map((k) => k.pubkey.toBase58()), keys.map((k: any) => k.pubkey), pool);
      mine.keys.forEach((k, i) => {
        if (k.isWritable) assert.ok(keys[i].messageWritable, `${pool} account ${i} writable`);
      });
      assert.ok(mine.programId.equals(PROGRAM));
      n++;
    }
  assert.equal(n, 2);
});

test("adapter side mapping (token as X or Y) and mint checks", () => {
  const vx = new DlmmSwapVenue({ pool: "Gt5wsVd26Q8cJwogrmo7rUApdiLw5xB6CDcTu2cbFeGC", tokenMint: MAX_MINT });
  assert.equal(vx.sideOf("buy"), "buyRise"); // Y(wSOL) -> X(token)
  assert.equal(vx.sideOf("sell"), "sellRise");
  const vy = new DlmmSwapVenue({ pool: "Gt5wsVd26Q8cJwogrmo7rUApdiLw5xB6CDcTu2cbFeGC", tokenMint: MAX_MINT, tokenSide: "y" });
  assert.equal(vy.sideOf("buy"), "sellRise"); // X(wSOL) -> Y(token)
  assert.equal(vy.sideOf("sell"), "buyRise");
  // MAX is X on this pool: declaring it as Y must be rejected on the first update
  assert.throws(() => vy.update(lbpairs.slot, infosFrom(Object.entries<any>(lbpairs.infos))), /unexpected pool mints/);
  // default constructor still targets the RISE pool
  const d = new MeteoraDlmm();
  assert.ok(d.pool.equals(RISE_POOL));
  assert.equal(d.accounts().length, 4); // lb_pair, clock, RISE mint, wSOL mint (bin arrays after first update)
  assert.equal(vx.programIds().length, 1);
  assert.ok(vx.name.startsWith("dlmm:Gt5ws"));
});

test("edge cases: zero, dust, exhausting the cached liquidity", () => {
  for (const sim of sims) {
    const c = sim.cases[0];
    const v = caseVenue(sim, c);
    assert.equal(v.quoteExactIn("buy", 0n), null);
    assert.equal(v.quoteExactIn("sell", 0n), null);
    const tiny = v.quoteExactIn("sell", 1n);
    if (tiny) assert.ok(tiny.out >= 0n && tiny.netIn <= 1n);
    // more than everything cached on the output side -> null (never a partial/optimistic quote)
    const dep = v.dlmm.depth()!;
    assert.equal(v.quoteExactIn("sell", dep.buyRiseMaxRiseOut * 1000n + 10n ** 15n), null);
    assert.equal(v.quoteExactIn("buy", 10n ** 15n), null);
    const k = v.quoteKey();
    assert.equal(v.quoteKey(), k);
  }
});

test("latency: MAX DLMM quotes are µs-level", () => {
  const sim = sims[0];
  const c = sim.cases.find((x: any) => x.side === "buy");
  const v = caseVenue(sim, c);
  const N = 5000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) v.quoteExactIn(i & 1 ? "buy" : "sell", i & 1 ? 10_000_000n + BigInt(i) : 300_000_000n + BigInt(i));
  const us = Number(process.hrtime.bigint() - t0) / N / 1000;
  assert.ok(us < 200, `${us} us/quote`);
});
