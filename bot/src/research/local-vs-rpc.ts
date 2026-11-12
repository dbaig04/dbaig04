// Summarize LOCAL_SIM=shadow comparisons (`local_simulation` ledger rows, src/engine/local-sim.ts):
// agreement between the local full-tx LiteSVM simulation and the RPC simulation of the SAME tx, and
// how much earlier the local verdict is available.
//
//   npx tsx src/research/local-vs-rpc.ts data/shadow/ledger.jsonl [--blocks 10]
//
// --blocks N: for up to N mismatches whose state check did not show a changed account, read the
// blocks from the snapshot slot to the RPC sim slot (getBlock, RPC_URL) and list the txs that wrote
// the route's pools (in-slot order), as src/research/sim-diag.ts does. Read-only; sends nothing.
import { readFileSync } from "node:fs";

export type Row = Record<string, unknown> & { type: string; ts: string };
type Side = { ok?: boolean; execOk?: boolean; err?: string; reason?: string; refused?: string; ran?: boolean; slot?: number; waitMs?: number; ms?: number; cu?: number; wsolDelta?: string; tokenDelta?: string; workerSimMs?: number };
export type LocalRow = Row & {
  route: string; direction: string; stage: string; forced: boolean; snapshotSlot: number;
  local: Side; rpc: Side;
  agreement: { class: string; agree: boolean | null; sameSlot: boolean | null; rpcSlotLag?: number; cuEqual?: boolean; verdictEqual?: boolean; details?: string };
  timing: { localMs?: number; rpcMs?: number; dataToLocalMs?: number; dataToRpcMs?: number; localStartLeadMs?: number };
  stateCheck?: { verdict?: string; differ?: string[]; slot?: number; skipped?: boolean; error?: string };
};

const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const pc = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const stats = (xs: number[]) => `median ${f1(pct(xs, 0.5))} / p95 ${f1(pct(xs, 0.95))} / max ${f1(xs.length ? Math.max(...xs) : NaN)} ms (n=${xs.length})`;
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

export function localRows(rows: Row[]): LocalRow[] {
  return rows.filter((r) => r.type === "local_simulation") as LocalRow[];
}

function countBy<T>(xs: T[], k: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(k(x), (m.get(k(x)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** Text summary (one line per item). */
export function summarize(all: LocalRow[]): string[] {
  const out: string[] = [];
  const comparable = all.filter((r) => r.agreement.class !== "local-refused" && r.agreement.class !== "rpc-not-run");
  const agree = comparable.filter((r) => r.agreement.agree);
  const same = comparable.filter((r) => r.agreement.sameSlot === true);
  const later = comparable.filter((r) => r.agreement.sameSlot === false);
  const refused = all.filter((r) => r.agreement.class === "local-refused");
  const notRun = all.filter((r) => r.agreement.class === "rpc-not-run");
  out.push(`comparisons: ${all.length} (${all.filter((r) => r.forced).length} forced latency probes, ${all.filter((r) => !r.forced).length} floor-clearing candidates; ${all.filter((r) => r.stage === "pre").length} pre-sims, ${all.filter((r) => r.stage === "final").length} final sims)`);
  out.push(`  not comparable: ${refused.length} local sim refused, ${notRun.length} RPC simulation never ran (rpc behind / rpc error)`);
  out.push(`agreement (comparable ${comparable.length}): ${agree.length} = ${pc(agree.length, comparable.length)}  [agree = both executed OK with Δ wSOL and Δ token equal to the unit, or both failed with the same error]`);
  out.push(`  RPC context slot == snapshot slot: ${same.filter((r) => r.agreement.agree).length}/${same.length} = ${pc(same.filter((r) => r.agreement.agree).length, same.length)}   (both views of the same slot; in-slot ordering can still differ)`);
  out.push(`  RPC context slot  > snapshot slot: ${later.filter((r) => r.agreement.agree).length}/${later.length} = ${pc(later.filter((r) => r.agreement.agree).length, later.length)}   (RPC may see newer pool state: a disagreement here is expected when the pools moved)`);
  const lags = later.map((r) => r.agreement.rpcSlotLag ?? 0);
  if (lags.length) out.push(`  RPC slot lag behind snapshot when later: median ${pct(lags, 0.5)} / p95 ${pct(lags, 0.95)} / max ${Math.max(...lags)} slots`);
  out.push(`  by class: ${countBy(all, (r) => r.agreement.class).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const okBoth = comparable.filter((r) => r.agreement.class === "agree-ok");
  const cuEq = okBoth.filter((r) => r.agreement.cuEqual);
  out.push(`  compute units: equal in ${cuEq.length}/${okBoth.length} agree-ok comparisons${okBoth.length > cuEq.length ? ` (max |diff| ${Math.max(0, ...okBoth.map((r) => Math.abs((r.local.cu ?? 0) - (r.rpc.cu ?? 0))))} CU)` : ""}; final verdict (incl. floor / tolerance checks) equal in ${comparable.filter((r) => r.agreement.verdictEqual).length}/${comparable.length}`);
  const mism = comparable.filter((r) => r.agreement.agree === false);
  if (mism.length) {
    out.push(`mismatches: ${mism.length}`);
    for (const [k, v] of countBy(mism, (r) => `${r.agreement.class} | ${r.agreement.sameSlot ? "same slot" : "later slot"} | state check: ${r.stateCheck?.verdict ?? (r.stateCheck?.skipped ? "skipped" : r.stateCheck?.error ? "error" : "none")}`)) out.push(`  ${v} x ${k}`);
    out.push(`  state check = the tx's writable accounts re-read at >= the RPC sim slot vs our snapshot: "state-changed" (some account differs -> explained by a state change, not a local-sim error), "same-state" (identical at the sim slot -> REAL disagreement, investigate), "same-state-later-read" (identical, read at a later slot).`);
    const unexplained = mism.filter((r) => r.stateCheck?.verdict === "same-state");
    for (const r of unexplained.slice(0, 10)) out.push(`  UNEXPLAINED ${r.ts} ${r.route} ${r.direction} ${r.stage} snapshot ${r.snapshotSlot} rpc ${r.rpc.slot}: ${r.agreement.details}`);
    const changed = countBy(mism.flatMap((r) => r.stateCheck?.differ ?? []), (k) => k).slice(0, 6);
    if (changed.length) out.push(`  accounts that changed (top): ${changed.map(([k, v]) => `${k.slice(0, 8)}… x${v}`).join(", ")}`);
  }
  if (refused.length) out.push(`local refusals: ${countBy(refused, (r) => String(r.local.refused ?? "").replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, "<key>").slice(0, 120)).slice(0, 6).map(([k, v]) => `${v} x ${k}`).join("; ")}`);
  if (notRun.length) out.push(`RPC not run: ${countBy(notRun, (r) => String(r.rpc.reason ?? "").replace(/\d+/g, "N").slice(0, 80)).slice(0, 4).map(([k, v]) => `${v} x ${k}`).join("; ")}`);
  // ---- latency ----
  const ran = all.filter((r) => !r.local.refused);
  out.push("");
  out.push("latency (ms; measured in the bot process with performance.now()):");
  out.push(`  local sim, start -> verdict (snapshot assembly + IPC + LiteSVM): ${stats(ran.map((r) => num(r.timing.localMs)).filter((x): x is number => x !== undefined))}`);
  out.push(`    of which LiteSVM execution in the worker: ${stats(ran.map((r) => num(r.local.workerSimMs)).filter((x): x is number => x !== undefined))}`);
  const rpcRan = all.filter((r) => r.rpc.ran);
  out.push(`  RPC sim, start -> response, incl. waiting for the RPC to reach the snapshot slot: ${stats(rpcRan.map((r) => num(r.timing.rpcMs)).filter((x): x is number => x !== undefined))}`);
  out.push(`    of which catch-up wait (minContextSlot retries): ${stats(rpcRan.map((r) => num(r.rpc.waitMs) ?? 0))}`);
  const both = all.filter((r) => !r.local.refused && r.rpc.ran && num(r.timing.dataToLocalMs) !== undefined && num(r.timing.dataToRpcMs) !== undefined);
  const dl = both.map((r) => r.timing.dataToLocalMs!), dr = both.map((r) => r.timing.dataToRpcMs!);
  const gain = both.map((r) => r.timing.dataToRpcMs! - r.timing.dataToLocalMs!);
  out.push(`  data arrival -> local verdict: ${stats(dl)}`);
  out.push(`  data arrival -> RPC verdict:   ${stats(dr)}`);
  out.push(`  verdict earlier by (RPC − local, per comparison): ${stats(gain)}; local first in ${both.filter((r) => r.timing.dataToLocalMs! < r.timing.dataToRpcMs!).length}/${both.length}`);
  out.push(`  RPC request delayed by starting the local sim first (its synchronous part): ${stats(all.map((r) => num(r.timing.localStartLeadMs)).filter((x): x is number => x !== undefined))}`);
  out.push(`  ("data arrival" = when the snapshot's newest account data was received: gRPC update receipt, or the RPC poll response. Both sims start at the same moment on the same tx; neither number includes building the tx or sending it.)`);
  // ---- per route ----
  out.push("");
  out.push("per route / direction:");
  const routes = new Map<string, LocalRow[]>();
  for (const r of all) { const k = `${r.route} ${r.direction}`; routes.set(k, [...(routes.get(k) ?? []), r]); }
  for (const [k, rs] of [...routes.entries()].sort()) {
    const c = rs.filter((r) => r.agreement.class !== "local-refused" && r.agreement.class !== "rpc-not-run");
    const s = c.filter((r) => r.agreement.sameSlot === true);
    const b = rs.filter((r) => !r.local.refused && r.rpc.ran && r.timing.dataToLocalMs !== undefined && r.timing.dataToRpcMs !== undefined);
    out.push(`  ${k}: n ${rs.length}, agree ${pc(c.filter((r) => r.agreement.agree).length, c.length)} (same slot ${s.filter((r) => r.agreement.agree).length}/${s.length}), local verdict ${f1(pct(b.map((r) => r.timing.dataToLocalMs!), 0.5))} ms vs RPC ${f1(pct(b.map((r) => r.timing.dataToRpcMs!), 0.5))} ms after data arrival (medians)`);
  }
  return out;
}

async function main() {
  const path = process.argv[2] ?? "data/shadow/ledger.jsonl";
  const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
  const lr = localRows(rows);
  console.log(`local-vs-rpc: ${path}: ${lr.length} local_simulation rows`);
  if (!lr.length) { console.log("no comparisons (was the run started with LOCAL_SIM=shadow?)"); return; }
  for (const l of summarize(lr)) console.log(l);
  const bi = process.argv.indexOf("--blocks");
  const nBlocks = bi > 0 ? Number(process.argv[bi + 1] ?? 10) : 0;
  if (nBlocks > 0) {
    const { loadConfig } = await import("../config.js");
    const { RateLimitedRpc } = await import("./rpc.js");
    const { rpcInfo } = await import("./feed-health.js");
    const { poolTxsInBlock, poolsFor } = await import("./sim-diag.js");
    const cfg = loadConfig();
    const info = rpcInfo(cfg);
    const rpc = new RateLimitedRpc({ rps: Number(process.env.RESEARCH_RPS ?? (info.isPublic ? 0.6 : 5)), url: cfg.rpcUrl });
    const todo = lr.filter((r) => r.agreement.agree === false && r.stateCheck?.verdict !== "state-changed").slice(0, nBlocks);
    console.log(`\nblock check of ${todo.length} mismatch(es) without a detected state change:`);
    for (const r of todo) {
      const pools = poolsFor(r.route);
      console.log(`${r.ts} ${r.route} ${r.direction} ${r.stage}: snapshot ${r.snapshotSlot}, rpc ${r.rpc.slot}: ${r.agreement.details}`);
      for (let s = r.snapshotSlot; s <= (r.rpc.slot ?? r.snapshotSlot) && s <= r.snapshotSlot + 10; s++) {
        const txs = await poolTxsInBlock(rpc, s, pools);
        console.log(`  slot ${s}: ${typeof txs === "string" ? txs : txs.length ? txs.map((t) => `#${t.index} ${t.payer.slice(0, 6)}${t.err ? "(failed)" : ""} [${t.pools.map((p) => p.slice(0, 6)).join("+")}]`).join(", ") : "no pool txs"}`);
      }
    }
  }
}

if (process.argv[1]?.endsWith("local-vs-rpc.ts")) main().catch((e) => { console.error(String((e as Error).message ?? e).replace(/https?:\/\/\S+/g, "<url>")); process.exit(1); });
