// Live validation of PumpSwapPool quotes (and PumpSwap <-> DLMM round trips) against mainnet
// simulateTransaction. Read-only: simulations use sigVerify:false and replaceRecentBlockhash:true.
//
//   NODE_USE_ENV_PROXY=1 npx tsx src/pumpswap/validate.ts [--no-single] [--no-roundtrip] [--dlmm <pool>] [--write-fixtures]
//
// Single-venue cases: snapshot pool/vaults/mint/global/fee config + the user's accounts, quote, build
// the v2 ix with minOut = quote.out, simulate, compare user balance deltas, pool vault deltas and the
// Buy/SellEvent fields. The pool trades ~1x/s, so the sim often runs on a newer state than our snapshot:
// every case is therefore ALSO re-quoted from the pre-trade state the program reports in its event
// (vault reserves, virtual reserves, base supply) — that re-quote must match to the base unit. A case
// is "stable" when the event state equals our snapshot (then the original quote is checked too).
//
// Round trips (one tx, research wallet as user): pump buy -> DLMM sell of the received MAX, and DLMM
// buy -> pump sell of the received MAX. Final wSOL/MAX deltas must equal the composed quotes.
import { ComputeBudgetProgram, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { MAX_MINT, WSOL_MINT } from "../types.js";
import { getMultipleAccounts, simulateIxs, snapshotFor, Snapshot } from "../meteora/rpc.js";
import { DlmmSwapVenue } from "../meteora/venue.js";
import { decodeSwapEvent } from "../meteora/events.js";
import { decodeClock } from "../meteora/layout.js";
import { SYSVAR_CLOCK } from "../meteora/pda.js";
import { PumpSwapPool, PumpSwapQuoteCtx } from "./index.js";
import { tokenAmount } from "./layout.js";
import { pumpEventsFromLogs } from "./events.js";
import type { SwapQuote, SwapSide } from "../types.js";

const POOL = "Eoe22HdCa9rhtBwKL6nNZmZxfuzF35xkxobcvfaF1vWQ";
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const DLMM_POOL = arg("--dlmm") ?? "5nwdWtMHvrcUPJpoXSYWcPQv9wkoNzhCME5XJ4KmktzJ";
// research wallet: ~410 SOL in its wSOL ATA, MAX ATA exists, user_volume_accumulator exists
const BUYER = new PublicKey(process.env.BUY_USER ?? "8pY1AukbuPgUE3EetyLa59rFLMimJGT94ZzbMEZcQF4w");
// a plain wallet holding ~3.7M MAX (no wSOL ATA, no volume accumulator)
const SELLER = new PublicKey(process.env.SELL_USER ?? "BM9CcyErJcu2mjrFvUsRRrD3snGeHDDVirJLvL6EjvMN");
const SOL = 1_000_000_000n;
const MAXU = 1_000_000n;
const WSOL = new PublicKey(WSOL_MINT);
const MAXK = new PublicKey(MAX_MINT);
const j = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

const venue = new PumpSwapPool({ pool: POOL, tokenMint: MAX_MINT });

/** Copy of `v` with reserves/supply replaced by the pre-trade state an event reports. */
function venueAtEvent(v: PumpSwapPool, ev: any): PumpSwapPool {
  const c = Object.assign(Object.create(Object.getPrototypeOf(v)), v) as PumpSwapPool;
  c.baseReserve = ev.poolBaseTokenReserves;
  c.quoteVault = ev.poolQuoteTokenReserves;
  if (ev.baseSupply !== undefined) c.baseSupply = ev.baseSupply;
  c.poolState = { ...v.poolState!, virtualQuoteReserves: ev.virtualQuoteReserves ?? v.poolState!.virtualQuoteReserves };
  return c;
}

const sameData = (a: Snapshot, b: Snapshot, keys: PublicKey[]) =>
  keys.every((k) => {
    const x = a.infos.get(k.toBase58());
    const y = b.infos.get(k.toBase58());
    return (!x && !y) || (!!x && !!y && x.data.equals(y.data));
  });

interface Row {
  [k: string]: unknown;
}
const fixtureCases: any[] = [];

async function single(side: SwapSide, amount: bigint): Promise<Row> {
  const user = side === "buy" ? BUYER : SELLER;
  for (let attempt = 0; attempt < 6; attempt++) {
    const pre = await snapshotFor([venue], [user]);
    const u = venue.userAccounts(user);
    const extra = [u.base, u.quote, u.uva];
    const preU = await getMultipleAccounts(extra);
    const [tin, tout] = side === "buy" ? [u.quote, u.base] : [u.base, u.quote];
    const balIn = preU.infos.get(tin.toBase58()) ? tokenAmount(preU.infos.get(tin.toBase58())!.data) : 0n;
    const outInfo = preU.infos.get(tout.toBase58());
    const balOut = outInfo ? tokenAmount(outInfo.data) : 0n;
    const q0 = venue.quoteExactIn(side, amount);
    if (!q0) return { side, amount, note: "quote=null" };
    if (q0.netIn > balIn) return { side, amount, note: `skipped: balance ${balIn} < ${q0.netIn}` };
    const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];
    if (!outInfo) ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, tout, user, side === "buy" ? MAXK : WSOL, side === "buy" ? venue.baseTokenProgram! : venue.quoteTokenProgram!));
    ixs.push(...venue.swapExactInIxs(user, side, amount, q0.out, q0));
    const p = venue.poolState!;
    const sim = await simulateIxs(user, ixs, [tin, tout, p.poolBaseTokenAccount, p.poolQuoteTokenAccount]);
    const post = await snapshotFor([], venue.accounts());
    const stableWindow = sameData(pre, post, venue.accounts());
    const evs = pumpEventsFromLogs(sim.logs);
    const ev = evs[0];
    if (sim.err) {
      const slip = sim.logs.some((l) => /slippage|ExceededSlippage|TooLittle|too little/i.test(l));
      if (slip && !stableWindow) continue; // the pool moved against us between snapshot and sim
      return { side, amount, slot: sim.slot, simErr: j(sim.err), logs: sim.logs.slice(-6), quoteOut: q0.out };
    }
    if (!ev) return { side, amount, note: "no event in sim logs", logs: sim.logs.slice(-6) };
    const at = venueAtEvent(venue, ev);
    const q = at.quoteExactIn(side, amount)!;
    const c = q.ctx as PumpSwapQuoteCtx;
    const simIn = balIn - tokenAmount(sim.accounts[0]!);
    const simOut = tokenAmount(sim.accounts[1]!) - balOut;
    const vb = tokenAmount(sim.accounts[2]!) - ev.poolBaseTokenReserves;
    const vq = tokenAmount(sim.accounts[3]!) - ev.poolQuoteTokenReserves;
    const stable = ev.poolBaseTokenReserves === venue.baseReserve && ev.poolQuoteTokenReserves === venue.quoteVault && ev.virtualQuoteReserves === p.virtualQuoteReserves && ev.baseSupply === venue.baseSupply;
    let evOk: boolean;
    let vaultOk: boolean;
    if (c.side === "buy") {
      const r = c.r;
      evOk = ev.baseAmountOut === r.baseOut && ev.userQuoteAmountIn === r.netQuote && ev.lpFee === r.lpFee && ev.protocolFee === r.protocolFee && ev.coinCreatorFee === r.coinCreatorFee && ev.buybackFee === r.buybackFee && ev.lpFeeBasisPoints === r.fees.lpFeeBps && ev.coinCreatorFeeBasisPoints === r.fees.creatorFeeBps;
      vaultOk = vb === -r.baseOut && vq === r.vaultIn;
    } else {
      const r = c.r;
      evOk = ev.quoteAmountOut === r.grossQuote && ev.userQuoteAmountOut === r.quoteOut && ev.lpFee === r.lpFee && ev.protocolFee === r.protocolFee && ev.coinCreatorFee === r.coinCreatorFee && ev.buybackFee === r.buybackFee && ev.coinCreatorFeeBasisPoints === r.fees.creatorFeeBps;
      vaultOk = vb === amount && vq === -r.vaultOut;
    }
    const match = simIn === q.netIn && simOut === q.out && evOk && vaultOk && (!stable || (q0.out === q.out && q0.netIn === q.netIn));
    const fees = c.r.fees;
    const row: Row = {
      side,
      amount,
      slot: sim.slot,
      stable,
      quoteNetIn: q.netIn,
      simNetIn: simIn,
      quoteOut: q.out,
      simOut,
      snapQuoteOut: q0.out,
      feesBps: `${fees.lpFeeBps}/${fees.protocolFeeBps}/${fees.creatorFeeBps}`,
      buyback: c.r.buybackFee,
      evOk,
      vaultOk,
      match,
      cu: sim.unitsConsumed,
      ix: ev.ixName ?? "sell_v2",
    };
    if (match)
      fixtureCases.push({
        side,
        amount: amount.toString(),
        state: { baseReserve: ev.poolBaseTokenReserves.toString(), quoteVault: ev.poolQuoteTokenReserves.toString(), virtual: ev.virtualQuoteReserves.toString(), baseSupply: ev.baseSupply.toString() },
        netIn: q.netIn.toString(),
        out: q.out.toString(),
        lpFee: c.r.lpFee.toString(),
        protocolFee: c.r.protocolFee.toString(),
        coinCreatorFee: c.r.coinCreatorFee.toString(),
        buybackFee: c.r.buybackFee.toString(),
      });
    return row;
  }
  return { side, amount, note: "pool kept moving against the quote; not scored" };
}

/** One tx: leg A on venue A (buy, SOL in), leg B on venue B (sell all MAX received). */
async function roundTrip(dir: "pump->dlmm" | "dlmm->pump", dlmm: DlmmSwapVenue, solIn: bigint): Promise<Row> {
  const user = BUYER;
  const A = dir === "pump->dlmm" ? venue : dlmm;
  const B = dir === "pump->dlmm" ? dlmm : venue;
  for (let attempt = 0; attempt < 8; attempt++) {
    const u = venue.userAccounts(user);
    const pre = await snapshotFor([venue, dlmm], [u.base, u.quote, u.uva]);
    const qa = A.quoteExactIn("buy", solIn);
    if (!qa) return { dir, solIn, note: "leg A quote null" };
    const qb = B.quoteExactIn("sell", qa.out);
    if (!qb) return { dir, solIn, note: "leg B quote null" };
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      ...A.swapExactInIxs(user, "buy", solIn, qa.out, qa),
      ...B.swapExactInIxs(user, "sell", qa.out, qb.out, qb),
    ];
    const sim = await simulateIxs(user, ixs, [u.quote, u.base, SYSVAR_CLOCK]);
    const post = await snapshotFor([], [...venue.accounts(), ...dlmm.accounts().filter((k) => !k.equals(SYSVAR_CLOCK))]);
    const dlmmKeys = dlmm.accounts().filter((k) => !k.equals(SYSVAR_CLOCK));
    const dlmmStable = sameData(pre, post, dlmmKeys);
    if (!dlmmStable) {
      console.error(`  ${dir}: DLMM state changed during sim window, retry`);
      continue;
    }
    if (sim.err) {
      const pumpMoved = !sameData(pre, post, venue.accounts());
      if (pumpMoved) {
        console.error(`  ${dir}: sim err ${j(sim.err)} with pump state moving, retry`);
        continue;
      }
      return { dir, solIn, simErr: j(sim.err), logs: sim.logs.slice(-8) };
    }
    // re-quote with the sim's Clock (DLMM fees decay with time) and the pump state from its event
    const ev = pumpEventsFromLogs(sim.logs)[0];
    const saved = dlmm.dlmm.clock;
    dlmm.dlmm.clock = decodeClock(sim.accounts[2]!);
    const pump = venueAtEvent(venue, ev);
    const VA = dir === "pump->dlmm" ? pump : dlmm;
    const VB = dir === "pump->dlmm" ? dlmm : pump;
    const ra = VA.quoteExactIn("buy", solIn)!;
    const rb = VB.quoteExactIn("sell", ra.out)!;
    dlmm.dlmm.clock = saved;
    const dW = tokenAmount(sim.accounts[0]!) - tokenAmount(pre.infos.get(u.quote.toBase58())!.data);
    const dM = tokenAmount(sim.accounts[1]!) - tokenAmount(pre.infos.get(u.base.toBase58())!.data);
    const qW = rb.out - ra.netIn;
    const qM = ra.out - rb.netIn;
    const dev = decodeSwapEvent(sim.innerInstructions);
    const pumpStable = ev.poolBaseTokenReserves === venue.baseReserve && ev.poolQuoteTokenReserves === venue.quoteVault;
    return {
      dir,
      solIn,
      slot: sim.slot,
      pumpStable,
      legA_out: ra.out,
      legB_out: rb.out,
      quoteDwsol: qW,
      simDwsol: dW,
      quoteDmax: qM,
      simDmax: dM,
      dlmmEvent: dev && { in: dev.amountIn, out: dev.amountOut, host: dev.hostFee, bins: `${dev.start}->${dev.end}` },
      match: dW === qW && dM === qM && (!pumpStable || (qa.out === ra.out && qb.out === rb.out)),
      cu: sim.unitsConsumed,
    };
  }
  return { dir, solIn, note: "state kept changing; not scored" };
}

async function main() {
  const rows: Row[] = [];
  const log = (r: Row) => {
    rows.push(r);
    console.log(j(r));
  };
  await snapshotFor([venue], []);
  const p = venue.poolState!;
  console.log(
    j({
      slot: venue.slot,
      baseReserve: venue.baseReserve,
      quoteVault: venue.quoteVault,
      virtual: p.virtualQuoteReserves,
      buckets: { protocol: p.protocolFees, creator: p.creatorFees },
      supply: venue.baseSupply,
      fees: venue.currentFees(),
      spot: venue.spotPrice(),
      buybackAta: venue.buybackAta?.toBase58(),
      baseTokenProgram: venue.baseTokenProgram?.toBase58(),
      mintExt: venue.baseMintInfo?.extensions,
    }),
  );
  const only = arg("--only-buy");
  if (only) for (const a of only.split(",")) log(await single("buy", BigInt(a)));
  else if (!process.argv.includes("--no-single")) {
    // 1_001_456 and 100_000_421: net + fees = budget - 1 (the fee-split "excess" is negative) at 75 bps
    const solSizes = [1_000_000n, 1_001_456n, 10_000_000n, 50_000_000n, 100_000_000n, 100_000_421n, 500_000_000n + 12_345n, SOL + 7n, 5n * SOL + 1n, 25n * SOL + 999n];
    for (const a of solSizes) log(await single("buy", a));
    const px = venue.spotPrice(); // lamports per base unit
    const maxSizes = [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 25, 100].map((s) => BigInt(Math.floor((s * 1e9) / px)) + 123n);
    for (const a of maxSizes) log(await single("sell", a));
    log(await single("sell", 1n));
    log(await single("buy", 1_000n));
  }
  if (!process.argv.includes("--no-roundtrip")) {
    const dlmm = new DlmmSwapVenue({ pool: DLMM_POOL, tokenMint: MAX_MINT });
    for (const dir of ["pump->dlmm", "dlmm->pump"] as const) for (const s of [10_000_000n, 100_000_000n, SOL]) log(await roundTrip(dir, dlmm, s));
  }
  // latency over the cached snapshot
  const N = 20000;
  const sizes = [1_000_000n, 100_000_000n, SOL, 10n * SOL];
  const msz = sizes.map((s) => BigInt(Math.floor(Number(s) / venue.spotPrice())));
  for (let i = 0; i < 2000; i++) venue.quoteExactIn(i & 1 ? "buy" : "sell", (i & 1 ? sizes : msz)[i & 3]);
  let t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) venue.quoteExactIn("buy", sizes[i & 3]);
  const tb = Number(process.hrtime.bigint() - t) / N / 1000;
  t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) venue.quoteExactIn("sell", msz[i & 3]);
  const ts = Number(process.hrtime.bigint() - t) / N / 1000;
  console.log(`latency: buy ${tb.toFixed(2)} us/quote, sell ${ts.toFixed(2)} us/quote`);

  const scored = rows.filter((r) => r.match !== undefined);
  console.log(`\nSUMMARY: ${scored.filter((r) => r.match).length}/${scored.length} scored cases match exactly; ${rows.length - scored.length} not scored`);
  console.table(rows.map((r) => ({ k: `${r.side ?? r.dir} ${r.amount ?? r.solIn}`, stable: r.stable ?? r.pumpStable, qIn: r.quoteNetIn, sIn: r.simNetIn, qOut: r.quoteOut ?? r.quoteDwsol, sOut: r.simOut ?? r.simDwsol, fees: r.feesBps, match: r.match ?? r.note ?? r.simErr })));
  if (process.argv.includes("--write-fixtures")) {
    mkdirSync("fixtures/pumpswap", { recursive: true });
    const keep = venue.accounts();
    const s = await getMultipleAccounts(keep);
    const infos: Record<string, { owner: string; data: string }> = {};
    for (const k of keep) {
      const a = s.infos.get(k.toBase58());
      if (a) infos[k.toBase58()] = { owner: a.owner.toBase58(), data: a.data.toString("base64") };
    }
    writeFileSync("fixtures/pumpswap/sim-cases.json.gz", gzipSync(JSON.stringify({ slot: s.slot, infos, cases: fixtureCases })));
    console.log(`wrote fixtures/pumpswap/sim-cases.json.gz (${fixtureCases.length} cases)`);
  }
  if (scored.some((r) => !r.match)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
