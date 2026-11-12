// Live validation of the generic DLMM SwapVenue adapter (DlmmSwapVenue over MeteoraDlmm) on MAX/SOL
// pools against mainnet simulateTransaction. Read-only (sigVerify:false, replaceRecentBlockhash:true).
//
//   NODE_USE_ENV_PROXY=1 npx tsx src/meteora/validate-max.ts [--pool <lb_pair>] [--only|--extra side:amount,...] [--write-fixtures]
//
// Default pool 5nwdWt... (deepest MAX/SOL DLMM, InputOnly fees). Gt5wsV... / H6Bcgd... are OnlyY
// (fee on wSOL) pools and exercise the fee-on-output branch of sells.
// buy = SOL -> MAX exact-in (research wallet 8pY1Au..., ~410 SOL wSOL), sell = MAX -> SOL exact-in
// (BM9Ccy..., ~3.7M MAX; its wSOL ATA is created idempotently in the simulated tx).
// A case is scored only if lb_pair + cached bin arrays + mints were byte-identical before and after
// the simulation; the quote is recomputed at the Clock the simulation ran at.
import { ComputeBudgetProgram, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { MAX_MINT, WSOL_MINT } from "../types.js";
import type { SwapSide } from "../types.js";
import { getMultipleAccounts, rpc, simulateIxs, snapshotFor, Snapshot } from "./rpc.js";
import { DlmmSwapVenue, DlmmQuoteCtx } from "./venue.js";
import { decodeSwapEvent } from "./events.js";
import { decodeClock, decodeTokenAmount } from "./layout.js";
import { PROGRAM, SYSVAR_CLOCK, ata } from "./pda.js";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const POOL = arg("--pool") ?? "5nwdWtMHvrcUPJpoXSYWcPQv9wkoNzhCME5XJ4KmktzJ";
const BUYER = new PublicKey(process.env.BUY_USER ?? "8pY1AukbuPgUE3EetyLa59rFLMimJGT94ZzbMEZcQF4w");
const SELLER = new PublicKey(process.env.SELL_USER ?? "BM9CcyErJcu2mjrFvUsRRrD3snGeHDDVirJLvL6EjvMN");
const SOL = 1_000_000_000n;
const WSOL = new PublicKey(WSOL_MINT);
const MAXK = new PublicKey(MAX_MINT);
const j = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

const venue = new DlmmSwapVenue({ pool: POOL, tokenMint: MAX_MINT, binArrayWindow: 12 });
const d = venue.dlmm;

const sameData = (a: Snapshot, b: Snapshot, keys: PublicKey[]) =>
  keys.every((k) => {
    const x = a.infos.get(k.toBase58());
    const y = b.infos.get(k.toBase58());
    return (!x && !y) || (!!x && !!y && x.data.equals(y.data));
  });

const fixtureCases: any[] = [];
const blobs: Record<string, { owner: string; data: string }> = {};
const this_pool = () => POOL;

async function single(side: SwapSide, amount: bigint) {
  const user = side === "buy" ? BUYER : SELLER;
  const uMax = ata(user, MAXK, d.tokenProgramX ?? PublicKey.default);
  const uW = ata(user, WSOL, d.tokenProgramY ?? PublicKey.default);
  const [tin, tout] = side === "buy" ? [uW, uMax] : [uMax, uW];
  for (let attempt = 0; attempt < 6; attempt++) {
    const pre = await snapshotFor([venue], [tin, tout]);
    const inInfo = pre.infos.get(tin.toBase58());
    const outInfo = pre.infos.get(tout.toBase58());
    const balIn = inInfo ? decodeTokenAmount(inInfo.data) : 0n;
    const balOut = outInfo ? decodeTokenAmount(outInfo.data) : 0n;
    const q0 = venue.quoteExactIn(side, amount);
    if (!q0) return { side, amount, note: "quote=null (insufficient cached liquidity)" };
    if (amount > balIn) return { side, amount, note: `skipped: balance ${balIn} < ${amount}` };
    const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];
    if (!outInfo) ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, tout, user, side === "buy" ? MAXK : WSOL, side === "buy" ? d.tokenProgramX! : d.tokenProgramY!));
    ixs.push(...venue.swapExactInIxs(user, side, amount, q0.out, q0));
    const sim = await simulateIxs(user, ixs, [tin, tout, SYSVAR_CLOCK]);
    const keys = venue.accounts().filter((k) => !k.equals(SYSVAR_CLOCK));
    const post = await snapshotFor([], [...keys, tin, tout]);
    // the public RPC is load-balanced: a simulation served by a node behind our snapshot can run on an
    // older state that pre/post byte-equality does not catch
    if (sim.slot < pre.slot || post.slot < sim.slot) {
      console.error(`  sim slot ${sim.slot} outside snapshot window ${pre.slot}..${post.slot}, retry ${side} ${amount}`);
      continue;
    }
    if (!sameData(pre, post, [...keys, tin, tout])) {
      console.error(`  state changed during sim (slots ${pre.slot}->${post.slot}), retry ${side} ${amount}`);
      continue;
    }
    const saved = d.clock;
    d.clock = decodeClock(sim.accounts[2]!);
    const q = venue.quoteExactIn(side, amount)!;
    const simClock = d.clock;
    d.clock = saved;
    if (sim.err) return { side, amount, slot: sim.slot, quoteOut: q.out, simErr: j(sim.err), logs: sim.logs.slice(-6) };
    const c = q.ctx as DlmmQuoteCtx;
    const ev = decodeSwapEvent(sim.innerInstructions);
    const simNetIn = balIn - decodeTokenAmount(sim.accounts[0]!);
    const simOut = decodeTokenAmount(sim.accounts[1]!) - balOut;
    const evOk = !!ev && ev.amountIn === amount && ev.hostFee === c.q.hostFee && ev.fee === c.q.fee && ev.amountOut === c.q.out && ev.protocolFee === c.q.protocolFee;
    const match = simNetIn === q.netIn && simOut === q.out && evOk;
    const lb = d.lbPair!;
    const el = simClock!.unixTimestamp - lb.v.lastUpdateTimestamp;
    const row = {
      side,
      amount,
      slot: sim.slot,
      window: `${pre.slot}..${post.slot}`,
      quoteNetIn: q.netIn,
      simNetIn,
      quoteOut: q.out,
      simOut,
      rebateInOut: c.rebateInOut,
      hostFee: c.q.hostFee,
      evHost: ev?.hostFee,
      fee: c.q.fee,
      evFee: ev?.fee,
      protocolFee: c.q.protocolFee,
      evProtocolFee: ev?.protocolFee,
      bins: ev ? `${ev.start}->${ev.end}` : "?",
      feeOnInput: d.feeIsOnInput(c.side),
      vaBranch: el < BigInt(lb.s.filterPeriod) ? "filter" : el < BigInt(lb.s.decayPeriod) ? "decay" : "reset",
      requoteChanged: q.out !== q0.out,
      match,
      cu: sim.unitsConsumed,
    };
    if (match && process.argv.includes("--write-fixtures")) {
      // per-case snapshot (deduplicated by content): lb_pair, mints and the bin arrays the quote uses
      const want = new Set([this_pool(), ...[d.mintXKey!, d.mintYKey!].map((k) => k.toBase58()), ...c.q.binArrays.map((k) => k.toBase58())]);
      const accts: Record<string, string> = {};
      for (const k of want) {
        const a = pre.infos.get(k);
        if (!a) continue;
        const h = createHash("sha256").update(a.data).digest("hex").slice(0, 16);
        blobs[h] ??= { owner: a.owner.toBase58(), data: a.data.toString("base64") };
        accts[k] = h;
      }
      fixtureCases.push({ side, amount: amount.toString(), netIn: q.netIn.toString(), out: q.out.toString(), hostFee: c.q.hostFee.toString(), slot: pre.slot, accounts: accts, clock: sim.accounts[2]!.toString("base64") });
    }
    return row;
  }
  return { side, amount, note: "state kept changing; not scored" };
}

async function main() {
  const s0 = await snapshotFor([venue], []);
  const lb = d.lbPair!;
  const dep = d.depth()!;
  // on-chain identity / status checks
  const lbInfo = s0.infos.get(POOL)!;
  const mintXInfo = s0.infos.get(lb.tokenXMint.toBase58());
  const mintYInfo = s0.infos.get(lb.tokenYMint.toBase58());
  const near = (w: number) => {
    let x = 0n;
    let y = 0n;
    for (const ba of d.binArrays.values())
      ba.bins.forEach((bn, i) => {
        const id = ba.index * 70 + i;
        if (Math.abs(id - lb.activeId) <= w) {
          x += bn.amountX;
          y += bn.amountY;
        }
      });
    return { maxUnits: x, lamports: y };
  };
  const sigs: any[] = await rpc("getSignaturesForAddress", [POOL, { limit: 1000 }]);
  const span = sigs.length > 1 ? sigs[0].blockTime - sigs[sigs.length - 1].blockTime : 0;
  const checks = {
    ownerIsDlmm: lbInfo.owner.equals(PROGRAM),
    tokenXIsMax: lb.tokenXMint.equals(MAXK),
    tokenYIsWsol: lb.tokenYMint.equals(WSOL),
    mintXOwner: mintXInfo?.owner.toBase58(),
    mintYOwner: mintYInfo?.owner.toBase58(),
    statusEnabled: lb.status === 0,
    activationType: lb.activationType,
    activationPoint: lb.activationPoint,
    activated: lb.activationType === 0 ? d.clock!.slot >= lb.activationPoint : d.clock!.unixTimestamp >= lb.activationPoint,
    pairType: lb.pairType,
    feeParams: { baseFactor: lb.s.baseFactor, baseFeePowerFactor: lb.s.baseFeePowerFactor, variableFeeControl: lb.s.variableFeeControl, maxVolatilityAccumulator: lb.s.maxVolatilityAccumulator, filterPeriod: lb.s.filterPeriod, decayPeriod: lb.s.decayPeriod, reductionFactor: lb.s.reductionFactor, protocolShare: lb.s.protocolShare },
    volatility: lb.v,
    liquidityActiveBin: near(0),
    liquidityPm5Bins: near(5),
    liquidityPm20Bins: near(20),
    sigsPerHour: span > 0 ? Math.round((sigs.length / span) * 3600) : null,
    sigsOkFrac: sigs.length ? sigs.filter((x) => x.err === null).length / sigs.length : null,
    lastSigAgeS: sigs.length ? Math.round(Date.now() / 1000 - sigs[0].blockTime) : null,
  };
  console.log(j({ checks }));
  if (!checks.ownerIsDlmm || !checks.tokenXIsMax || !checks.tokenYIsWsol || !checks.statusEnabled || !checks.activated) throw new Error(`pool ${POOL} failed identity/status checks`);
  console.log(
    j({
      pool: POOL,
      slot: d.slot,
      activeId: lb.activeId,
      binStep: lb.binStep,
      baseFeeRate: d.baseFeeRate(),
      collectFeeMode: lb.s.collectFeeMode,
      functionType: lb.s.functionType,
      tokenProgramX: d.tokenProgramX?.toBase58(),
      tokenProgramY: d.tokenProgramY?.toBase58(),
      mintXExt: d.mintX?.extensions,
      binArrays: [...d.binArrays.keys()],
      binArrayVersions: [...new Set([...d.binArrays.values()].map((b) => b.version))],
      depth: dep,
    }),
  );
  const px = dep.activePrice; // lamports per MAX base unit
  const rows: any[] = [];
  const buys = [1_000_000n, 10_000_000n, 50_000_000n, 100_000_000n + 7n, 500_000_000n, SOL + 3n, 5n * SOL, 20n * SOL];
  const sells = [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 20].map((s) => BigInt(Math.floor((s * 1e9) / px)) + 321n);
  const only = arg("--only"); // e.g. --only sell:605532892221,buy:1000000 (replaces the default sizes)
  const extra = arg("--extra"); // same syntax, appended to the defaults (e.g. sizes that reach limit orders)
  if (only) {
    buys.length = 0;
    sells.length = 0;
  }
  if (only || extra) {
    for (const x of (only ?? extra)!.split(",")) {
      const [sd, amt] = x.split(":");
      (sd === "buy" ? buys : sells).push(BigInt(amt));
    }
  }
  for (const a of buys) {
    const r = await single("buy", a);
    rows.push(r);
    console.log(j(r));
  }
  for (const a of sells) {
    const r = await single("sell", a);
    rows.push(r);
    console.log(j(r));
  }
  // latency
  const N = 5000;
  const msz = [0.01, 0.1, 1, 10].map((s) => BigInt(Math.floor((s * 1e9) / px)));
  const ssz = [10_000_000n, 100_000_000n, SOL, 10n * SOL];
  let t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) venue.quoteExactIn("buy", ssz[i & 3]);
  const tb = Number(process.hrtime.bigint() - t) / N / 1000;
  t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) venue.quoteExactIn("sell", msz[i & 3]);
  const ts = Number(process.hrtime.bigint() - t) / N / 1000;
  console.log(`latency (0.01-10 SOL mixed): buy ${tb.toFixed(2)} us/quote, sell ${ts.toFixed(2)} us/quote`);
  const scored = rows.filter((r) => r.match !== undefined);
  console.log(`\nSUMMARY ${POOL}: ${scored.filter((r) => r.match).length}/${scored.length} scored cases match exactly; ${rows.length - scored.length} not scored`);
  console.table(rows.map((r) => ({ k: `${r.side} ${r.amount}`, qIn: r.quoteNetIn, sIn: r.simNetIn, qOut: r.quoteOut, sOut: r.simOut, host: r.hostFee, bins: r.bins, va: r.vaBranch, match: r.match ?? r.note ?? r.simErr })));
  if (process.argv.includes("--write-fixtures") && fixtureCases.length) {
    mkdirSync("fixtures/meteora", { recursive: true });
    const f = `fixtures/meteora/max-${POOL.slice(0, 6)}-sim.json.gz`;
    writeFileSync(f, gzipSync(JSON.stringify({ pool: POOL, mint: MAX_MINT, blobs, cases: fixtureCases })));
    console.log(`wrote ${f} (${fixtureCases.length} cases)`);
  }
  if (scored.some((r) => !r.match)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
