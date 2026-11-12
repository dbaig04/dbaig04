// Validate the local full-transaction simulator (src/engine/local-sim.ts) against mainnet, and
// optionally record offline fixtures for test/local-sim.test.ts. Simulation only: nothing is signed
// or sent (unsigned txs, sigVerify off on both simulators).
//
//   NODE_USE_ENV_PROXY=1 npx tsx src/research/local-sim-validate.ts [--sizes 0.01,0.05] [--rounds 1]
//       [--record test/fixtures/localsim] [--no-rpc]
//
// Per round: one RPC snapshot (processed) of everything the MAX venues + user + LocalSimAccounts
// need, then for each route x direction x size a real two-leg round-trip tx (leg-1 min-out = quoted
// tokens, leg-2 min-out = quoted lamports) plus two negative variants (leg-1 min-out + 1, leg-2
// min-out + 1). Checked:
//   (a) local Δ wSOL / Δ MAX == the venues' exact quotes, to the unit (positive cases);
//   (b) each negative variant fails locally with the program's slippage error;
//   (c) the same txs simulated on RPC (minContextSlot = snapshot slot) — agreement split by
//       "RPC context slot == snapshot slot" (later slots may have newer pool state).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ComputeBudgetProgram, Connection, PublicKey, type AccountInfo, type VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { keepAliveFetch } from "../feeds/http.js";
import { StateManager, TokenBalances } from "../engine/state.js";
import { MAX_SIM_USER, maxPairSpec, routeName } from "../engine/pair-venues.js";
import { UserPrereqs } from "../engine/pair-engine.js";
import { compileFitting } from "../engine/pair.js";
import { simulateArb } from "../engine/simulate.js";
import { compareSims, LocalSimAccounts, LocalTxSimulator, type LocalSimResult, type LocalSimSnapshot } from "../engine/local-sim.js";
import { MAX_MINT, type SwapVenue } from "../types.js";

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const has = (n: string) => process.argv.includes(`--${n}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LocalSimCase {
  name: string;
  route: string;
  direction: string;
  variant: "exact" | "leg1+1" | "leg2+1";
  tx: string; // base64 serialized (unsigned)
  lamportsIn: string;
  lamportsOut: string;
  expectWsolDelta: string;
  expectTokenDelta: string;
  /** Expected failing program for negative variants. */
  expectFail?: string;
}

export interface LocalSimFixture {
  slot: number;
  recordedAt: string;
  user: string;
  wsolAta: string;
  tokenAta: string;
  wsolPre: string;
  tokenPre: string;
  blockhash: string;
  accounts: Record<string, { owner: string; lamports: number; executable: boolean; data: string } | null>;
  cases: LocalSimCase[];
  /** RPC results observed while recording (informational). */
  rpc?: Record<string, { slot?: number; err?: unknown; wsolDelta?: string; tokenDelta?: string; cu?: number; reason?: string }>;
}

function buildCase(user: PublicKey, blockhash: string, buy: SwapVenue, sell: SwapVenue, lamports: bigint, variant: LocalSimCase["variant"]) {
  const qa = buy.quoteExactIn("buy", lamports);
  if (!qa) return null;
  const qb = sell.quoteExactIn("sell", qa.out);
  if (!qb) return null;
  const leg1Min = qa.out + (variant === "leg1+1" ? 1n : 0n);
  const leg2Min = qb.out + (variant === "leg2+1" ? 1n : 0n);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ...buy.swapExactInIxs(user, "buy", lamports, leg1Min, qa),
    ...sell.swapExactInIxs(user, "sell", qa.out, leg2Min, qb),
  ];
  const { tx } = compileFitting(user, blockhash, ixs);
  return { tx, qa, qb, expectWsol: qb.out - qa.netIn, expectTok: qa.out - qb.netIn, expectFail: variant === "exact" ? undefined : (variant === "leg1+1" ? buy : sell).name.split(":")[0] };
}

async function main() {
  const rpcUrl = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpcUrl, { commitment: "processed", fetch: keepAliveFetch() });
  const sizes = (arg("sizes", "0.01,0.05")!).split(",").map((x) => BigInt(Math.round(Number(x) * 1e9)));
  const rounds = Number(arg("rounds", "1"));
  const record = arg("record");
  const noRpc = has("no-rpc");
  const user = new PublicKey(process.env.PAIR_SIM_USER ?? MAX_SIM_USER);
  const spec = maxPairSpec({ ...process.env, MAX_DLMM_POOLS: undefined, MAX_DLMM_POOL: undefined });
  const venues: SwapVenue[] = [spec.pumpswap, ...spec.dlmmVenues];
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID);
  const tokenAta = getAssociatedTokenAddressSync(new PublicKey(MAX_MINT), user, true, TOKEN_2022_PROGRAM_ID);
  const balances = new TokenBalances(wsolAta, tokenAta);
  const prereqs = new UserPrereqs(venues, user);
  const la = new LocalSimAccounts(venues, user);
  const sm = new StateManager(conn, [...venues, balances, prereqs, la], "processed");
  const sim = new LocalTxSimulator({ conn, cacheDir: process.env.LOCAL_SIM_CACHE_DIR ?? "data/local-sim", checkIntervalMs: 0, onMissing: (k) => la.learn(k) });
  const t0 = performance.now();
  await sim.init();
  console.log(`local sim ready in ${Math.round(performance.now() - t0)} ms (programs + features + worker setup)`);
  const tally = { exact: 0, exactOk: 0, neg: 0, negOk: 0, rpcSame: 0, rpcSameAgree: 0, rpcLater: 0, rpcLaterAgree: 0, rpcNotRun: 0 };
  const localMs: number[] = [];
  for (let round = 0; round < rounds; round++) {
    // refresh twice: the first round of a fresh StateManager discovers bin arrays / reserves
    if (round === 0) { await sm.refresh(); await sleep(500); }
    let r = await sm.refresh();
    while (!r.updated) { await sleep(400); r = await sm.refresh(); }
    const snap = la.snapshot();
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    console.log(`\nround ${round + 1}: snapshot slot ${r.slot}; user ${user.toBase58()} wSOL ${balances.wsol} MAX ${balances.rise}`);
    const fixture: LocalSimFixture = { slot: r.slot, recordedAt: new Date().toISOString(), user: user.toBase58(), wsolAta: wsolAta.toBase58(), tokenAta: tokenAta.toBase58(), wsolPre: String(balances.wsol), tokenPre: String(balances.rise), blockhash, accounts: {}, cases: [], rpc: {} };
    const used = new Set<string>(["SysvarC1ock11111111111111111111111111111111"]);
    for (const route of spec.routes!) {
      for (const dir of ["buyAsellB", "buyBsellA"] as const) {
        const [buy, sell] = dir === "buyAsellB" ? [route.a, route.b] : [route.b, route.a];
        for (const size of sizes) {
          for (const variant of ["exact", "leg1+1", "leg2+1"] as const) {
            const c = buildCase(user, blockhash, buy, sell, size, variant);
            const name = `${route.name} ${dir} ${Number(size) / 1e9} SOL ${variant}`;
            if (!c) { console.log(`${name}: quote null (skipped)`); continue; }
            const plan = { lamportsIn: c.qa.netIn, lamportsOut: c.qb.out };
            const params = { wsolPre: balances.wsol!, risePre: balances.rise!, feeForUnits: () => ({ cuLimit: 600_000, fee: 5_000n }), profitFloorLamports: -(1n << 62n), toleranceLamports: 1n << 62n, toleranceBps: 0n };
            const local: LocalSimResult = await sim.simulate({ tx: c.tx, snapshot: snap, user, wsolAta, tokenAta, plan, params, blockhash: { value: blockhash, ageMs: 0 } });
            localMs.push(local.ms);
            for (const k of c.tx.message.staticAccountKeys) used.add(k.toBase58());
            let verdict: string;
            if (local.refused) verdict = `REFUSED: ${local.refused}`;
            else if (variant === "exact") {
              tally.exact++;
              const ok = local.execOk && local.wsolDelta === c.expectWsol && local.riseDelta === c.expectTok;
              if (ok) tally.exactOk++;
              verdict = `${ok ? "EXACT" : "MISMATCH"}: local Δ wSOL ${local.wsolDelta} / Δ MAX ${local.riseDelta} vs quote ${c.expectWsol} / ${c.expectTok}; CU ${local.unitsConsumed}; ${local.ms.toFixed(2)} ms (LiteSVM ${((local.workerSimUs ?? 0) / 1000).toFixed(2)} ms)${local.execOk ? "" : ` err ${local.errCanon ?? local.reason}`}`;
            } else {
              tally.neg++;
              const failingProgram = local.logs?.filter((l) => / failed: /.test(l)).at(-1);
              const ok = !local.execOk && !!local.errCanon?.startsWith("InstructionError");
              if (ok) tally.negOk++;
              verdict = `${ok ? "FAILS" : "UNEXPECTED"}: ${local.errCanon ?? "ok"} (${c.expectFail} min-out + 1) ${failingProgram ?? ""}`;
            }
            let rpcLine = "";
            if (!noRpc) {
              await sleep(350);
              const rs = performance.now();
              const rpc = await simulateArb(conn, c.tx, plan, { ...params, wsolAta, riseAta: tokenAta, minContextSlot: r.slot, slotWaitMs: 2000 });
              const ag = compareSims(local, rpc, r.slot);
              if (ag.class === "rpc-not-run") tally.rpcNotRun++;
              else if (ag.sameSlot) { tally.rpcSame++; if (ag.agree) tally.rpcSameAgree++; } else { tally.rpcLater++; if (ag.agree) tally.rpcLaterAgree++; }
              rpcLine = `\n      rpc slot ${rpc.slot} (${ag.sameSlot ? "same slot" : `+${ag.rpcSlotLag}`}), ${Math.round(performance.now() - rs)} ms: ${ag.class}${ag.cuEqual === false ? ` (CU local ${local.unitsConsumed} rpc ${rpc.unitsConsumed})` : ag.cuEqual ? " (CU equal)" : ""}${ag.details && !ag.agree ? ` — ${ag.details}` : ""}${ag.agree && ag.class === "agree-err" ? ` ${ag.details}` : ""}`;
              fixture.rpc![name] = { slot: rpc.slot, err: rpc.err, wsolDelta: rpc.wsolDelta?.toString(), tokenDelta: rpc.riseDelta?.toString(), cu: rpc.unitsConsumed, reason: rpc.reason };
            }
            console.log(`  ${name}: ${verdict}${rpcLine}`);
            fixture.cases.push({ name, route: route.name, direction: dir, variant, tx: Buffer.from(c.tx.serialize()).toString("base64"), lamportsIn: String(plan.lamportsIn), lamportsOut: String(plan.lamportsOut), expectWsolDelta: String(c.expectWsol), expectTokenDelta: String(c.expectTok), expectFail: c.expectFail });
          }
        }
      }
    }
    if (record) {
      mkdirSync(record, { recursive: true });
      for (const k of used) { const a = snap.get(k); if (a !== undefined) fixture.accounts[k] = a ? { owner: a.owner.toBase58(), lamports: a.lamports, executable: a.executable, data: a.data.toString("base64") } : null; }
      const f = join(record, `max-tx-${r.slot}.json.gz`);
      writeFileSync(f, gzipSync(Buffer.from(JSON.stringify(fixture)), { level: 9 }));
      const ctx = sim.context!;
      const cf = join(record, "chain-context.json.gz");
      writeFileSync(cf, gzipSync(Buffer.from(JSON.stringify({ slot: ctx.slot, rent: ctx.rent, knownFeatures: ctx.knownFeatures, features: ctx.features.map((x) => ({ id: new PublicKey(x.id).toBase58(), slot: x.slot })), programs: ctx.programs.map((p) => ({ id: p.id, loader: p.loader, programData: p.programData, deploySlot: p.deploySlot, sha256: p.sha256, elf: p.elf.toString("base64") })) })), { level: 9 }));
      console.log(`recorded ${f} (${Object.keys(fixture.accounts).length} accounts, ${fixture.cases.length} txs) and ${cf}`);
    }
    if (round + 1 < rounds) await sleep(3000);
  }
  const s = [...localMs].sort((a, b) => a - b);
  console.log(`\nsummary: exact cases ${tally.exactOk}/${tally.exact} match the quotes to the unit; negative cases ${tally.negOk}/${tally.neg} fail with an instruction error; local ms median ${s[Math.floor(s.length / 2)]?.toFixed(2)} p95 ${s[Math.floor(0.95 * (s.length - 1))]?.toFixed(2)} max ${s.at(-1)?.toFixed(2)}`);
  if (!noRpc) console.log(`RPC agreement: same slot ${tally.rpcSameAgree}/${tally.rpcSame}; later slot ${tally.rpcLaterAgree}/${tally.rpcLater}; RPC not run ${tally.rpcNotRun}`);
  console.log(`worker: spawns ${sim.spawns}, crashes ${sim.crashes}, timeouts ${sim.timeouts}`);
  sim.close();
  process.exit(0);
}

void routeName;
main().catch((e) => { console.error(String((e as Error).stack ?? e).replace(/https?:\/\/\S+/g, "<url>")); process.exit(1); });
export type { VersionedTransaction, AccountInfo, LocalSimSnapshot };
