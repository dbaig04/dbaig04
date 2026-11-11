// Realized-PnL report.
//   npx tsx src/engine/report.ts [--ledger data/ledger.jsonl] [--days N]
//     sections (per UTC day and all-time): trading profit, execution costs
//     (base/priority/tip), failed-attempt costs, net, RISE residue (separate),
//     reconciliation drift, latency, halts, risk rejections
//   npx tsx src/engine/report.ts --reference <dir-of-saved-getTransaction-json> [--wallet <pubkey>]
// The reference mode recomputes the reference wallet's realized PnL from its
// saved txs (including failed-tx fees) as a sanity check of the ledger math.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import { RISE_MINT, RISE_PROGRAM_ID, WSOL_MINT } from "../types.js";
import { REFERENCE_WALLET } from "../config.js";
import { accountKeysOf, analyzeTx, breakdown, Ledger, summarize, type LedgerEvent, type OutcomeLike, type PnlSummary, type RawTx } from "./ledger.js";

export const SOL = (l: bigint) => {
  const neg = l < 0n, a = neg ? -l : l;
  return `${neg ? "-" : ""}${a / 1_000_000_000n}.${(a % 1_000_000_000n).toString().padStart(9, "0")}`;
};

export function userAtas(user: string): { wsolAta: string; riseAta: string } {
  const u = new PublicKey(user);
  return {
    wsolAta: getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), u, false, TOKEN_PROGRAM_ID).toBase58(),
    riseAta: getAssociatedTokenAddressSync(new PublicKey(RISE_MINT), u, false, TOKEN_2022_PROGRAM_ID).toBase58(),
  };
}

export function formatSummary(s: PnlSummary, title: string): string {
  const L: string[] = [];
  L.push(`== ${title}`);
  L.push(`txs: ${s.submitted} submitted, ${s.landed} landed (${s.succeeded} ok, ${s.failedLanded} failed), ${s.dropped} dropped`);
  L.push(`gross (wSOL Δ of ok txs):   ${SOL(s.grossLamports)} SOL`);
  L.push(`fees (all landed):          ${SOL(s.feesLamports)} SOL`);
  L.push(`  of which failed-tx cost:  ${SOL(s.failedCostLamports)} SOL`);
  L.push(`net realized (SOL only):    ${SOL(s.netLamports)} SOL`);
  if (s.riseDelta !== 0n) {
    L.push(`RISE residual:              ${s.riseDelta} raw units (est. ${SOL(s.riseValueEstLamports)} SOL at trade-time mark)`);
    L.push(`net incl. RISE residual est:${SOL(s.netLamports + s.riseValueEstLamports)} SOL`);
  }
  L.push(`win rate: ${(s.winRate * 100).toFixed(1)}% (${s.wins}/${s.landed} landed with net > 0)`);
  for (const [k, v] of Object.entries(s.byKind)) L.push(`  ${k.padEnd(14)} n=${v.n} failed=${v.failed} fees=${SOL(v.fees)} net=${SOL(v.net)}`);
  return L.join("\n");
}

// --- ledger report: separate sections, daily and all-time ---

const STAGES = ["decision", "built", "simulated", "sent", "landed"] as const;

function pct(xs: number[], p: number): number | undefined {
  if (!xs.length) return undefined;
  const d = [...xs].sort((a, b) => a - b);
  return d[Math.min(d.length - 1, Math.floor(p * d.length))];
}

/** Sections for one set of ledger events (one UTC day, or all-time). */
export function reportSections(evs: LedgerEvent[], title: string): string {
  const outs = evs.filter((e) => e.type === "outcome");
  const b = breakdown(outs);
  const L: string[] = [];
  L.push(`==== ${title}`);
  L.push(`[activity] ${b.submitted} submitted: ${b.landed} landed (${b.succeeded} ok, ${b.failedLanded} failed), ${b.dropped} dropped/expired`);
  L.push(`[trading]  realized trading profit (before execution costs): ${SOL(b.tradingProfitLamports)} SOL`);
  L.push(`[costs]    execution costs: ${SOL(b.execCostLamports)} SOL = base ${SOL(b.baseFeeLamports)} + priority ${SOL(b.priorityFeeLamports)} + tip ${SOL(b.tipLamports)}`);
  L.push(`[failed]   failed-attempt costs (landed failures; dropped/expired cost 0): ${SOL(b.failedCostLamports)} SOL over ${b.failedLanded} txs (${b.dropped} dropped at 0)`);
  L.push(`[net]      realized SOL net (trading − execution costs): ${SOL(b.netLamports)} SOL`);
  L.push(`[residual] RISE residue (not in realized SOL): ${b.residualRise} raw units, est. ${SOL(b.residualRiseValueEstLamports)} SOL at trade-time marks`);
  L.push(`[reconcile] ${b.driftTxs} ok txs reconciled vs final sim; Σ|drift| wSOL ${b.absDrift.wsol}, RISE ${b.absDrift.rise}, native ${b.absDrift.native}`);
  const lat: Record<string, number[]> = Object.fromEntries(STAGES.map((k) => [k, []]));
  const slots: number[] = [];
  for (const o of outs) {
    const l = o.latencyMs as Record<string, number | undefined> | undefined;
    if (!l) continue;
    for (const k of STAGES) if (typeof l[k] === "number") lat[k].push(l[k]!);
    if (typeof l.slotsToLand === "number") slots.push(l.slotsToLand);
  }
  const f = (x?: number) => (x === undefined ? "-" : `${x}`);
  L.push(`[latency]  ms from update received (p50/p90/max), n=${lat.decision.length}: ` + STAGES.map((k) => `${k} ${f(pct(lat[k], 0.5))}/${f(pct(lat[k], 0.9))}/${f(pct(lat[k], 1))}`).join(", ") + (slots.length ? `; slots to land p50 ${pct(slots, 0.5)}` : ""));
  const byDelivery = new Map<string, LedgerEvent[]>();
  for (const o of outs) { const k = String(o.delivery ?? "rpc"); byDelivery.set(k, [...(byDelivery.get(k) ?? []), o]); }
  if (byDelivery.size) {
    L.push(`[delivery] ` + [...byDelivery].map(([k, list]) => {
      const x = breakdown(list);
      const landed = list.map((o) => (o.latencyMs as Record<string, number> | undefined)?.landed).filter((v): v is number => typeof v === "number");
      return `${k}: n=${x.submitted} landed ${x.landed} (${x.submitted ? ((100 * x.landed) / x.submitted).toFixed(0) : 0}%) ok ${x.succeeded} cost ${SOL(x.execCostLamports)} net ${SOL(x.netLamports)} landed-latency p50 ${pct(landed, 0.5) ?? "-"} ms`;
    }).join(" | "));
  }
  const halts = evs.filter((e) => e.type === "halt");
  L.push(`[halts]    ${halts.length}${halts.length ? ": " + halts.map((h) => `${h.ts.slice(11, 19)} ${h.reason} (${String(h.detail ?? "").slice(0, 80)})`).join("; ") : ""}`);
  const risk = evs.filter((e) => e.type === "risk");
  if (risk.length) {
    const m = new Map<string, number>();
    for (const r of risk) for (const x of (r.reasons as string[]) ?? []) { const k = `${r.stage}: ${x.replace(/\d+/g, "N").slice(0, 70)}`; m.set(k, (m.get(k) ?? 0) + 1); }
    L.push(`[risk]     ${risk.length} rejections; top: ${[...m].sort((a, c) => c[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} x${n}`).join(" | ")}`);
  }
  const rec = evs.filter((e) => e.type === "reconcile");
  for (const r of rec) {
    const d = r.drift as { wsol: string; rise: string };
    L.push(`[startup reconcile] ${r.ts}: drift wSOL ${d.wsol} RISE ${d.rise} (${r.outcomesSince} outcomes since ${r.baselineTs})`);
  }
  return L.join("\n");
}

/** Group events by UTC day (YYYY-MM-DD) of their timestamp. */
export function byUtcDay(evs: LedgerEvent[]): Map<string, LedgerEvent[]> {
  const m = new Map<string, LedgerEvent[]>();
  for (const e of evs) {
    const d = String(e.ts).slice(0, 10);
    const a = m.get(d) ?? [];
    a.push(e);
    m.set(d, a);
  }
  return m;
}

export function ledgerReport(evs: LedgerEvent[], opts: { days?: number } = {}): string {
  const parts: string[] = [];
  const days = [...byUtcDay(evs)].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [d, list] of days.slice(-(opts.days ?? days.length))) parts.push(reportSections(list, `UTC day ${d}`));
  parts.push(reportSections(evs, "all-time"));
  return parts.join("\n\n");
}

// --- reference-wallet backfill ---

const BUY_DISC = "66063d1201daebea"; // RISE Buy discriminator, args: u64 lamports_in, u64 min_rise_out

/** Trade-time mark for RISE residual, from the reference's own Buy args (lamports_in / min_rise_out). */
export function referenceRiseMark(t: RawTx): bigint | undefined {
  const keys = accountKeysOf(t);
  for (const ix of t.transaction.message.instructions) {
    if (keys[ix.programIdIndex] !== RISE_PROGRAM_ID) continue;
    const d = Buffer.from(bs58.decode(ix.data));
    if (d.length >= 24 && d.subarray(0, 8).toString("hex") === BUY_DISC) {
      const lam = d.readBigUInt64LE(8), rise = d.readBigUInt64LE(16);
      if (rise > 0n) return (lam * 1_000_000_000n) / rise;
    }
  }
  return undefined;
}

export function analyzeReferenceDir(dir: string, wallet: string): { arb: OutcomeLike[]; other: OutcomeLike[]; skipped: number } {
  const { wsolAta, riseAta } = userAtas(wallet);
  const arb: OutcomeLike[] = [], other: OutcomeLike[] = [];
  let skipped = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const t: RawTx | null = j && "result" in j ? j.result : j;
    if (!t || !t.meta) { skipped++; continue; }
    const r: OutcomeLike = { ...analyzeTx(t, wallet, wsolAta, riseAta), riseMarkLamportsPerRiseE9: referenceRiseMark(t) };
    (r.kind === "other" ? other : arb).push(r);
  }
  return { arb, other, skipped };
}

function argOf(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function main(args: string[]): void {
  const ref = argOf(args, "--reference");
  if (ref) {
    const wallet = argOf(args, "--wallet") ?? REFERENCE_WALLET;
    const { arb, other, skipped } = analyzeReferenceDir(ref, wallet);
    console.log(formatSummary(summarize(arb), `reference wallet ${wallet}: arb txs (${ref})`));
    const first = Math.min(...arb.map((a) => a.slot ?? Infinity)), last = Math.max(...arb.map((a) => a.slot ?? 0));
    if (arb.length) console.log(`slots ${first}..${last}`);
    console.log(`\nnon-arb txs (deposits/withdrawals/wrap/exits, excluded from PnL): ${other.length}, unreadable: ${skipped}`);
    for (const o of other) console.log(`  ${o.signature.slice(0, 12)} slot=${o.slot} fee=${o.fee} wSOLΔ=${o.wsolDelta} RISEΔ=${o.riseDelta} nativeΔ=${o.nativeDelta}${o.success ? "" : " FAILED"}`);
    return;
  }
  const path = argOf(args, "--ledger") ?? process.env.LEDGER_PATH ?? "data/ledger.jsonl";
  const evs = Ledger.read(path);
  const days = argOf(args, "--days");
  console.log(`ledger ${path}`);
  console.log(ledgerReport(evs, { days: days ? Number(days) : undefined }));
  const sims = evs.filter((e) => e.type === "simulation");
  const ok = sims.filter((e) => e.ok);
  const paper = ok.reduce((a, e) => a + BigInt((e.simulatedProfit as string) ?? "0"), 0n);
  const opps = evs.filter((e) => e.type === "opportunity").length;
  console.log(`\n[paper] opportunities: ${opps}, simulations: ${sims.length} (${ok.length} passed), submissions: ${evs.filter((e) => e.type === "submission").length}`);
  console.log(`paper PnL of passing sims (not realized): ${SOL(paper)} SOL`);
  const reasons = new Map<string, number>();
  for (const e of sims.filter((e) => !e.ok)) {
    const r = String(e.reason ?? "?").replace(/\d+/g, "N").slice(0, 80);
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }
  for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  sim reject x${n}: ${r}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
