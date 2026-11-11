// Offline tests for src/meteora. Fixtures:
//  - fixtures/meteora/sim-snapshot.json.gz: account snapshot (lb_pair, mint, clock, bin arrays near
//    the active bin) + quotes that were verified to the base unit against mainnet simulateTransaction
//    by src/meteora/validate.ts --write-fixtures (each case carries the Clock it was simulated at).
//  - fixtures/meteora/historical-single-bin.json: Swap events of the reference wallet's historical
//    single-bin DLMM swaps (amounts, fee, protocol fee, host fee, fee rate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { AccountInfo, PublicKey } from "@solana/web3.js";
import { MeteoraDlmm } from "../src/meteora/index.js";
import { decodeBinArray, decodeClock, decodeLbPair, decodeMint } from "../src/meteora/layout.js";
import { HOST_FEE_BPS, swapExactInAtBin, swapExactOutAtBin, binView } from "../src/meteora/math.js";
import { POOL, SYSVAR_CLOCK, binArrayPda } from "../src/meteora/pda.js";

const snap = JSON.parse(gunzipSync(readFileSync(new URL("../fixtures/meteora/sim-snapshot.json.gz", import.meta.url))).toString());
const hist: any[] = JSON.parse(readFileSync(new URL("../fixtures/meteora/historical-single-bin.json", import.meta.url), "utf8"));

function infosOf(): Map<string, AccountInfo<Buffer> | null> {
  const m = new Map<string, AccountInfo<Buffer> | null>();
  for (const [k, b64] of Object.entries<string>(snap.infos))
    m.set(k, { data: Buffer.from(b64, "base64"), owner: PublicKey.default, lamports: 0, executable: false });
  return m;
}

function venueAt(clockB64?: string) {
  const v = new MeteoraDlmm({ binArrayWindow: 3 });
  v.update(snap.slot, infosOf());
  if (clockB64) v.clock = decodeClock(Buffer.from(clockB64, "base64"));
  return v;
}

test("decoders agree with the SDK's Anchor coder", () => {
  const require = createRequire(import.meta.url);
  let sdk: any;
  try {
    sdk = require("@meteora-ag/dlmm");
  } catch {
    return; // SDK not loadable: skip
  }
  const { Connection } = require("@solana/web3.js");
  const program = sdk.createProgram(new Connection("http://127.0.0.1:1"));
  const lbData = Buffer.from(snap.infos[POOL.toBase58()], "base64");
  const a = sdk.decodeAccount(program, "lbPair", lbData);
  const mine = decodeLbPair(lbData);
  assert.equal(mine.activeId, a.activeId);
  assert.equal(mine.binStep, a.binStep);
  assert.equal(mine.s.baseFactor, a.parameters.baseFactor);
  assert.equal(mine.s.variableFeeControl, a.parameters.variableFeeControl);
  assert.equal(mine.s.maxVolatilityAccumulator, a.parameters.maxVolatilityAccumulator);
  assert.equal(mine.s.protocolShare, a.parameters.protocolShare);
  assert.equal(mine.s.functionType, a.parameters.functionType);
  assert.equal(mine.s.collectFeeMode, a.parameters.collectFeeMode);
  assert.equal(mine.v.volatilityAccumulator, a.vParameters.volatilityAccumulator);
  assert.equal(mine.v.volatilityReference, a.vParameters.volatilityReference);
  assert.equal(mine.v.indexReference, a.vParameters.indexReference);
  assert.equal(mine.v.lastUpdateTimestamp.toString(), a.vParameters.lastUpdateTimestamp.toString());
  assert.ok(mine.oracle.equals(a.oracle));
  assert.ok(mine.reserveX.equals(a.reserveX) && mine.reserveY.equals(a.reserveY));
  assert.equal(mine.tokenMintXProgramFlag, a.tokenMintXProgramFlag);
  mine.binArrayBitmap.forEach((w, i) => assert.equal(w.toString(), a.binArrayBitmap[i].toString()));
  const idx = Math.floor(mine.activeId / 70);
  const baData = Buffer.from(snap.infos[binArrayPda(idx).toBase58()], "base64");
  const ba = sdk.decodeAccount(program, "binArray", baData);
  const myBa = decodeBinArray(baData);
  assert.equal(myBa.index, ba.index.toNumber());
  myBa.bins.forEach((b, j) => {
    assert.equal(b.amountX.toString(), ba.bins[j].amountX.toString());
    assert.equal(b.amountY.toString(), ba.bins[j].amountY.toString());
    assert.equal(b.price.toString(), ba.bins[j].price.toString());
    assert.equal(b.openOrderAmount.toString(), ba.bins[j].openOrderAmount.toString());
    assert.equal(b.processedOrderRemainingAmount.toString(), ba.bins[j].processedOrderRemainingAmount.toString());
  });
});

test("RISE mint has no transfer-fee / transfer-hook extension", () => {
  const m = decodeMint(Buffer.from(snap.infos["EMdcVnAigQDBLFj2KQafvFKeBhMhac7LafZv2LTsrise"], "base64"));
  assert.equal(m.decimals, 9);
  assert.deepEqual(m.extensions, [18, 19]); // MetadataPointer, TokenMetadata
  assert.equal(m.transferFee, null);
  assert.equal(m.transferHookProgram, null);
});

test("quotes reproduce mainnet simulateTransaction results exactly", () => {
  assert.ok(snap.cases.length >= 10);
  for (const c of snap.cases) {
    const v = venueAt(c.clock);
    if (c.mode === "exactIn") {
      const q = v.quoteExactIn(c.side, BigInt(c.amount))!;
      assert.ok(q, `${c.side} ${c.mode} ${c.amount}`);
      assert.equal(q.out.toString(), c.out, `out ${c.side} ${c.amount}`);
      assert.equal(q.netIn.toString(), c.netIn, `netIn ${c.side} ${c.amount}`);
      assert.equal(q.hostFee.toString(), c.hostFee);
    } else {
      const q = v.quoteExactOut(c.side, BigInt(c.amount))!;
      assert.ok(q, `${c.side} ${c.mode} ${c.amount}`);
      assert.equal(q.inp.toString(), c.inGross, `inp ${c.side} ${c.amount}`);
      assert.equal(q.netIn.toString(), c.netIn, `netIn ${c.side} ${c.amount}`);
      assert.equal(q.hostFee.toString(), c.hostFee);
    }
  }
});

test("per-bin math reproduces historical single-bin Swap events (amounts, fee, protocol + host fee)", () => {
  const prices = new Map<number, bigint>();
  for (const b64 of Object.values<string>(snap.infos)) {
    const d = Buffer.from(b64, "base64");
    if (d.length !== 10136) continue;
    const ba = decodeBinArray(d);
    ba.bins.forEach((b, j) => prices.set(ba.index * 70 + j, b.price));
  }
  let n = 0;
  for (const h of hist) {
    const price = prices.get(h.bin);
    if (!price) continue;
    // unlimited liquidity view at that bin's price: single-bin swaps never exhausted the bin
    const view = binView({ amountX: 1n << 62n, amountY: 1n << 62n, price, openOrderAmount: 0n, processedOrderRemainingAmount: 0n, limitOrderAskSide: false }, h.swapForY, false);
    const rate = BigInt(h.feeRate);
    const r =
      h.mode === "exactIn"
        ? swapExactInAtBin(view, rate, 1000n, BigInt(h.a1), h.swapForY, true)
        : swapExactOutAtBin(view, rate, 1000n, BigInt(h.a2), h.swapForY, true);
    const host = h.hostAccount ? (r.protocolFee * HOST_FEE_BPS) / 10_000n : 0n;
    assert.equal(r.amountIn.toString(), h.amountIn, `${h.sig} in`);
    assert.equal(r.amountOut.toString(), h.amountOut, `${h.sig} out`);
    assert.equal(r.fee.toString(), h.fee, `${h.sig} fee`);
    assert.equal(host.toString(), h.hostFee, `${h.sig} host`);
    assert.equal((r.protocolFee - host).toString(), h.protocolFee, `${h.sig} protocol`);
    n++;
  }
  assert.ok(n >= 50, `checked ${n}`);
});

test("exact-in / exact-out are consistent inverses", () => {
  const v = venueAt(snap.cases[0].clock);
  for (const side of ["buyRise", "sellRise"] as const) {
    for (const amt of side === "buyRise" ? [10_000_000n, 3_000_000_000n, 60_000_000_000n] : [5_000_000_000_000n, 40_000_000_000_000n]) {
      const qi = v.quoteExactIn(side, amt)!;
      const qo = v.quoteExactOut(side, qi.out)!;
      assert.ok(qo.inp <= amt, `${side} ${amt}: exact-out input ${qo.inp} > ${amt}`);
      assert.ok(v.quoteExactIn(side, qo.inp)!.out >= qi.out);
      // monotone
      assert.ok(v.quoteExactIn(side, amt + 1000n)!.out >= qi.out);
    }
  }
  // beyond depth -> null
  assert.equal(v.quoteExactOut("sellRise", 10_000n * 1_000_000_000n), null);
});

test("swap instructions match the reference wallet's on-chain layout", () => {
  const v = venueAt();
  const user = new PublicKey("24Q5e2FRebiFs3iWvN6pZYA4UTGzA3WUsci4ChhgfYEU");
  const bas = [-10, -11, -12].map((i) => binArrayPda(i));
  // tx 21Z1FdCT...: Swap2 RISE->SOL amount_in 858078326245 min_out 524099059
  const ix = v.swapExactInIx(user, "sellRise", 858078326245n, 524099059n, bas);
  assert.equal(ix.data.toString("hex"), "414b3f4ceb5b5b88e52d74c9c7000000f31d3d1f0000000000000000");
  const expected = [
    "4xjgBHDdLJcHYyWsL7pLCpUR556qVJyizLQ4qPVgrapt",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "Gsktqpz1pgJwXPqZbvxWjbSaKYQ6ZbeEtHu6UFdaitqg",
    "GomTD5xebsxxUE94vMbkXrwwWG9Rhek877kEjoQUTSjR",
    "BKxadbyMKTTY4drGmv9cxvoFpWSaCVoLDu6g9D77Vmhq",
    "FrAqBUnCz8z7Sm7GVh4moJJEbGcoBinUM5BxSAAfvE7o",
    "EMdcVnAigQDBLFj2KQafvFKeBhMhac7LafZv2LTsrise",
    "So11111111111111111111111111111111111111112",
    "BazcZcc1QnVSg2ikjbqzrHAQxy8PiH3zHHe3pPzBZixy",
    "BKxadbyMKTTY4drGmv9cxvoFpWSaCVoLDu6g9D77Vmhq",
    "24Q5e2FRebiFs3iWvN6pZYA4UTGzA3WUsci4ChhgfYEU",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    "D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "C7cinVe7e6X4gtfFDjwf28eZStBJGmFKd6PNpUqje6Yi",
    "7C3qBi5MSJnhTFw4Tioa2DWJKbEo16T9aQ5mpfDsdE1w",
    "GHA3HMGKcqQPvxaHWkCcy3q1bbn1sH5LXDfaSoqgD1H5",
  ];
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), expected);
  assert.equal(ix.keys[10].isSigner, true);
  // exact-out SOL -> RISE: host fee account is the wSOL ATA (input token)
  const ix2 = v.swapExactOutIx(user, "buyRise", 239780422108n, 131936555n, bas);
  assert.equal(ix2.data.subarray(0, 8).toString("hex"), "2bd7f784893cf351");
  assert.equal(ix2.data.readBigUInt64LE(8), 131936555n); // max_in_amount first
  assert.equal(ix2.data.readBigUInt64LE(16), 239780422108n);
  assert.equal(ix2.keys[4].pubkey.toBase58(), "FrAqBUnCz8z7Sm7GVh4moJJEbGcoBinUM5BxSAAfvE7o");
  assert.equal(ix2.keys[9].pubkey.toBase58(), "FrAqBUnCz8z7Sm7GVh4moJJEbGcoBinUM5BxSAAfvE7o");
});

test("accounts() grows to include bin arrays after the first update", () => {
  const v = new MeteoraDlmm();
  assert.deepEqual(v.accounts().map((k) => k.toBase58()).slice(0, 2), [POOL.toBase58(), SYSVAR_CLOCK.toBase58()]);
  v.update(snap.slot, infosOf());
  assert.ok(v.accounts().length > 3);
  assert.ok(v.ready());
});
