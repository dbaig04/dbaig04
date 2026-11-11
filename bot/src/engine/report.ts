// Realized-PnL report.
//   npx tsx src/engine/report.ts [--ledger data/ledger.jsonl]
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
import { accountKeysOf, analyzeTx, Ledger, outcomeFromEvent, summarize, type OutcomeLike, type PnlSummary, type RawTx } from "./ledger.js";

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
  const outs = evs.filter((e) => e.type === "outcome").map(outcomeFromEvent);
  console.log(formatSummary(summarize(outs), `ledger ${path}: realized`));
  const sims = evs.filter((e) => e.type === "simulation");
  const ok = sims.filter((e) => e.ok);
  const paper = ok.reduce((a, e) => a + BigInt((e.simulatedProfit as string) ?? "0"), 0n);
  const opps = evs.filter((e) => e.type === "opportunity").length;
  console.log(`\nopportunities: ${opps}, simulations: ${sims.length} (${ok.length} passed), submissions: ${evs.filter((e) => e.type === "submission").length}`);
  console.log(`paper PnL of passing sims (not realized): ${SOL(paper)} SOL`);
  const reasons = new Map<string, number>();
  for (const e of sims.filter((e) => !e.ok)) {
    const r = String(e.reason ?? "?").replace(/\d+/g, "N").slice(0, 80);
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }
  for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  sim reject x${n}: ${r}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
