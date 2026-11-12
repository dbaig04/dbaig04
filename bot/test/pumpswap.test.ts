// Offline tests for src/pumpswap. Fixtures (fixtures/pumpswap/):
//  - sim-cases.json.gz: account snapshot (pool, GlobalConfig, FeeConfig, MAX + wSOL mints, vaults,
//    buyback ATA) + single-swap cases verified to the base unit against mainnet simulateTransaction by
//    src/pumpswap/validate.ts --write-fixtures. Each case carries the pre-trade reserves / virtual
//    reserves / base supply the program reported in its event.
//  - research-txs.json: the research wallet's buy_exact_quote_in_v2 / sell_v2 CPIs on the MAX pool
//    (accounts with message-level flags, data, event logs) and the DLMM swap2 CPI of the same tx.
//  - pump_amm-idl-2.2.0.trimmed.json: IDL subset from @pump-fun/pump-swap-sdk 2.2.0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import bs58 from "bs58";
import { AccountInfo, PublicKey } from "@solana/web3.js";
import { PumpSwapPool, PumpSwapQuoteCtx, BUY_EXACT_QUOTE_IN_V2_DISC, SELL_V2_DISC } from "../src/pumpswap/index.js";
import { decodeFeeConfig, decodeGlobalConfig, decodePool } from "../src/pumpswap/layout.js";
import { buyExactQuoteIn, calculateFeeTier, computeFees, poolMarketCap, sellExactBaseIn } from "../src/pumpswap/math.js";
import { pumpEventsFromLogs } from "../src/pumpswap/events.js";
import { EVENT_AUTHORITY, FEE_CONFIG, GLOBAL_CONFIG, ata, canonicalPoolPda, TOKEN_PROGRAM } from "../src/pumpswap/pda.js";
import { MAX_MINT } from "../src/types.js";

const fx = (p: string) => new URL(`../fixtures/pumpswap/${p}`, import.meta.url);
const snap = JSON.parse(gunzipSync(readFileSync(fx("sim-cases.json.gz"))).toString());
const txs: any[] = JSON.parse(readFileSync(fx("research-txs.json"), "utf8"));
const idl = JSON.parse(readFileSync(fx("pump_amm-idl-2.2.0.trimmed.json"), "utf8"));
const POOL = "Eoe22HdCa9rhtBwKL6nNZmZxfuzF35xkxobcvfaF1vWQ";

function infos(): Map<string, AccountInfo<Buffer> | null> {
  const m = new Map<string, AccountInfo<Buffer> | null>();
  for (const [k, v] of Object.entries<any>(snap.infos)) m.set(k, { data: Buffer.from(v.data, "base64"), owner: new PublicKey(v.owner), lamports: 0, executable: false });
  return m;
}
function venue(): PumpSwapPool {
  const v = new PumpSwapPool({ pool: POOL, tokenMint: MAX_MINT });
  v.update(snap.slot, infos());
  return v;
}
/** venue with reserves/supply replaced (as the program saw them in a case's event) */
function venueAt(st: { baseReserve: string; quoteVault: string; virtual: string; baseSupply: string }): PumpSwapPool {
  const v = venue();
  v.baseReserve = BigInt(st.baseReserve);
  v.quoteVault = BigInt(st.quoteVault);
  v.baseSupply = BigInt(st.baseSupply);
  v.poolState = { ...v.poolState!, virtualQuoteReserves: BigInt(st.virtual) };
  return v;
}

// ---- minimal IDL-driven borsh decoder (independent of layout.ts offsets) ----
const T = new Map<string, any>(idl.types.map((t: any) => [t.name, t]));
function idlDecode(t: any, d: Buffer, o: number): [any, number] {
  if (typeof t === "string") {
    const sz: Record<string, number> = { u8: 1, u16: 2, u32: 4, u64: 8, i64: 8, u128: 16, i128: 16, bool: 1 };
    if (t === "pubkey") return [new PublicKey(d.subarray(o, o + 32)).toBase58(), o + 32];
    const n = sz[t];
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]);
    if (t[0] === "i") v = BigInt.asIntN(n * 8, v);
    return [t === "bool" ? v !== 0n : v, o + n];
  }
  if (t.array) {
    const out = [];
    for (let i = 0; i < t.array[1]; i++) {
      let v;
      [v, o] = idlDecode(t.array[0], d, o);
      out.push(v);
    }
    return [out, o];
  }
  if (t.vec) {
    const n = d.readUInt32LE(o);
    o += 4;
    const out = [];
    for (let i = 0; i < n; i++) {
      let v;
      [v, o] = idlDecode(t.vec, d, o);
      out.push(v);
    }
    return [out, o];
  }
  if (t.defined) {
    const def = T.get(t.defined.name);
    const r: any = {};
    for (const f of def.type.fields) [r[f.name], o] = idlDecode(f.type, d, o);
    return [r, o];
  }
  throw new Error(`type ${JSON.stringify(t)}`);
}
const raw = (k: string) => Buffer.from(snap.infos[k].data, "base64");

test("layout decoders agree with an IDL-driven borsh decoder (pool, GlobalConfig, FeeConfig)", () => {
  const [p] = idlDecode({ defined: { name: "Pool" } }, raw(POOL), 8);
  const mine = decodePool(raw(POOL));
  assert.equal(mine.baseMint.toBase58(), p.base_mint);
  assert.equal(mine.quoteMint.toBase58(), p.quote_mint);
  assert.equal(mine.creator.toBase58(), p.creator);
  assert.equal(mine.coinCreator.toBase58(), p.coin_creator);
  assert.equal(mine.poolBaseTokenAccount.toBase58(), p.pool_base_token_account);
  assert.equal(mine.poolQuoteTokenAccount.toBase58(), p.pool_quote_token_account);
  assert.equal(mine.virtualQuoteReserves, p.virtual_quote_reserves);
  assert.equal(mine.creatorFeeBps, p.creator_fee_bps);
  assert.equal(mine.protocolFees, p.protocol_fees);
  assert.equal(mine.creatorFees, p.creator_fees);
  assert.equal(mine.isCashbackCoin, p.is_cashback_coin);
  assert.equal(mine.isMayhemMode, p.is_mayhem_mode);
  assert.equal(mine.isHolderReward, p.is_holder_reward);
  assert.equal(mine.lpSupply, p.lp_supply);

  const [g] = idlDecode({ defined: { name: "GlobalConfig" } }, raw(GLOBAL_CONFIG.toBase58()), 8);
  const mg = decodeGlobalConfig(raw(GLOBAL_CONFIG.toBase58()));
  assert.equal(mg.lpFeeBps, g.lp_fee_basis_points);
  assert.equal(mg.protocolFeeBps, g.protocol_fee_basis_points);
  assert.equal(mg.coinCreatorFeeBps, g.coin_creator_fee_basis_points);
  assert.equal(mg.disableFlags, Number(g.disable_flags));
  assert.equal(mg.buybackBps, g.buyback_basis_points);
  assert.deepEqual(mg.buybackFeeRecipients.map((k) => k.toBase58()), g.buyback_fee_recipients);
  assert.deepEqual(mg.protocolFeeRecipients.map((k) => k.toBase58()), g.protocol_fee_recipients);
  assert.equal(mg.reservedFeeRecipient.toBase58(), g.reserved_fee_recipient);
  assert.equal(mg.creatorFeeConfigurable, g.creator_fee_configurable);
  assert.equal(mg.maxConfigurableCreatorFeeBps, g.max_configurable_creator_fee_bps);
  assert.equal(mg.isCashbackEnabled, g.is_cashback_enabled);
  assert.equal(mg.boostEnabled, g.boost_enabled);

  const [f] = idlDecode({ defined: { name: "FeeConfig" } }, raw(FEE_CONFIG.toBase58()), 8);
  const mf = decodeFeeConfig(raw(FEE_CONFIG.toBase58()));
  const fe = (x: any) => ({ lpFeeBps: x.lp_fee_bps, protocolFeeBps: x.protocol_fee_bps, creatorFeeBps: x.creator_fee_bps });
  assert.deepEqual(mf.flatFees, fe(f.flat_fees));
  assert.deepEqual(mf.exoticFlatFees, fe(f.exotic_flat_fees));
  assert.deepEqual(mf.feeTiers, f.fee_tiers.map((t: any) => ({ marketCapLamportsThreshold: t.market_cap_lamports_threshold, fees: fe(t.fees) })));
  assert.deepEqual(mf.stableFeeTiers, f.stable_fee_tiers.map((t: any) => ({ marketCapLamportsThreshold: t.market_cap_lamports_threshold, fees: fe(t.fees) })));
  assert.ok(mf.feeTiers.length > 10);
});

test("discriminators and PDAs match the IDL / on-chain addresses", () => {
  const disc = (n: string) => Buffer.from(idl.instructions.find((i: any) => i.name === n).discriminator);
  assert.ok(disc("buy_exact_quote_in_v2").equals(BUY_EXACT_QUOTE_IN_V2_DISC));
  assert.ok(disc("sell_v2").equals(SELL_V2_DISC));
  assert.equal(GLOBAL_CONFIG.toBase58(), "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
  assert.equal(FEE_CONFIG.toBase58(), "5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
  assert.equal(EVENT_AUTHORITY.toBase58(), "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR");
  // the MAX pool is the canonical pump pool (index 0, creator = pump pool-authority PDA)
  assert.equal(canonicalPoolPda(new PublicKey(MAX_MINT), new PublicKey("So11111111111111111111111111111111111111112")).toBase58(), POOL);
  // v2 account lists in the IDL are the 17 accounts the builder emits, in this order
  const names = idl.instructions.find((i: any) => i.name === "buy_exact_quote_in_v2").accounts.map((a: any) => a.name);
  assert.deepEqual(names, idl.instructions.find((i: any) => i.name === "sell_v2").accounts.map((a: any) => a.name));
  assert.equal(names.length, 17);
});

test("quotes reproduce every simulated case exactly (out, netIn, fee split, buyback)", () => {
  assert.ok(snap.cases.length >= 15);
  for (const c of snap.cases) {
    const v = venueAt(c.state);
    const q = v.quoteExactIn(c.side, BigInt(c.amount))!;
    assert.ok(q, `${c.side} ${c.amount}`);
    const r = (q.ctx as PumpSwapQuoteCtx).r;
    assert.equal(q.out.toString(), c.out, `${c.side} ${c.amount} out`);
    assert.equal(q.netIn.toString(), c.netIn, `${c.side} ${c.amount} netIn`);
    assert.equal(r.lpFee.toString(), c.lpFee);
    assert.equal(r.protocolFee.toString(), c.protocolFee);
    assert.equal(r.coinCreatorFee.toString(), c.coinCreatorFee);
    assert.equal(r.buybackFee.toString(), c.buybackFee);
  }
  // the fee-split shave case (net + fees < budget): the program debits budget - 1
  const shave = snap.cases.filter((c: any) => c.side === "buy" && c.netIn !== c.amount);
  assert.ok(shave.length >= 1 && shave.every((c: any) => BigInt(c.amount) - BigInt(c.netIn) === 1n));
});

test("research-wallet txs: event amounts re-derived from the event's pre-trade state, fee tier from market cap", () => {
  const v = venue();
  let n = 0;
  for (const t of txs) {
    for (const ev of pumpEventsFromLogs(t.eventLogs)) {
      if (ev.pool !== POOL) continue;
      n++;
      const B = ev.poolBaseTokenReserves;
      const Q = ev.poolQuoteTokenReserves + ev.virtualQuoteReserves;
      // fee tier selected from pre-trade market cap with the (current) FeeConfig
      const fees = calculateFeeTier(v.feeConfig!.feeTiers, poolMarketCap(ev.baseSupply, B, Q, false));
      assert.equal(fees.lpFeeBps, ev.lpFeeBasisPoints);
      assert.equal(fees.protocolFeeBps, ev.protocolFeeBasisPoints);
      assert.equal(fees.creatorFeeBps, ev.coinCreatorFeeBasisPoints);
      if (ev.kind === "buy") {
        const r = buyExactQuoteIn(ev.maxQuoteAmountIn, B, Q, fees, ev.buybackFeeBasisPoints, false)!;
        assert.equal(r.baseOut, ev.baseAmountOut);
        assert.equal(r.netQuote, ev.userQuoteAmountIn);
        assert.equal(r.lpFee, ev.lpFee);
        assert.equal(r.protocolFee, ev.protocolFee);
        assert.equal(r.coinCreatorFee, ev.coinCreatorFee);
        assert.equal(r.buybackFee, ev.buybackFee);
        assert.equal(r.netQuote + r.lpFee, ev.quoteAmountInWithLpFee);
      } else {
        const r = sellExactBaseIn(ev.baseAmountIn, B, Q, ev.poolQuoteTokenReserves, fees, ev.buybackFeeBasisPoints, false)!;
        assert.equal(r.grossQuote, ev.quoteAmountOut);
        assert.equal(r.quoteOut, ev.userQuoteAmountOut);
        assert.equal(r.grossQuote - r.lpFee, ev.quoteAmountOutWithoutLpFee);
        assert.equal(r.lpFee, ev.lpFee);
        assert.equal(r.protocolFee, ev.protocolFee);
        assert.equal(r.coinCreatorFee, ev.coinCreatorFee);
        assert.equal(r.buybackFee, ev.buybackFee);
      }
    }
  }
  assert.equal(n, 2); // one buy_exact_quote_in_v2 + one sell_v2
});

test("instruction accounts, flags and data match the research wallet's on-chain CPIs", () => {
  let n = 0;
  for (const t of txs) {
    for (const ix of t.pumpIxs) {
      const keys = ix.accounts;
      const user = new PublicKey(keys[1].pubkey);
      const v = venue();
      v.buybackAta = new PublicKey(keys[14].pubkey); // the tx's buyback recipient ATA (any listed one is valid)
      // that ATA is the wSOL ATA of a listed buyback recipient
      assert.ok(v.global!.buybackFeeRecipients.some((r) => ata(r, v.poolState!.quoteMint, TOKEN_PROGRAM).equals(v.buybackAta!)));
      const data = Buffer.from(bs58.decode(ix.data));
      const side = data.subarray(0, 8).equals(BUY_EXACT_QUOTE_IN_V2_DISC) ? "buy" : data.subarray(0, 8).equals(SELL_V2_DISC) ? "sell" : null;
      assert.ok(side);
      const amount = data.readBigUInt64LE(8);
      const minOut = data.readBigUInt64LE(16);
      const mine = v.swapIx(user, side, amount, minOut);
      assert.ok(mine.data.equals(data), "ix data");
      assert.deepEqual(mine.keys.map((k) => k.pubkey.toBase58()), keys.map((k: any) => k.pubkey));
      mine.keys.forEach((k, i) => {
        if (k.isWritable) assert.ok(keys[i].messageWritable, `account ${i} must be writable in the tx`);
        else assert.ok(!keys[i].messageWritable || keys[i].messageSigner || keys.filter((x: any) => x.pubkey === keys[i].pubkey).length > 1 || [0, 1].includes(i), `account ${i} readonly`);
        if (k.isSigner) assert.ok(keys[i].messageSigner);
      });
      n++;
    }
  }
  assert.equal(n, 2);
});

test("edge cases: zero, dust, u64 bounds, reserve exhaustion, disabled flags, cashback pools", () => {
  const v = venue();
  assert.equal(v.quoteExactIn("buy", 0n), null);
  assert.equal(v.quoteExactIn("sell", 0n), null);
  assert.equal(v.quoteExactIn("buy", -5n), null);
  assert.equal(v.quoteExactIn("buy", 1n << 64n), null);
  // 1 lamport: net = 0 after fees -> rejected; 1 MAX base unit sells for 0 lamports -> rejected
  assert.equal(v.quoteExactIn("buy", 1n), null);
  assert.equal(v.quoteExactIn("sell", 1n), null);
  // smallest budget the program accepts: net >= 2 (input = net - 1 > 0) and base out > 0
  let s = 1n;
  while (!v.quoteExactIn("buy", s)) s++;
  assert.ok(s < 10n, `min buy ${s}`);
  // huge sells approach but never reach the quote reserve; huge buys never drain the base reserve
  const big = v.quoteExactIn("sell", (1n << 64n) - 1n);
  if (big) assert.ok(big.out < v.quoteVault);
  const bigBuy = v.quoteExactIn("buy", (1n << 63n))!;
  assert.ok(bigBuy.out < v.baseReserve);
  // fee buckets are not liquidity: a sell whose payout exceeds vault - buckets is rejected
  const w = venue();
  w.poolState = { ...w.poolState!, protocolFees: w.quoteVault - 1000n, creatorFees: 0n };
  assert.equal(w.quoteExactIn("sell", 10n ** 12n), null);
  // disable flags / cashback coin
  const d = venue();
  d.global = { ...d.global!, disableFlags: 1 << 3 };
  assert.equal(d.quoteExactIn("buy", 10n ** 8n), null);
  assert.ok(d.quoteExactIn("sell", 10n ** 9n));
  const c = venue();
  c.poolState = { ...c.poolState!, isCashbackCoin: true };
  assert.equal(c.quoteExactIn("buy", 10n ** 8n), null);
});

test("buy output is not monotone at 1-lamport granularity (program behaviour, shave of the fee split)", () => {
  const v = venue();
  let found = false;
  for (let a = 100_000_000n; a < 100_010_000n && !found; a++) {
    const x = v.quoteExactIn("buy", a)!;
    const y = v.quoteExactIn("buy", a + 1n)!;
    if (y.out < x.out) found = true;
  }
  assert.ok(found);
});

test("fuzz: monotone, bounded, netIn in {amount, amount-1}, buy->sell round trip loses", () => {
  const v = venue();
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed);
  for (let i = 0; i < 3000; i++) {
    const a = BigInt(rnd()) * BigInt((rnd() % 1000) + 1) + 2n;
    const b = v.quoteExactIn("buy", a);
    // not monotone at 1-lamport granularity (the fee-ceiling shave can cost the net 2-3 units), but
    // monotone over >= 4 lamports
    const b2 = v.quoteExactIn("buy", a + 4n);
    if (b && b2) assert.ok(b2.out >= b.out);
    if (b) {
      assert.ok(b.netIn === a || b.netIn === a - 1n);
      assert.ok(b.out > 0n && b.out < v.baseReserve);
      // selling the bought amount back on the post-trade state returns less than paid
      const w = venue();
      w.applyQuote(b);
      const s = w.quoteExactIn("sell", b.out);
      if (s) assert.ok(s.out < b.netIn);
    }
    const s1 = v.quoteExactIn("sell", a);
    const s2 = v.quoteExactIn("sell", a * 2n);
    if (s1 && s2) assert.ok(s2.out >= s1.out);
    if (s1) assert.ok(s1.out < v.quoteVault && s1.netIn === a);
  }
});

test("fee schedule: tier boundaries, per-pool creator override, no coin creator, non-pump pool", () => {
  const v = venue();
  const tiers = v.feeConfig!.feeTiers;
  assert.deepEqual(calculateFeeTier(tiers, 0n), tiers[0].fees);
  const t = tiers[5];
  assert.deepEqual(calculateFeeTier(tiers, t.marketCapLamportsThreshold), t.fees);
  assert.deepEqual(calculateFeeTier(tiers, t.marketCapLamportsThreshold - 1n), tiers[4].fees);
  assert.deepEqual(calculateFeeTier(tiers, 10n ** 30n), tiers[tiers.length - 1].fees);
  const ctx = { global: v.global!, feeConfig: v.feeConfig!, pool: v.poolState!, isPumpPool: true, baseSupply: v.baseSupply };
  const B = v.baseReserve;
  const Q = v.quoteReserve();
  const base = computeFees(ctx, B, Q);
  assert.deepEqual(computeFees({ ...ctx, pool: { ...ctx.pool, creatorFeeBps: 77n } }, B, Q), { ...base, creatorFeeBps: 77n });
  assert.equal(computeFees({ ...ctx, pool: { ...ctx.pool, coinCreator: PublicKey.default } }, B, Q).creatorFeeBps, 0n);
  assert.deepEqual(computeFees({ ...ctx, isPumpPool: false }, B, Q), v.feeConfig!.flatFees);
  // fee tier switches with the reserves a trade starts from, not after it
  assert.deepEqual(v.currentFees(), base);
});

test("quoteKey changes with state; accounts() grows after the first update; latency is µs-level", () => {
  const v = new PumpSwapPool({ pool: POOL, tokenMint: MAX_MINT });
  assert.equal(v.accounts().length, 5);
  const m = infos();
  v.update(snap.slot, m);
  assert.ok(v.accounts().length === 8 && v.ready());
  const k0 = v.quoteKey();
  v.update(snap.slot, m);
  assert.equal(v.quoteKey(), k0);
  const vault = v.poolState!.poolQuoteTokenAccount.toBase58();
  const d = Buffer.from(m.get(vault)!.data);
  d.writeBigUInt64LE(d.readBigUInt64LE(64) + 1n, 64);
  m.set(vault, { ...m.get(vault)!, data: d });
  v.update(snap.slot + 1, m);
  assert.notEqual(v.quoteKey(), k0);
  const N = 20000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) v.quoteExactIn(i & 1 ? "buy" : "sell", 1_000_000n + BigInt(i) * 997n);
  const us = Number(process.hrtime.bigint() - t0) / N / 1000;
  assert.ok(us < 50, `${us} us/quote`);
});
