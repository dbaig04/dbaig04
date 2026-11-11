// Decision-path benchmark.
//
//   npx tsx src/engine/bench.ts record [--n 50] [--interval-ms 2500]   (needs RPC; NODE_USE_ENV_PROXY=1 behind a proxy)
//   npx tsx src/engine/bench.ts offline [--iters 300] [--baseline]      (replays fixtures/bench/snapshots.json.gz)
//   npx tsx src/engine/bench.ts live [--seconds 75] [--force-build]     (runs main.ts in simulate mode, reads the ledger)
//
// record: polls ~50 real mainnet snapshots of every account the venues + the reference
//   wallet's ATAs need (one getMultipleAccounts per snapshot, ≤ 1 req/s) and stores them
//   content-deduplicated + gzipped, with the RISE program binary.
// offline: per stage, median / p95 over many iterations:
//   ingest   = RiseNative/MeteoraDlmm/TokenBalances update() for the snapshot
//   warm     = RISE fast-grid build (only when RISE state changed)
//   optimize = two-stage optimizer over both directions
//   build    = buildArbTx (cached blockhash; unsigned and signed)
//   in two replays: "sequence" (snapshots in recorded order: real change pattern, unchanged
//   RISE state reuses the grid) and "cold" (RISE + DLMM state forced changed every iteration).
//   --baseline also times the previous exact-only optimizer on the same snapshots.
// live: spawns main.ts (MODE=simulate, RPC polling, LEDGER_TICK_LATENCY=1) and summarizes the
//   per-tick latency rows + simulation RTT from the ledger. Never sends (simulate mode).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { RiseNative } from "../rise/index.js";
import { MeteoraDlmm } from "../meteora/index.js";
import { TokenBalances } from "./state.js";
import { atasFor } from "./setup.js";
import { REFERENCE_WALLET } from "../config.js";
import { evaluate, optimize, maximize, domainFor, type OptimizerParams, type Plan, type Venues } from "./optimizer.js";
import { buildArbTx, finalMinOut } from "./tx.js";
import type { ExecFeePolicy } from "./fees.js";
import type { Direction } from "../types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const BENCH_FIXTURE = path.join(ROOT, "fixtures/bench/snapshots.json.gz");
const PROGRAM_FIXTURE = path.join(ROOT, "fixtures/rise/program.so.gz");
const BENCH_PROGRAM = path.join(ROOT, "fixtures/bench/program.so.gz");

// ---------------------------------------------------------------- fixture format

interface StoredAccount { l: number; o: string; e: boolean; d: string /* sha1 of data */ }
export interface BenchFixture {
  version: 1;
  recordedAt: string;
  user: string;
  programDeploySlot: string;
  /** "rise" = fixtures/rise/program.so.gz, "bench" = fixtures/bench/program.so.gz */
  program: "rise" | "bench";
  blobs: Record<string, string>; // sha1 -> base64 data
  snapshots: { slot: number; t: number; accounts: Record<string, StoredAccount | null> }[];
}

export interface LoadedSnapshot { slot: number; infos: Map<string, AccountInfo<Buffer> | null> }

export function loadBenchFixture(file = BENCH_FIXTURE): { fx: BenchFixture; snaps: LoadedSnapshot[]; programAccount: AccountInfo<Buffer>; programDataKey: string } {
  const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8")) as BenchFixture;
  const blobs = new Map(Object.entries(fx.blobs).map(([h, b]) => [h, Buffer.from(b, "base64")]));
  const owners = new Map<string, PublicKey>();
  const owner = (o: string) => { let k = owners.get(o); if (!k) { k = new PublicKey(o); owners.set(o, k); } return k; };
  const snaps = fx.snapshots.map((s) => {
    const infos = new Map<string, AccountInfo<Buffer> | null>();
    for (const [k, a] of Object.entries(s.accounts)) infos.set(k, a ? { lamports: a.l, owner: owner(a.o), executable: a.e, rentEpoch: 0, data: blobs.get(a.d)! } : null);
    return { slot: s.slot, infos };
  });
  const elf = zlib.gunzipSync(fs.readFileSync(fx.program === "rise" ? PROGRAM_FIXTURE : BENCH_PROGRAM));
  const hdr = Buffer.alloc(45);
  hdr.writeUInt32LE(3, 0);
  hdr.writeBigUInt64LE(BigInt(fx.programDeploySlot), 4);
  const programAccount: AccountInfo<Buffer> = { lamports: 0, owner: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"), executable: false, rentEpoch: 0, data: Buffer.concat([hdr, elf]) };
  const programDataKey = new RiseNative().acc.programData.toBase58();
  return { fx, snaps, programAccount, programDataKey };
}

// ---------------------------------------------------------------- record

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sha1 = (b: Buffer) => crypto.createHash("sha1").update(b).digest("hex");

async function record(n: number, intervalMs: number, out: string) {
  const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const user = new PublicKey(process.env.SIM_USER ?? REFERENCE_WALLET);
  const rise = new RiseNative();
  const dlmm = new MeteoraDlmm();
  const { wsolAta, riseAta } = atasFor(user);
  // program binary (once)
  const pd = await conn.getAccountInfo(rise.acc.programData, "confirmed");
  if (!pd) throw new Error("programdata not found");
  const deploy = pd.data.readBigUInt64LE(4);
  const elf = Buffer.from(pd.data.subarray(45));
  let program: "rise" | "bench" = "bench";
  if (fs.existsSync(PROGRAM_FIXTURE) && zlib.gunzipSync(fs.readFileSync(PROGRAM_FIXTURE)).equals(elf)) program = "rise";
  else { fs.mkdirSync(path.dirname(BENCH_PROGRAM), { recursive: true }); fs.writeFileSync(BENCH_PROGRAM, zlib.gzipSync(elf, { level: 9 })); }
  console.log(`program deploy slot ${deploy} (${program === "rise" ? "same as fixtures/rise/program.so.gz" : "saved to fixtures/bench/program.so.gz"})`);
  await sleep(1000);

  const blobs: Record<string, string> = {};
  const snaps: BenchFixture["snapshots"] = [];
  const keysNow = () => {
    const m = new Map<string, PublicKey>();
    for (const k of [...rise.accounts(), ...dlmm.accounts(), wsolAta, riseAta]) m.set(k.toBase58(), k);
    return [...m.values()];
  };
  let lastSlot = -1;
  let prevMarket = "", prevPool = "";
  while (snaps.length < n) {
    const t0 = Date.now();
    let keys = keysNow();
    let r = await conn.getMultipleAccountsInfoAndContext(keys, "confirmed");
    let infos = new Map<string, AccountInfo<Buffer> | null>(keys.map((k, i) => [k.toBase58(), r.value[i]]));
    dlmm.update(r.context.slot, infos);
    const more = keysNow();
    if (more.length !== keys.length) {
      await sleep(1000);
      keys = more;
      r = await conn.getMultipleAccountsInfoAndContext(keys, { commitment: "confirmed", minContextSlot: r.context.slot });
      infos = new Map(keys.map((k, i) => [k.toBase58(), r.value[i]]));
      dlmm.update(r.context.slot, infos);
    }
    if (r.context.slot !== lastSlot) {
      lastSlot = r.context.slot;
      const accounts: Record<string, StoredAccount | null> = {};
      for (const [k, a] of infos) {
        if (!a) { accounts[k] = null; continue; }
        const d = Buffer.from(a.data);
        const h = sha1(d);
        blobs[h] ??= d.toString("base64");
        accounts[k] = { l: a.lamports, o: a.owner.toBase58(), e: a.executable, d: h };
      }
      snaps.push({ slot: r.context.slot, t: Date.now(), accounts });
      const m = accounts[rise.acc.market.toBase58()]?.d ?? "", p = accounts[dlmm.pool.toBase58()]?.d ?? "";
      console.log(`#${snaps.length} slot ${r.context.slot} keys ${keys.length}${m !== prevMarket ? " RISE-market-changed" : ""}${p !== prevPool ? " pool-changed" : ""}`);
      prevMarket = m; prevPool = p;
    }
    await sleep(Math.max(1000, intervalMs - (Date.now() - t0)));
  }
  const fx: BenchFixture = { version: 1, recordedAt: new Date().toISOString(), user: user.toBase58(), programDeploySlot: deploy.toString(), program, blobs, snapshots: snaps };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zlib.gzipSync(Buffer.from(JSON.stringify(fx)), { level: 9 }));
  console.log(`wrote ${out}: ${snaps.length} snapshots, ${Object.keys(blobs).length} distinct blobs, ${(fs.statSync(out).size / 1024).toFixed(0)} KiB`);
}

// ---------------------------------------------------------------- offline

export const BENCH_POLICY: ExecFeePolicy = { baseFeeLamports: 5_000n, maxPriorityFeeLamports: 50_000n, maxTipLamports: 50_000n, maxShareBps: 1_000n, tipEnabled: false };
export const benchParams = (floor = 100_000n): OptimizerParams => ({ profitFloor: floor, txCost: 0n, fees: BENCH_POLICY, maxLamportsIn: 100_000_000n, minLamportsIn: 1_000_000n, legSlippageBps: 0n });

export function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN);
  return { n: s.length, median: q(0.5), p95: q(0.95), max: s.at(-1) ?? NaN, mean: s.reduce((a, b) => a + b, 0) / (s.length || 1) };
}
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(x < 1 ? 3 : 2) : "-");
function row(name: string, xs: number[]) {
  const s = stats(xs);
  console.log(`  ${name.padEnd(34)} n=${String(s.n).padStart(4)}  median ${f2(s.median).padStart(8)} ms  p95 ${f2(s.p95).padStart(8)} ms  max ${f2(s.max).padStart(8)} ms`);
}

/** Venue setup over the fixture (program loaded, fast range = allowed trade range). */
export function benchVenues(fixture = BENCH_FIXTURE, range: { lo: bigint; hi: bigint } = { lo: 1_000_000n, hi: 100_000_000n }) {
  const { fx, snaps, programAccount, programDataKey } = loadBenchFixture(fixture);
  const rise = new RiseNative({ fastRange: { ...range, points: 3 } });
  const dlmm = new MeteoraDlmm();
  const user = new PublicKey(fx.user);
  const { wsolAta, riseAta } = atasFor(user);
  const balances = new TokenBalances(wsolAta, riseAta);
  // first update carries the full programdata so the oracle loads the binary
  const first = new Map(snaps[0].infos);
  first.set(programDataKey, programAccount);
  rise.update(snaps[0].slot, first);
  dlmm.update(snaps[0].slot, snaps[0].infos);
  balances.update(snaps[0].slot, snaps[0].infos);
  rise.quoteBuy(10_000_000n); // spawn + warm the worker
  return { fx, snaps, rise, dlmm, balances, user };
}

/** Synthetic competitor trade on the cached pool (alternating sides, 2-10 SOL notional). */
export function perturb(dlmm: MeteoraDlmm, i: number): void {
  const sol = BigInt(2 + ((i * 7) % 9)) * 1_000_000_000n;
  if (i % 2 === 0) dlmm.applySwap("buyRise", "exactIn", sol);
  else {
    const px = dlmm.lbPair ? Math.pow(1 + dlmm.lbPair.binStep / 10_000, dlmm.lbPair.activeId) : 6e-4; // lamports per RISE unit
    dlmm.applySwap("sellRise", "exactIn", BigInt(Math.round(Number(sol) / px)));
  }
}

/** The pre-change optimizer: exact RISE quotes everywhere (grid 96, top-5 golden, pattern search, ±32 window). */
export function baselineOptimize(v: Venues, p: OptimizerParams): Record<Direction, Plan | null> {
  const exactOnly: Venues = { rise: { ...v.rise, quoteBuy: (x: bigint) => v.rise.quoteBuy(x), quoteSell: (x: bigint) => v.rise.quoteSell(x), quoteBuyFast: undefined, quoteSellFast: undefined } as never, dlmm: v.dlmm };
  const out = {} as Record<Direction, Plan | null>;
  for (const dir of ["mintThenSell", "buyThenRedeem"] as Direction[]) {
    const dom = domainFor(dir, exactOnly, p);
    if (!dom) { out[dir] = null; continue; }
    const r = maximize((x) => evaluate(dir, exactOnly, x, p)?.grossProfit ?? null, dom.lo, dom.hi);
    out[dir] = r ? evaluate(dir, exactOnly, r.x, p) : null;
  }
  return out;
}

function offline(iters: number, baseline: boolean) {
  const { snaps, rise, dlmm, balances, user } = benchVenues();
  const signer = Keypair.generate();
  const venues: Venues = { rise, dlmm };
  const p = benchParams();
  const BH = "11111111111111111111111111111111";
  console.log(`offline replay: ${snaps.length} recorded snapshots (slots ${snaps[0].slot}..${snaps.at(-1)!.slot}), max input 0.1 SOL, floor 100000 net`);

  for (const mode of ["sequence", "cold", "perturbed"] as const) {
    const t = { ingest: [] as number[], warm: [] as number[], optimize: [] as number[], decision: [] as number[], build: [] as number[], buildSigned: [] as number[], total: [] as number[] };
    let exact = 0, approx = 0, skipped = 0, opps = 0, built = 0;
    const exact0 = rise.exactCalls;
    for (let i = 0; i < iters; i++) {
      const s = snaps[i % snaps.length];
      if (mode === "cold") { (rise as unknown as { fingerprint: Buffer | null }).fingerprint = null; (dlmm as unknown as { lbRaw: Buffer | null }).lbRaw = null; }
      const t0 = performance.now();
      rise.update(s.slot, s.infos);
      dlmm.update(s.slot, s.infos);
      balances.update(s.slot, s.infos);
      if (mode === "perturbed") perturb(dlmm, i);
      const t1 = performance.now();
      rise.prepareFast();
      const t2 = performance.now();
      const cap = balances.wsol !== null && balances.wsol < p.maxLamportsIn ? balances.wsol : p.maxLamportsIn;
      const r = optimize(venues, { ...p, maxLamportsIn: cap }, s.slot);
      const t3 = performance.now();
      for (const d of Object.values(r.details)) { exact += d.exactEvals; approx += d.approxEvals; if (d.skipped) skipped++; }
      if (r.best) opps++;
      // tx build: the chosen plan, else (for timing) the best exactly-verified plan of either direction
      const plan = r.best ?? r.details.mintThenSell.bestExact ?? r.details.buyThenRedeem.bestExact ?? evaluate("mintThenSell", venues, cap, p, s.slot);
      let t4 = t3, t5 = t3;
      if (plan) {
        const floor = plan.lamportsOut - plan.lamportsIn - plan.minOutPad - plan.fees.totalLamports;
        const pf = floor < p.profitFloor ? floor : p.profitFloor;
        finalMinOut(plan, pf, plan.fees.totalLamports);
        const bp = { priorityFeeLamports: plan.fees.priorityLamports, baseFeeLamports: plan.fees.baseLamports, user, profitFloorLamports: pf, cuLimit: 420_000, recentBlockhash: BH, execFees: plan.fees };
        const a = performance.now();
        buildArbTx(plan, venues, bp);
        t4 = performance.now();
        buildArbTx(plan, venues, { ...bp, user: signer.publicKey, signer });
        t5 = performance.now();
        t.build.push(t4 - a);
        t.buildSigned.push(t5 - t4);
        built++;
      }
      t.ingest.push(t1 - t0); t.warm.push(t2 - t1); t.optimize.push(t3 - t2); t.decision.push(t3 - t0);
      t.total.push(t3 - t0 + (plan ? t.build.at(-1)! : 0));
    }
    if (mode === "perturbed") console.log(`\n(perturbed: every iteration a synthetic competitor swap of 2-10 SOL, alternating sides, is applied to the recorded pool state with applySwap -> both venues changed and arbs appear)`);
    console.log(`\n[${mode}] ${iters} iterations: opportunities ${opps}, skipped directions ${skipped}/${2 * iters}, exact RISE quotes/iter ${(exact / iters).toFixed(2)} in stage 2 + ${((rise.exactCalls - exact0 - exact) / iters).toFixed(2)} grid, approx evals/iter ${(approx / iters).toFixed(0)}, builds ${built}`);
    row("ingest (update all sources)", t.ingest);
    row("warm (RISE fast grid)", t.warm);
    row("optimize (two-stage, both dirs)", t.optimize);
    row("decision = ingest+warm+optimize", t.decision);
    row("tx build (unsigned)", t.build);
    row("tx build (signed)", t.buildSigned);
    row("update -> tx built (unsigned)", t.total);
  }

  if (baseline) {
    const n = Math.min(snaps.length, 20);
    const tb: number[] = [];
    const diffs: bigint[] = [];
    const e0 = rise.exactCalls;
    for (let i = 0; i < n; i++) {
      const s = snaps[i];
      (rise as unknown as { fingerprint: Buffer | null }).fingerprint = null; // cold: no memoized quotes (as before, every update cleared them)
      rise.update(s.slot, s.infos);
      dlmm.update(s.slot, s.infos);
      if (i % 2) perturb(dlmm, i);
      const a = performance.now();
      const b = baselineOptimize(venues, p);
      tb.push(performance.now() - a);
      rise.prepareFast();
      const r = optimize(venues, { ...p, profitFloor: -(1n << 60n) }, s.slot);
      for (const dir of ["mintThenSell", "buyThenRedeem"] as Direction[]) {
        const x = b[dir], y = r.details[dir].bestExact;
        if (x && y) diffs.push(x.grossProfit - y.grossProfit);
      }
    }
    console.log(`\n[baseline: previous exact-only optimizer, current (faster) RISE worker] ${n} snapshots, exact quotes/snapshot ${((rise.exactCalls - e0) / n).toFixed(0)}`);
    row("optimize (exact-only, both dirs)", tb);
    console.log(`  baseline gross − two-stage gross (lamports, >0 = baseline better): max ${diffs.reduce((a, b) => (b > a ? b : a), -(1n << 60n))}, min ${diffs.reduce((a, b) => (b < a ? b : a), 1n << 60n)}`);
  }
  rise.close();
}

// ---------------------------------------------------------------- live

async function live(seconds: number, forceBuild: boolean) {
  const ledger = path.join(ROOT, "data", `bench-ledger-${Date.now()}.jsonl`);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  const env = {
    ...process.env, MODE: "simulate", LEDGER_PATH: ledger, LEDGER_TICK_LATENCY: "1", LATENCY_SUMMARY_MS: "30000",
    POLL_INTERVAL_MS: process.env.POLL_INTERVAL_MS ?? (forceBuild ? "2000" : "1000"),
    ...(forceBuild ? { BENCH_FORCE_BUILD: "1" } : {}),
    // isolate risk state / kill file from a real deployment
    RISK_STATE_PATH: path.join(ROOT, "data", "bench-risk-state.json"), KILL_FILE: path.join(ROOT, "data", "bench-STOP"), PID_FILE: path.join(ROOT, "data", "bench.pid"),
  };
  delete (env as Record<string, string | undefined>).KEYPAIR_PATH;
  console.log(`live simulate-mode run for ${seconds} s (ledger ${path.relative(ROOT, ledger)}${forceBuild ? ", BENCH_FORCE_BUILD" : ""})`);
  const child = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "src/main.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  await sleep(seconds * 1000);
  child.kill("SIGINT");
  await new Promise<void>((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r(); }, 20_000); child.on("exit", () => { clearTimeout(t); r(); }); });
  summarizeLedger(ledger);
  const errs = out.split("\n").filter((l) => /error/i.test(l)).slice(0, 5);
  if (errs.length) console.log(`stderr/stdout errors (first 5):\n  ${errs.join("\n  ")}`);
}

export function summarizeLedger(file: string) {
  const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ticks = rows.filter((r) => r.type === "latency" && r.kind === "tick");
  const by = (k: string, filter: (r: Record<string, unknown>) => boolean = () => true) => ticks.filter(filter).map((r) => r[k]).filter((x): x is number => typeof x === "number");
  const statuses: Record<string, number> = {};
  for (const r of ticks) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  console.log(`ticks ${ticks.length}: ${JSON.stringify(statuses)}; optimizer cache hits ${ticks.filter((r) => r.opt?.cached).length}, exact RISE quotes/tick (stage 2) ${(ticks.reduce((a, r) => a + (r.opt?.exactEvals ?? 0), 0) / (ticks.length || 1)).toFixed(2)}`);
  row("RPC refresh (getSlot + getMultipleAccounts)", by("refreshMs"));
  row("ingest (update all sources)", by("ingestMs"));
  row("data received -> decision", by("dataToDecisionMs"));
  row("data received -> tx built", by("dataToBuiltMs"));
  row("tick start -> decision (old metric)", by("decisionMs"));
  // simulation RTT: final-sim latency minus build mark
  const simRtt = ticks.filter((r) => typeof r.simulatedMs === "number" && typeof r.builtMs === "number").map((r) => (r.simulatedMs as number) - (r.builtMs as number));
  row("tx built -> sim(s) done (RPC RTT)", simRtt);
  const sims = rows.filter((r) => r.type === "simulation");
  const reasons: Record<string, number> = {};
  for (const s of sims) { const k = s.ok ? "ok" : String(s.reason ?? "").replace(/-?\d+/g, "N").slice(0, 60); reasons[`${s.stage}:${k}`] = (reasons[`${s.stage}:${k}`] ?? 0) + 1; }
  if (sims.length) console.log(`simulations: ${JSON.stringify(reasons)}`);
  for (const r of rows.filter((x) => x.type === "latency" && x.kind === "summary")) console.log(`latency summary row: ${JSON.stringify(r)}`);
}

// ---------------------------------------------------------------- cli

const arg = (name: string, def?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2] ?? "offline";
  (async () => {
    if (cmd === "record") await record(Number(arg("n", "50")), Number(arg("interval-ms", "2500")), arg("out", BENCH_FIXTURE)!);
    else if (cmd === "offline") offline(Number(arg("iters", "300")), process.argv.includes("--baseline"));
    else if (cmd === "live") await live(Number(arg("seconds", "75")), process.argv.includes("--force-build"));
    else if (cmd === "summarize") summarizeLedger(arg("ledger")!);
    else throw new Error(`unknown command ${cmd}`);
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
