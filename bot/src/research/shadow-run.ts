// Sustained SHADOW run of the MAX pair engine (simulate mode only; never signs or sends),
// with concurrent collection of competitor MAX arbs landed on the two pools, and a
// comparison written to src/research/SHADOW.md (interim every SHADOW_REPORT_MS, final at the end).
//
//   NODE_USE_ENV_PROXY=1 SHADOW_MINUTES=35 POLL_INTERVAL_MS=1500 npx tsx src/research/shadow-run.ts
//
// Env: SHADOW_DIR (output dir, default data/shadow), SHADOW_FORCE_SIM_MS (sub-floor latency probe
// sims, default 20000; 0 = off), SHADOW_COMP_POLL_MS (competitor signature poll, default 20000),
// RESEARCH_RPS (competitor fetcher budget, default 0.6), PAIR_SIM_USER, PAIR_LOOKUP_TABLES.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey, type AddressLookupTableAccount } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { makeReadConnection } from "../feeds/index.js";
import { Ledger } from "../engine/ledger.js";
import { PairEngine, type PairTickInfo } from "../engine/pair-engine.js";
import { ShadowRecorder } from "../engine/shadow.js";
import { MAX_PUMPSWAP_POOL, MAX_SIM_USER, maxPairSpec, selectedDlmmPools } from "../engine/pair-venues.js";
import { CompetitorWatcher } from "./competitors.js";
import { RateLimitedRpc } from "./rpc.js";
import { compare, renderShadowMd, summarizeTicks, untakenOpportunities } from "./shadow-report.js";
import type { CompetitorArb } from "./competitors.js";

export function untakenLines(ticks: PairTickInfo[], arbs: CompetitorArb[]): string[] {
  const un = untakenOpportunities(ticks, arbs);
  return ["## Opportunities we found that no competitor took", "", `${un.opportunityTicks} floor-clearing opportunity ticks; ${un.untaken.length} had no competitor arb on the same route + direction within 25 slots after.`,
    ...un.untaken.slice(0, 30).map((u) => `- ${u.route} slot ${u.slot} ${u.direction}: in ${u.grossIn}, expected net ${u.expected}, our sim ${u.simOk === null ? "–" : u.simOk ? "ok" : `fail (${u.simReason})`}`), ""];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadConfig();
  if (cfg.mode !== "simulate") throw new Error("shadow run is simulate-only (MODE must be simulate)");
  const dir = process.env.SHADOW_DIR ?? "data/shadow";
  mkdirSync(dir, { recursive: true });
  const minutes = Number(process.env.SHADOW_MINUTES ?? 30);
  const reportMs = Number(process.env.SHADOW_REPORT_MS ?? 120_000);
  const mdPath = process.env.SHADOW_MD ?? "src/research/SHADOW.md";
  const conn = makeReadConnection(cfg);
  const ledger = new Ledger(join(dir, "ledger.jsonl"));
  const dlmmPools = selectedDlmmPools();
  const spec = maxPairSpec();
  const lookupTables: AddressLookupTableAccount[] = [];
  for (const k of (process.env.PAIR_LOOKUP_TABLES ?? "").split(",").filter(Boolean)) {
    const r = await conn.getAddressLookupTable(new PublicKey(k));
    if (r.value) lookupTables.push(r.value);
  }
  const user = cfg.keypair ? cfg.keypair.publicKey : new PublicKey(process.env.PAIR_SIM_USER ?? MAX_SIM_USER);
  const rec = new ShadowRecorder(join(dir, "ticks.jsonl"));
  const ticks: PairTickInfo[] = [];
  const engine = new PairEngine({
    conn, cfg, ledger, user, pair: { ...spec, lookupTables },
    forceSimEveryMs: Number(process.env.SHADOW_FORCE_SIM_MS ?? 20_000),
    onTick: (i) => { rec.record(i); ticks.push(i); },
  });
  const tipsPath = process.env.JITO_TIPS_JSON;
  const tips = tipsPath && existsSync(tipsPath) ? new Set<string>(JSON.parse(readFileSync(tipsPath, "utf8")).result) : undefined;
  const rpc = new RateLimitedRpc({ rps: Number(process.env.RESEARCH_RPS ?? 0.6), url: cfg.rpcUrl });
  const watcher = new CompetitorWatcher(rpc, { watch: dlmmPools, pumpPool: MAX_PUMPSWAP_POOL, dlmmPools, txDir: join(dir, "tx"), outPath: join(dir, "competitors.jsonl"), tips, log: console.log, intervalMs: Number(process.env.SHADOW_COMP_POLL_MS ?? 20_000) });
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  console.log(`shadow: MAX pair, routes ${spec.routes!.map((r) => r.name).join(", ")}, user ${user.toBase58()} (${cfg.keypair ? "keypair" : "read-only sim user"}), poll ${cfg.pollIntervalMs} ms, ${minutes} min -> ${dir}`);
  const notes = [
    "Measured here: everything in the tables. Not measured: landing (nothing is ever sent), gRPC/shred detection (not available in this sandbox).",
    "Detection in this sandbox = public-RPC polling: getSlot + one getMultipleAccountsInfo per tick, every POLL_INTERVAL_MS. A competitor that back-runs a pool move in the same slot is invisible to a poller whose snapshots are several slots apart; the 'slots between consecutive snapshots' row bounds how often we can even observe pre-trade state.",
  ];
  const write = (interim: boolean) => {
    const md = renderShadowMd({ title: "MAX shadow run (PumpSwap ⇄ Meteora DLMM)", startedAt, minutes: (Date.now() - t0) / 60_000, interim, summary: summarizeTicks(ticks), comparisons: compare(ticks, watcher.arbs), competitorTxsScanned: watcher.seen, notes: [...untakenLines(ticks, watcher.arbs), ...notes] });
    writeFileSync(mdPath, md);
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ recorder: rec.summary(), comparisons: compare(ticks, watcher.arbs) }, null, 1));
  };
  watcher.start();
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  let lastReport = Date.now();
  let backoff = 0;
  while (!stopping && Date.now() - t0 < minutes * 60_000) {
    const ts = Date.now();
    try {
      const r = await engine.tick("timeout");
      if (r.status !== "stale" && r.status !== "no-opportunity") console.log(`[${r.slot}] ${r.status}${r.plan ? ` ${r.plan.pair} ${r.plan.direction} in ${r.plan.grossIn} exp ${r.plan.expectedProfit}` : ""}${r.sim ? ` sim ${r.sim.ok ? "ok" : r.sim.reason}` : ""}`);
      backoff = 0;
    } catch (e) {
      console.error(`tick error: ${(e as Error).message}`);
      backoff = Math.min(15_000, backoff ? backoff * 2 : 1_000);
    }
    if (Date.now() - lastReport >= reportMs) { write(true); lastReport = Date.now(); }
    await sleep(Math.max(0, cfg.pollIntervalMs - (Date.now() - ts)) + backoff);
  }
  watcher.stop();
  // final pass: competitor txs that landed in the last seconds
  await watcher.poll();
  engine.close();
  write(false);
  console.log(`shadow done: ${ticks.length} ticks, ${watcher.arbs.length} competitor arbs; report ${mdPath}`);
  process.exit(0);
}

if (process.argv[1]?.endsWith("shadow-run.ts")) main().catch((e) => { console.error(e); process.exit(1); });
