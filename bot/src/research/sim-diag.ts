// Diagnose opportunities that cleared the floor on our state but failed their simulation.
//
//   npx tsx src/research/sim-diag.ts data/shadow-vps/ledger.jsonl
//
// For each non-forced failed simulation it pairs the preceding `opportunity` row (our snapshot slot,
// plan) with the `simulation` row (the RPC's simulation slot), then reads every block from the
// snapshot slot through the simulation slot (getBlock, v1 txs supported) and lists the txs that
// wrote to the route's pools. That separates:
//   - "pool moved": another tx touched a pool after our snapshot  -> real but too slow / raced;
//   - "no tx in between": the pools did not change, yet the sim disagreed with our quote
//     -> state disagreement (RPC vs gRPC view, fork) or a quoting bug: investigate.
// Uses RPC_URL (host printed only, never the URL). Read-only; sends nothing.
import { readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { MAX_DLMM_POOLS, MAX_PUMPSWAP_POOL_DEFAULT } from "../pumpswap/pools.js";
import { describeRpc, rpcInfo } from "./feed-health.js";
import { RateLimitedRpc } from "./rpc.js";

type Row = Record<string, unknown> & { type: string; ts: string };

const poolsFor = (route: string): string[] => {
  const alias = route.split(":")[1] ?? "";
  const dlmm = MAX_DLMM_POOLS.find((p) => p.address.startsWith(alias))?.address;
  return [MAX_PUMPSWAP_POOL_DEFAULT, ...(dlmm ? [dlmm] : [])];
};

interface BlockTx { signature: string; payer: string; err: boolean; pools: string[]; index: number }

async function poolTxsInBlock(rpc: RateLimitedRpc, slot: number, pools: string[]): Promise<BlockTx[] | "skipped" | "unavailable"> {
  try {
    const b = await rpc.call<{ transactions: { transaction: { signatures: string[]; accountKeys: { pubkey: string; writable: boolean }[] }; meta: { err: unknown } | null }[] } | null>(
      "getBlock", [slot, { encoding: "json", transactionDetails: "accounts", rewards: false, maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
    if (!b) return "skipped";
    const out: BlockTx[] = [];
    b.transactions.forEach((t, index) => {
      const keys = t.transaction.accountKeys;
      const hit = pools.filter((p) => keys.some((k) => k.pubkey === p && k.writable));
      if (hit.length) out.push({ signature: t.transaction.signatures[0], payer: keys[0]?.pubkey ?? "?", err: !!t.meta?.err, pools: hit, index });
    });
    return out;
  } catch (e) {
    const m = String((e as Error).message ?? e);
    return /skipped|not available|-32007|-32009/.test(m) ? "skipped" : "unavailable";
  }
}

export function pairFailures(rows: Row[]) {
  const out: { route: string; direction: string; snapSlot: number; simSlot: number; ms: number; expected: string; reason: string; stage: string; logs: string[] }[] = [];
  let lastOpp: Row | null = null;
  for (const r of rows) {
    if (r.type === "opportunity") { lastOpp = r; continue; }
    if (r.type !== "simulation" || r.forced || r.ok) continue;
    if (!lastOpp) continue;
    const plan = (lastOpp.plan ?? {}) as Record<string, unknown>;
    if (plan.direction !== r.direction) continue;
    const snap = Number(r.snapshotSlot ?? lastOpp.slot);
    const sim = Number(r.simSlot ?? r.slot);
    out.push({
      route: String(plan.pair ?? r.pair), direction: String(r.direction), snapSlot: snap, simSlot: sim,
      ms: Date.parse(r.ts) - Date.parse(lastOpp.ts), expected: String(plan.expectedProfit ?? "?"), reason: String(r.reason ?? ""), stage: String(r.stage ?? ""),
      logs: ((r.logsTail as string[] | undefined) ?? []).filter((l) => !l.startsWith("Program data:")).slice(-3),
    });
    lastOpp = null; // one failure per opportunity
  }
  return out;
}

const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "-");

/**
 * RPC catch-up and outcome summary over all simulation rows:
 *  - catch-up wait (rpcBehindMs; 0 when the RPC was already at the snapshot slot), all sims and per stage;
 *  - floor-clearing candidates (non-forced): passed the pre-sim, passed the final sim, rejected as "rpc behind"
 *    (lost while waiting: the RPC never reached the slot within SIM_SLOT_WAIT_MS), failed after waiting
 *    (the RPC caught up but the opportunity was gone), failed without waiting.
 */
export function simSummary(rows: Row[]): string[] {
  const sims = rows.filter((r) => r.type === "simulation" && r.simSlot !== undefined || (r.type === "simulation" && String(r.reason ?? "").startsWith("rpc behind")));
  const wait = (r: Row) => Number(r.rpcBehindMs ?? 0);
  const all = sims.map(wait);
  const waited = sims.filter((r) => wait(r) > 0).map(wait);
  const behindRejects = sims.filter((r) => String(r.reason ?? "").startsWith("rpc behind"));
  const cand = sims.filter((r) => !r.forced);
  const pre = cand.filter((r) => r.stage === "pre");
  const fin = cand.filter((r) => r.stage === "final");
  const lostWaiting = pre.filter((r) => String(r.reason ?? "").startsWith("rpc behind"));
  const goneAfterWait = pre.filter((r) => !r.ok && wait(r) > 0 && !String(r.reason ?? "").startsWith("rpc behind"));
  const failNoWait = pre.filter((r) => !r.ok && wait(r) === 0 && !String(r.reason ?? "").startsWith("rpc behind"));
  const byRoute = new Map<string, { n: number; preOk: number; finalOk: number }>();
  for (const r of cand) {
    const k = `${String(r.route ?? r.pair ?? "?")} ${String(r.direction ?? "?")}`;
    const e = byRoute.get(k) ?? { n: 0, preOk: 0, finalOk: 0 };
    if (r.stage === "pre") { e.n++; if (r.ok) e.preOk++; }
    if (r.stage === "final" && r.ok) e.finalOk++;
    byRoute.set(k, e);
  }
  return [
    `RPC catch-up (all ${sims.length} simulations with slot data, incl. latency probes): wait median ${fmt(pct(all, 0.5))} / p95 ${fmt(pct(all, 0.95))} / max ${fmt(all.length ? Math.max(...all) : NaN)} ms; ` +
      `${waited.length} had to wait (median ${fmt(pct(waited, 0.5))} / p95 ${fmt(pct(waited, 0.95))} ms); ${behindRejects.length} gave up after SIM_SLOT_WAIT_MS ("rpc behind").`,
    `Floor-clearing candidates (non-forced): ${pre.length} pre-simulations -> ${pre.filter((r) => r.ok).length} passed, ` +
      `${lostWaiting.length} lost while waiting (RPC never reached the slot), ${goneAfterWait.length} failed after waiting (RPC caught up, opportunity gone), ${failNoWait.length} failed with no wait; ` +
      `${fin.length} final simulations -> ${fin.filter((r) => r.ok).length} passed.`,
    ...[...byRoute.entries()].map(([k, e]) => `  ${k}: ${e.n} pre-sims, ${e.preOk} passed pre-sim, ${e.finalOk} passed final sim`),
  ];
}

async function main() {
  const path = process.argv[2] ?? "data/shadow-vps/ledger.jsonl";
  const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
  const cfg = loadConfig();
  const info = rpcInfo(cfg);
  console.log(`sim-diag: ${path}; RPC ${describeRpc(info)}`);
  for (const l of simSummary(rows)) console.log(l);
  console.log("");
  const fails = pairFailures(rows);
  console.log(`${fails.length} floor-clearing opportunities with a failed (non-forced) simulation\n`);
  const rpc = new RateLimitedRpc({ rps: Number(process.env.RESEARCH_RPS ?? (info.isPublic ? 0.6 : 5)), url: cfg.rpcUrl });
  let moved = 0, quiet = 0, unknown = 0, behindN = 0, sameSlot = 0;
  for (const f of fails) {
    const pools = poolsFor(f.route);
    const from = Math.min(f.snapSlot, f.simSlot), to = Math.max(f.snapSlot, f.simSlot);
    const lines: string[] = [];
    let anyAfter = false, gaps = 0;
    for (let s = from; s <= to && s <= from + 30; s++) {
      const txs = await poolTxsInBlock(rpc, s, pools);
      if (txs === "skipped") { lines.push(`    slot ${s}: no block (skipped)`); continue; }
      if (txs === "unavailable") { lines.push(`    slot ${s}: block unavailable`); gaps++; continue; }
      if (s > f.snapSlot && txs.length) anyAfter = true;
      const both = txs.filter((t) => t.pools.length >= 2);
      const okBoth = both.filter((t) => !t.err);
      const payers = new Set(both.map((t) => t.payer));
      const where = s === f.snapSlot ? "snapshot slot" : s === f.simSlot ? "sim slot" : "between";
      lines.push(`    slot ${s} (${where}): ${txs.length} pool txs (${txs.filter((t) => !t.err).length} ok, ${txs.filter((t) => t.err).length} failed); ` +
        `${both.length} touched both pools (arb-like) from ${payers.size} payers, ${okBoth.length} succeeded${okBoth.length ? ": " + okBoth.slice(0, 6).map((t) => `#${t.index} ${t.payer.slice(0, 6)}`).join(", ") : ""}`);
    }
    // classify (sim slot vs snapshot slot first: a sim on OLDER state cannot confirm the quote)
    let verdict: string;
    if (f.simSlot < f.snapSlot) { verdict = `SIM RAN ON OLDER STATE: RPC was ${f.snapSlot - f.simSlot} slot(s) behind our gRPC snapshot`; behindN++; }
    else if (anyAfter) { verdict = "POOL MOVED after our snapshot slot (real but raced / too slow)"; moved++; }
    else if (gaps) { verdict = "UNKNOWN (blocks unavailable)"; unknown++; }
    else if (f.simSlot === f.snapSlot) { verdict = "SAME SLOT: pool txs in this slot may have landed after our processed update (raced within the slot); order not observable"; sameSlot++; }
    else { verdict = "NO pool tx after our snapshot -> state disagreement or quoting issue"; quiet++; }
    console.log(`${f.route} ${f.direction} expected net ${f.expected}: snapshot slot ${f.snapSlot}, sim slot ${f.simSlot} (${f.simSlot - f.snapSlot >= 0 ? "+" : ""}${f.simSlot - f.snapSlot} slots, ${f.ms} ms later), ${f.stage}-sim: ${f.reason}`);
    for (const l of f.logs) console.log(`    log: ${l.slice(0, 160)}`);
    for (const l of lines) console.log(l);
    console.log(`  => ${verdict}\n`);
  }
  console.log(`summary: ${fails.length} failed opportunities; sim on older RPC state: ${behindN}; raced within the snapshot slot (likely): ${sameSlot}; pool moved after snapshot slot: ${moved}; no pool tx in between: ${quiet}; unknown: ${unknown}`);
}

if (process.argv[1]?.endsWith("sim-diag.ts")) main().catch((e) => { console.error(String((e as Error).message ?? e).replace(/https?:\/\/\S+/g, "<url>")); process.exit(1); });
