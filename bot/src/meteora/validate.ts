// Live validation of MeteoraDlmm quotes against mainnet simulateTransaction.
//
//   NODE_USE_ENV_PROXY=1 npx tsx src/meteora/validate.ts [--write-fixtures]
//
// For each (side, mode, size): snapshot all venue accounts + the user's token accounts, quote,
// build the swap ix with minOut = quote.out (exact-in) / maxIn = quote.inp (exact-out), simulate
// (sigVerify:false, replaceRecentBlockhash:true) requesting post-state of the user's token
// accounts and the Clock sysvar, re-snapshot, and compare balance deltas to the quote. The case is
// only scored if pool/bin arrays/user accounts were unchanged across the simulation window. The
// quote is recomputed with the Clock the simulation actually ran at (variable fee decays with time).
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AccountInfo,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { gzipSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { MeteoraDlmm, Side } from "./index.js";
import { getMultipleAccounts, rpc } from "./rpc.js";
import { ClockState, decodeBinArray, decodeClock, decodeLbPair, decodeTokenAmount } from "./layout.js";
import { POOL, SYSVAR_CLOCK, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, ata } from "./pda.js";
import { RISE_MINT, WSOL_MINT } from "../types.js";

const RISE = new PublicKey(RISE_MINT);
const WSOL = new PublicKey(WSOL_MINT);
// Reference arb wallet: holds ~208 SOL of wSOL (buyRise tests).
const REF = new PublicKey("24Q5e2FRebiFs3iWvN6pZYA4UTGzA3WUsci4ChhgfYEU");
// A plain system wallet holding ~57.8k RISE (sellRise tests); it has no wSOL ATA, so the sim
// creates it idempotently first. Override with SELL_USER=<pubkey>.
const SELLER = new PublicKey(process.env.SELL_USER ?? "72wotPiwDKz1rf3xdf4hVExjfeuGgR4wQGrHpmobJhHC");

const SOL = 1_000_000_000n;
const RISE_UNIT = 1_000_000_000n;

interface Case {
  side: Side;
  mode: "exactIn" | "exactOut";
  amount: bigint;
}

const cases: Case[] = [
  // buyRise exact-in: lamports in
  ...[1_000_000n, SOL / 10n, SOL, 5n * SOL, 25n * SOL, 100n * SOL, 200n * SOL].map((amount) => ({ side: "buyRise" as Side, mode: "exactIn" as const, amount })),
  // buyRise exact-out: RISE out
  ...[10n, 1_000n, 10_000n, 100_000n, 150_000n].map((r) => ({ side: "buyRise" as Side, mode: "exactOut" as const, amount: r * RISE_UNIT + 123_456_789n })),
  // sellRise exact-in: RISE in
  ...[1n, 100n, 1_000n, 10_000n, 30_000n, 57_000n].map((r) => ({ side: "sellRise" as Side, mode: "exactIn" as const, amount: r * RISE_UNIT + 987_654_321n })),
  // sellRise exact-out: lamports out
  ...[1_000_000n, SOL / 10n, SOL, 10n * SOL, 30n * SOL].map((amount) => ({ side: "sellRise" as Side, mode: "exactOut" as const, amount: amount + 4_321n })),
];

const SWAP_EVENT = Buffer.from([81, 108, 227, 190, 205, 208, 10, 196]);

function decodeSwapEvent(innerIxs: any[]): { amountIn: bigint; amountOut: bigint; fee: bigint; protocolFee: bigint; hostFee: bigint; start: number; end: number } | null {
  for (const g of innerIxs ?? [])
    for (const ix of g.instructions) {
      let d: Buffer;
      try {
        d = decodeIxData(ix.data);
      } catch {
        continue;
      }
      if (d.length < 16 + 129) continue;
      if (d.subarray(0, 8).toString("hex") !== "e445a52e51cb9a1d" || !d.subarray(8, 16).equals(SWAP_EVENT)) continue;
      const b = d.subarray(16);
      return {
        start: b.readInt32LE(64),
        end: b.readInt32LE(68),
        amountIn: b.readBigUInt64LE(72),
        amountOut: b.readBigUInt64LE(80),
        fee: b.readBigUInt64LE(89),
        protocolFee: b.readBigUInt64LE(97),
        hostFee: b.readBigUInt64LE(121),
      };
    }
  return null;
}

// inner instruction data comes back base58 in jsonParsed/json encodings
import bs58 from "bs58";
function decodeIxData(s: string): Buffer {
  return Buffer.from(bs58.decode(s));
}

const sameData = (a: AccountInfo<Buffer> | null | undefined, b: AccountInfo<Buffer> | null | undefined) =>
  (!a && !b) || (!!a && !!b && a.data.equals(b.data));

async function snapshot(venue: MeteoraDlmm, extra: PublicKey[]) {
  // two passes on the first call so the bin arrays are known
  let s = await getMultipleAccounts([...venue.accounts(), ...extra]);
  venue.update(s.slot, s.infos);
  const want = venue.accounts();
  if (want.some((k) => !s.infos.has(k.toBase58()))) {
    s = await getMultipleAccounts([...want, ...extra]);
    venue.update(s.slot, s.infos);
  }
  return s;
}

function quoteFor(venue: MeteoraDlmm, c: Case) {
  if (c.mode === "exactIn") {
    const q = venue.quoteExactIn(c.side, c.amount);
    return q && { inGross: c.amount, netIn: q.netIn, out: q.out, binArrays: q.binArrays, fee: q.fee, protocolFee: q.protocolFee, hostFee: q.hostFee, end: q.endBinId };
  }
  const q = venue.quoteExactOut(c.side, c.amount);
  return q && { inGross: q.inp, netIn: q.netIn, out: c.amount, binArrays: q.binArrays, fee: q.fee, protocolFee: q.protocolFee, hostFee: q.hostFee, end: q.endBinId };
}

const fmt = (x: bigint) => x.toString();

/** leg A: buyRise exact-in solIn; leg B: sellRise exact-in (A.out / frac) RISE. Same tx, REF wallet. */
async function twoLeg(venue: MeteoraDlmm, solIn: bigint, frac: bigint) {
  const user = REF;
  const userRise = ata(user, RISE, TOKEN_2022_PROGRAM);
  const userWsol = ata(user, WSOL, TOKEN_PROGRAM);
  for (let attempt = 0; attempt < 4; attempt++) {
    const pre = await snapshot(venue, [userRise, userWsol]);
    const qA0 = venue.quoteExactIn("buyRise", solIn);
    if (!qA0) return null;
    const riseB = qA0.out / frac;
    const legsFor = (clock: ClockState | null) => {
      const v2 = new MeteoraDlmm();
      v2.update(pre.slot, pre.infos);
      if (clock) v2.clock = clock;
      const qA = v2.quoteExactIn("buyRise", solIn)!;
      if (!v2.applySwap("buyRise", "exactIn", solIn)) throw new Error("applySwap failed");
      const qB = v2.quoteExactIn("sellRise", riseB)!;
      v2.applySwap("sellRise", "exactIn", riseB);
      return { qA, qB, v2 };
    };
    const { qA: a0, qB: b0 } = legsFor(null);
    const touched = [...new Set([...a0.binArrays, ...b0.binArrays].map((k) => k.toBase58()))];
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      venue.swapExactInIx(user, "buyRise", solIn, a0.out, a0.binArrays),
      venue.swapExactInIx(user, "sellRise", riseB, b0.out, b0.binArrays),
    ];
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message());
    const sim: any = await rpc("simulateTransaction", [
      Buffer.from(tx.serialize()).toString("base64"),
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
        accounts: { encoding: "base64", addresses: [userRise.toBase58(), userWsol.toBase58(), SYSVAR_CLOCK.toBase58(), POOL.toBase58(), ...touched] },
      },
    ]);
    const post = await getMultipleAccounts([...venue.accounts(), userRise, userWsol]);
    const stable = [...venue.accounts().filter((k) => !k.equals(SYSVAR_CLOCK)), userRise, userWsol].every((k) => sameData(pre.infos.get(k.toBase58()), post.infos.get(k.toBase58())));
    if (!stable) continue;
    const v = sim.value;
    if (v.err) return { side: "twoLeg", mode: `buy ${solIn} then sell 1/${frac}`, amount: solIn, simErr: JSON.stringify(v.err), logs: v.logs?.slice(-5) };
    const simClock = decodeClock(Buffer.from(v.accounts[2].data[0], "base64"));
    const { qA, qB, v2 } = legsFor(simClock);
    const dRise = decodeTokenAmount(Buffer.from(v.accounts[0].data[0], "base64")) - decodeTokenAmount(pre.infos.get(userRise.toBase58())!.data);
    const dWsol = decodeTokenAmount(Buffer.from(v.accounts[1].data[0], "base64")) - decodeTokenAmount(pre.infos.get(userWsol.toBase58())!.data);
    const qRise = qA.out - qB.netIn;
    const qWsol = qB.out - qA.netIn;
    // compare modelled post-state vs simulated post-state
    const simLb = decodeLbPair(Buffer.from(v.accounts[3].data[0], "base64"));
    const mine = v2.lbPair!;
    let binMismatch = 0;
    touched.forEach((k, i) => {
      const sb = decodeBinArray(Buffer.from(v.accounts[4 + i].data[0], "base64"));
      const mb = v2.binArrays.get(sb.index)!;
      sb.bins.forEach((b, j) => {
        if (b.amountX !== mb.bins[j].amountX || b.amountY !== mb.bins[j].amountY) binMismatch++;
      });
    });
    const stateMatch =
      simLb.activeId === mine.activeId &&
      simLb.v.volatilityAccumulator === mine.v.volatilityAccumulator &&
      simLb.v.volatilityReference === mine.v.volatilityReference &&
      simLb.v.indexReference === mine.v.indexReference &&
      simLb.v.lastUpdateTimestamp === mine.v.lastUpdateTimestamp &&
      binMismatch === 0;
    return {
      side: "twoLeg",
      mode: `buy ${solIn} then sell 1/${frac}`,
      amount: solIn,
      slot: sim.context.slot,
      quoteNetIn: `dRise ${qRise}`,
      simNetIn: `dRise ${dRise}`,
      quoteOut: `dWsol ${qWsol}`,
      simOut: `dWsol ${dWsol}`,
      bins: `A->${qA.endBinId} B->${qB.endBinId}`,
      postState: { sim: { active: simLb.activeId, ...simLb.v }, model: { active: mine.activeId, ...mine.v }, binMismatch },
      match: dRise === qRise && dWsol === qWsol && stateMatch,
    };
  }
  return null;
}

async function main() {
  const writeFixtures = process.argv.includes("--write-fixtures");
  const venue = new MeteoraDlmm();
  const rows: any[] = [];
  const fixtureCases: any[] = [];
  let fixtureSnap: { slot: number; infos: Record<string, string> } | null = null;
  const sameAsFixture = (infos: Map<string, AccountInfo<Buffer> | null>) =>
    !!fixtureSnap &&
    venue
      .accounts()
      .filter((k) => !k.equals(SYSVAR_CLOCK) && fixtureSnap!.infos[k.toBase58()] !== undefined)
      .every((k) => fixtureSnap!.infos[k.toBase58()] === infos.get(k.toBase58())?.data.toString("base64"));

  for (const c of cases) {
    const user = c.side === "buyRise" ? REF : SELLER;
    const userRise = ata(user, RISE, TOKEN_2022_PROGRAM);
    const userWsol = ata(user, WSOL, TOKEN_PROGRAM);
    const [tin, tout] = c.side === "sellRise" ? [userRise, userWsol] : [userWsol, userRise];
    let attempt = 0;
    let row: any = null;
    while (attempt++ < 4) {
      const pre = await snapshot(venue, [tin, tout]);
      const preIn = pre.infos.get(tin.toBase58());
      const preOut = pre.infos.get(tout.toBase58());
      const balIn = preIn ? decodeTokenAmount(preIn.data) : 0n;
      const balOut = preOut ? decodeTokenAmount(preOut.data) : 0n;
      const q0 = quoteFor(venue, c);
      if (!q0) {
        row = { ...c, note: "quote=null (insufficient cached liquidity)" };
        break;
      }
      if (q0.inGross > balIn) {
        row = { ...c, note: `skipped: user balance ${balIn} < input ${q0.inGross}` };
        break;
      }
      const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];
      if (!preOut) ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, tout, user, c.side === "sellRise" ? WSOL : RISE, c.side === "sellRise" ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM));
      ixs.push(
        c.mode === "exactIn"
          ? venue.swapExactInIx(user, c.side, c.amount, q0.out, q0.binArrays)
          : venue.swapExactOutIx(user, c.side, c.amount, q0.inGross, q0.binArrays),
      );
      const msg = new TransactionMessage({ payerKey: user, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      const t0 = Date.now();
      const sim: any = await rpc("simulateTransaction", [
        Buffer.from(tx.serialize()).toString("base64"),
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "confirmed",
          innerInstructions: true,
          accounts: { encoding: "base64", addresses: [tin.toBase58(), tout.toBase58(), SYSVAR_CLOCK.toBase58()] },
        },
      ]);
      const post = await getMultipleAccounts([...venue.accounts(), tin, tout]);
      const stable = [...venue.accounts().filter((k) => !k.equals(SYSVAR_CLOCK)), tin, tout].every((k) => sameData(pre.infos.get(k.toBase58()), post.infos.get(k.toBase58())));
      if (!stable) {
        console.error(`state changed during sim (slots ${pre.slot}->${post.slot}), retrying ${c.side} ${c.mode} ${c.amount}`);
        continue;
      }
      const v = sim.value;
      // re-quote with the Clock the simulation ran at
      const clkData = v.accounts?.[2] ? Buffer.from(v.accounts[2].data[0], "base64") : null;
      const savedClock = venue.clock;
      if (clkData) venue.clock = decodeClock(clkData);
      const q = quoteFor(venue, c)!;
      const simClock = venue.clock;
      venue.clock = savedClock;
      const ev = v.err ? null : decodeSwapEvent(v.innerInstructions);
      if (v.err) {
        row = { ...c, slot: sim.context.slot, quoteNetIn: fmt(q.netIn), quoteOut: fmt(q.out), simErr: JSON.stringify(v.err), logs: (v.logs ?? []).slice(-6) };
      } else {
        const postIn = decodeTokenAmount(Buffer.from(v.accounts[0].data[0], "base64"));
        const postOut = decodeTokenAmount(Buffer.from(v.accounts[1].data[0], "base64"));
        const simNetIn = balIn - postIn;
        const simOut = postOut - balOut;
        row = {
          ...c,
          slot: sim.context.slot,
          quoteIn: fmt(q.inGross),
          simIn: ev ? fmt(ev.amountIn) : "?",
          quoteNetIn: fmt(q.netIn),
          simNetIn: fmt(simNetIn),
          quoteOut: fmt(q.out),
          simOut: fmt(simOut),
          quoteHostFee: fmt(q.hostFee),
          simHostFee: ev ? fmt(ev.hostFee) : "?",
          quoteProtocolFee: fmt(q.protocolFee),
          simProtocolFee: ev ? fmt(ev.protocolFee) : "?",
          quoteFee: fmt(q.fee),
          simFee: ev ? fmt(ev.fee) : "?",
          bins: ev ? `${ev.start}->${ev.end}` : "?",
          quoteEnd: q.end,
          elapsedSinceLastSwap: simClock ? Number(simClock.unixTimestamp - venue.lbPair!.v.lastUpdateTimestamp) : null,
          vaBranch: simClock
            ? (() => {
                const e = simClock.unixTimestamp - venue.lbPair!.v.lastUpdateTimestamp;
                return e < BigInt(venue.lbPair!.s.filterPeriod) ? "filter(keep ref)" : e < BigInt(venue.lbPair!.s.decayPeriod) ? "decay(VR=VA*R)" : "reset(VR=0)";
              })()
            : null,
          clockDelta: simClock && savedClock ? Number(simClock.unixTimestamp - savedClock.unixTimestamp) : null,
          requoteChanged: q.out !== q0.out || q.netIn !== q0.netIn,
          match: simNetIn === q.netIn && simOut === q.out && (!ev || (ev.amountIn === q.inGross && ev.hostFee === q.hostFee)),
          cu: v.unitsConsumed,
          ms: Date.now() - t0,
        };
        if (writeFixtures && row.match) {
          if (!fixtureSnap) {
            // keep the fixture small: lb_pair, clock, mint + bin arrays within +-3 of the active array
            const activeIdx = Math.floor(venue.lbPair!.activeId / 70);
            const keep = venue.accounts().filter((k) => {
              const a = pre.infos.get(k.toBase58());
              if (!a || a.data.length !== 10136) return true;
              return Math.abs(Number(a.data.readBigInt64LE(8)) - activeIdx) <= 3;
            });
            const infos: Record<string, string> = {};
            for (const k of keep) {
              const a = pre.infos.get(k.toBase58());
              if (a) infos[k.toBase58()] = a.data.toString("base64");
            }
            fixtureSnap = { slot: pre.slot, infos };
          }
          if (sameAsFixture(pre.infos) && clkData && q.end >= (Math.floor(venue.lbPair!.activeId / 70) - 3) * 70 && q.end < (Math.floor(venue.lbPair!.activeId / 70) + 4) * 70)
            fixtureCases.push({ side: c.side, mode: c.mode, amount: fmt(c.amount), inGross: fmt(q.inGross), netIn: fmt(q.netIn), out: fmt(q.out), hostFee: fmt(q.hostFee), simSlot: sim.context.slot, clock: clkData.toString("base64") });
        }
      }
      break;
    }
    if (!row) row = { ...c, note: "state kept changing; not scored" };
    rows.push(row);
    console.log(JSON.stringify(row, (_k, val) => (typeof val === "bigint" ? val.toString() : val)));
  }

  // ---- two swaps in one tx: verifies applySwap() (post-state) and the "elapsed < filter_period" branch
  for (const [solIn, frac] of [
    [5n * SOL, 2n],
    [40n * SOL, 1n],
  ] as const) {
    const rows2 = await twoLeg(venue, solIn, frac);
    if (rows2) {
      rows.push(rows2);
      console.log(JSON.stringify(rows2, (_k, val) => (typeof val === "bigint" ? val.toString() : val)));
    }
  }

  // latency
  const N = 2000;
  const sizes = [SOL / 100n, SOL, 10n * SOL, 50n * SOL];
  let t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) venue.quoteExactIn(i & 1 ? "buyRise" : "sellRise", sizes[i & 3] * (i & 1 ? 1n : 1500n));
  const perQuoteIn = Number(process.hrtime.bigint() - t) / N / 1000;
  t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) venue.quoteExactOut(i & 1 ? "buyRise" : "sellRise", i & 1 ? sizes[i & 3] * 1500n : sizes[i & 3]);
  const perQuoteOut = Number(process.hrtime.bigint() - t) / N / 1000;
  console.log(`latency: exactIn ${perQuoteIn.toFixed(1)} us/quote, exactOut ${perQuoteOut.toFixed(1)} us/quote (mixed sizes)`);
  console.log("depth", venue.depth(), "lbPair v", venue.lbPair?.v, "clock ts", venue.clock?.unixTimestamp);

  const scored = rows.filter((r) => r.match !== undefined);
  console.log(`\nSUMMARY: ${scored.filter((r) => r.match).length}/${scored.length} scored cases match exactly; ${rows.length - scored.length} not scored`);
  console.table(rows.map((r) => ({ side: r.side, mode: r.mode, amount: String(r.amount), qNetIn: r.quoteNetIn, sNetIn: r.simNetIn, qOut: r.quoteOut, sOut: r.simOut, bins: r.bins, va: r.vaBranch, match: r.match ?? r.note ?? r.simErr })));

  if (writeFixtures && fixtureSnap) {
    mkdirSync("fixtures/meteora", { recursive: true });
    writeFileSync("fixtures/meteora/sim-snapshot.json.gz", gzipSync(JSON.stringify({ ...fixtureSnap, cases: fixtureCases })));
    console.log(`wrote fixtures/meteora/sim-snapshot.json.gz (${fixtureCases.length} cases @ slot ${fixtureSnap.slot})`);
  }
  if (scored.some((r) => !r.match)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
