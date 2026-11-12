// Competitor report: research wallet (8pY1Au…) + every MAX PumpSwap<->DLMM arber seen on the
// DLMM pool. Reads saved getTransaction JSON (v1-aware) + getSignaturesForAddress lists, writes
// markdown (src/research/COMPETITOR.md) and a JSON of the computed numbers.
//
//   npx tsx src/research/report.ts --wallet-tx <dir> --wallet-sigs <json> --pool-tx <dir> --pool-sigs <json> \
//        --tips <jito getTipAccounts json> [--out src/research/COMPETITOR.md]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeTx, quantile, type RawTxV1, type TxAnalysis } from "./analyze.js";
import { maxArbAnyRoute } from "./competitors.js";
import { MAX_DLMM_POOLS } from "../engine/pair-venues.js";
import type { SigInfo } from "./rpc.js";

export const RESEARCH_WALLET = "8pY1AukbuPgUE3EetyLa59rFLMimJGT94ZzbMEZcQF4w";
export const RESEARCH_PROGRAM = "DDsnwb7dxKSjzTYDFjU8F6rpYNZa1sp7Fmfb2nGDAMEo";
export const PUMP_POOL = "Eoe22HdCa9rhtBwKL6nNZmZxfuzF35xkxobcvfaF1vWQ";
export const DLMM_POOL = "H6Bcgdsxbpv5KjjyydddZPECg1BXe53uHnQSSkfiyKQ";
export const MAX = "5qaP7oKUqKffwwo5DaEqDoTtsBLMpdbQTxEkCDaTpump";

type Sig = SigInfo & { transactionIndex?: number };

export function loadDir(dir: string, tips: Set<string>, program?: string): TxAnalysis[] {
  const out: TxAnalysis[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as RawTxV1 | null;
    if (t?.meta) out.push(analyzeTx(t, { jitoTipAccounts: tips, dataProgram: program }));
  }
  return out.sort((a, b) => a.slot - b.slot);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const q = (xs: number[]) => ({ n: xs.length, min: xs.length ? Math.min(...xs) : undefined, p25: quantile(xs, 0.25), median: quantile(xs, 0.5), p75: quantile(xs, 0.75), p95: quantile(xs, 0.95), max: xs.length ? Math.max(...xs) : undefined, sum: sum(xs) });
const groupBy = <T, K>(xs: T[], k: (x: T) => K) => { const m = new Map<K, T[]>(); for (const x of xs) { const g = m.get(k(x)) ?? []; g.push(x); m.set(k(x), g); } return m; };

/** Zero-lamport accounts passed to the program whose address is a vanity "xx1111…1y" marker. */
export function markerTag(a: TxAnalysis): string | null {
  const m = a.markerAccounts.find((k) => /^[a-z]{2}1{38,}[a-z]$/.test(k));
  return m ? `${m.slice(0, 2)}…${m.slice(-1)}` : null;
}

export function walletStats(txs: TxAnalysis[], sigs: Sig[]) {
  const w = txs.filter((t) => t.feePayer === RESEARCH_WALLET);
  const bySig = new Map(sigs.map((s) => [s.signature, s]));
  const swapped = w.filter((t) => t.swapped && t.success);
  const maxSwaps = swapped.filter((t) => t.legs.some((l) => l.deltas[MAX] !== undefined));
  const maxPairArbs = swapped.filter((t) => t.legs.some((l) => l.pool === PUMP_POOL) && t.legs.some((l) => l.pool === DLMM_POOL));
  const noSwapOk = w.filter((t) => t.success && !t.swapped);
  const failed = w.filter((t) => !t.success);
  // one-shot SOL deltas: profit includes fee + tips (walletSolNet = wSOL Δ + native Δ)
  const swappedNonSol = swapped.filter((t) => Object.keys(t.walletTokens).some((m) => m !== "So11111111111111111111111111111111111111112"));
  const nonce = w.filter((t) => t.nonce);
  const nonceAccts = groupBy(nonce, (t) => t.nonce!.account);
  const authorities = new Set(nonce.map((t) => t.nonce!.authority));
  const nonceValues = groupBy(nonce, (t) => t.nonce!.value);
  const sharedValue = [...nonceValues.values()].filter((g) => new Set(g.map((t) => t.nonce!.account)).size > 1).length;
  const valueReuseSameAcct = [...nonceValues.values()].filter((g) => g.length !== new Set(g.map((t) => t.nonce!.account)).size).length;
  // same-slot clusters (landed txs of the wallet sharing a slot), with block order from transactionIndex
  const slots = groupBy(w, (t) => t.slot);
  const clusterSizes = [...slots.values()].map((g) => g.length);
  const multi = [...slots.values()].filter((g) => g.length > 1);
  let swapFirst = 0, swapNotFirst = 0, multiWithSwap = 0, multiNoSwap = 0, highestPrioSwap = 0, idx = 0;
  const identicalRoute: number[] = [];
  let allSameBody = 0, prioDiffer = 0, markerDiffer = 0, nonceAcctDiffer = 0, blockhashSame = 0;
  for (const g of multi) {
    const sw = g.filter((t) => t.swapped && t.success);
    const sameData = new Set(g.map((t) => t.programIxData.map((d) => d.hex.slice(10)).join("|"))).size;
    identicalRoute.push(sameData);
    if (sameData === 1) allSameBody++;
    if (new Set(g.map((t) => t.priorityFee)).size > 1) prioDiffer++;
    if (new Set(g.map((t) => markerTag(t) ?? "-")).size > 1) markerDiffer++;
    if (new Set(g.map((t) => t.nonce?.account)).size === g.length) nonceAcctDiffer++;
    if (new Set(g.map((t) => t.recentBlockhash)).size === 1) blockhashSame++;
    if (!sw.length) { multiNoSwap++; continue; }
    multiWithSwap++;
    const withIdx = g.map((t) => ({ t, i: bySig.get(t.signature)?.transactionIndex })).filter((x) => x.i !== undefined) as { t: TxAnalysis; i: number }[];
    if (withIdx.length === g.length) {
      idx++;
      withIdx.sort((a, b) => a.i - b.i);
      if (withIdx[0].t.swapped && withIdx[0].t.success) swapFirst++; else swapNotFirst++;
    }
    const maxPrio = Math.max(...g.map((t) => t.priorityFee));
    if (sw.some((t) => t.priorityFee === maxPrio)) highestPrioSwap++;
  }
  // repeated route bodies (program ix data minus tag + CU field) across the sample
  const bodies = groupBy(w.filter((t) => t.programIxData[0]), (t) => t.programIxData.map((d) => d.hex.slice(10)).join("|"));
  const repeatedBodies = [...bodies.values()].filter((g) => g.length > 1);
  const bodyRepeat = { distinct: bodies.size, repeated: repeatedBodies.length, txsInRepeated: sum(repeatedBodies.map((g) => g.length)), slotSpread: q(repeatedBodies.map((g) => g[g.length - 1].slot - g[0].slot)), repeatedWithSwap: repeatedBodies.filter((g) => g.some((t) => t.swapped && t.success)).length };
  // ix data: tag byte and the u32 after it vs the tx's CU limit
  const tags = groupBy(w.filter((t) => t.programIxData[0]), (t) => t.programIxData[0].hex.slice(0, 2));
  const cuMatch = w.filter((t) => t.programIxData[0] && t.cuLimit !== undefined && Buffer.from(t.programIxData[0].hex, "hex").readUInt32LE(1) === t.cuLimit).length;
  const withData = w.filter((t) => t.programIxData[0]).length;
  // marker accounts
  const markers = groupBy(w, (t) => markerTag(t) ?? "(none)");
  // swap timing within the sample vs sig list (landed success / failure for the whole list)
  const sigOk = sigs.filter((s) => s.err === null).length;
  const span = sigs.length ? { slots: [sigs[sigs.length - 1].slot, sigs[0].slot], minutes: ((sigs[0].blockTime ?? 0) - (sigs[sigs.length - 1].blockTime ?? 0)) / 60 } : null;
  const tipsJ = w.filter((t) => t.jitoTip > 0);
  const otherT = w.filter((t) => t.transfers.some((x) => !x.jitoTip));
  const cost = (xs: TxAnalysis[]) => -sum(xs.map((t) => t.walletSolNet)); // no-swap/failed: walletSolNet = −fee (−tips)
  return {
    sigs: { n: sigs.length, success: sigOk, failed: sigs.length - sigOk, span },
    decoded: w.length,
    layout: Object.fromEntries([...groupBy(w, (t) => t.topPrograms.map((p) => p.slice(0, 6)).join(",")).entries()].map(([k, v]) => [k, v.length])),
    success: w.filter((t) => t.success).length,
    failed: failed.length,
    swapped: swapped.length,
    maxSwaps: maxSwaps.length,
    maxPairArbs: maxPairArbs.length,
    swappedNonSolEnd: swappedNonSol.length,
    noSwapOk: noSwapOk.length,
    profitSwapped: q(swapped.map((t) => t.walletSolNet)),
    profitMaxPair: q(maxPairArbs.map((t) => t.walletSolNet)),
    costNoSwap: { n: noSwapOk.length, total: cost(noSwapOk), perTx: q(noSwapOk.map((t) => t.fee)) },
    costFailed: { n: failed.length, total: cost(failed), perTx: q(failed.map((t) => t.fee)) },
    net: sum(w.map((t) => t.walletSolNet)),
    feeAll: q(w.map((t) => t.fee)),
    priority: q(w.map((t) => t.priorityFee)),
    cuLimit: q(w.map((t) => t.cuLimit ?? 0)),
    cuUsed: q(w.map((t) => t.cuConsumed ?? 0)),
    cuUsedSwap: q(swapped.map((t) => t.cuConsumed ?? 0)),
    cuUsedNoSwap: q(noSwapOk.map((t) => t.cuConsumed ?? 0)),
    versions: Object.fromEntries([...groupBy(w, (t) => t.version).entries()].map(([k, v]) => [k, v.length])),
    jitoTips: { n: tipsJ.length, total: sum(tipsJ.map((t) => t.jitoTip)) },
    otherTransfers: { n: otherT.length, recipients: Object.fromEntries([...groupBy(otherT.flatMap((t) => t.transfers.filter((x) => !x.jitoTip)), (x) => x.to).entries()].map(([k, v]) => [k, v.length])) },
    memos: w.filter((t) => t.memos.length).length,
    nonce: {
      txs: nonce.length, accounts: nonceAccts.size, authorities: [...authorities],
      txsPerAccount: q([...nonceAccts.values()].map((g) => g.length)),
      valuesSharedAcrossAccounts: sharedValue, valueReusedOnSameAccount: valueReuseSameAcct, distinctValues: nonceValues.size,
    },
    clusters: {
      slots: slots.size, sizes: q(clusterSizes), multi: multi.length, txsInMulti: sum(multi.map((g) => g.length)),
      multiWithSwap, multiNoSwap, orderKnown: idx, swapFirst, swapNotFirst, highestPrioSwap,
      distinctRouteBodiesPerCluster: q(identicalRoute), allSameBody, prioDiffer, markerDiffer, nonceAcctDiffer, blockhashSame,
    },
    ixTags: Object.fromEntries([...tags.entries()].map(([k, v]) => [k, { n: v.length, ok: v.filter((t) => t.success).length, swapped: v.filter((t) => t.swapped).length }])),
    cuFieldMatches: { match: cuMatch, of: withData },
    bodyRepeat,
    markers: Object.fromEntries([...markers.entries()].map(([k, v]) => [k, { n: v.length, ok: v.filter((t) => t.success).length, swapped: v.filter((t) => t.swapped && t.success).length, medianPrio: quantile(v.map((t) => t.priorityFee), 0.5) }])),
    routePrograms: Object.fromEntries([...groupBy(swapped.flatMap((t) => t.legs.map((l) => l.program)), (x) => x).entries()].map(([k, v]) => [k, v.length])),
    hops: q(swapped.map((t) => t.legs.length)),
    maxPairSamples: maxPairArbs.slice(0, 12).map((t) => ({ sig: t.signature, slot: t.slot, legs: t.legs.map((l) => `${l.program}:${l.pool.slice(0, 6)} ${l.trade}`), net: t.walletSolNet, fee: t.fee })),
  };
}

export function poolArbStats(txs: TxAnalysis[], sigs: Sig[]) {
  const arbs = txs.map((t) => ({ t, a: maxArbAnyRoute(t, PUMP_POOL, MAX_DLMM_POOLS) })).filter((x) => x.a) as { t: TxAnalysis; a: NonNullable<ReturnType<typeof maxArbAnyRoute>> }[];
  const dlmmSet = new Set<string>(MAX_DLMM_POOLS);
  const dlmmSwaps = txs.filter((t) => t.success && t.legs.some((l) => dlmmSet.has(l.pool)));
  const dlmmRefs = txs.length;
  const bySig = new Map(sigs.map((s) => [s.signature, s]));
  const payers = groupBy(arbs, (x) => x.a.feePayer);
  // back-run evidence on the DLMM side: a non-arb DLMM swap earlier in the same slot (lower transactionIndex)
  const nonArbDlmm = dlmmSwaps.filter((t) => !arbs.some((x) => x.t.signature === t.signature));
  let sameSlotTrigger = 0, idxKnown = 0, prevSlotTrigger = 0;
  for (const x of arbs) {
    const i = bySig.get(x.t.signature)?.transactionIndex;
    const trig = nonArbDlmm.filter((t) => t.slot === x.t.slot && (bySig.get(t.signature)?.transactionIndex ?? 1e9) < (i ?? -1));
    if (i !== undefined) idxKnown++;
    if (trig.length) sameSlotTrigger++;
    else if (nonArbDlmm.some((t) => t.slot < x.t.slot && t.slot >= x.t.slot - 3)) prevSlotTrigger++;
  }
  const span = sigs.length ? { slots: [sigs[sigs.length - 1].slot, sigs[0].slot], minutes: ((sigs[0].blockTime ?? 0) - (sigs[sigs.length - 1].blockTime ?? 0)) / 60 } : null;
  const perPayer = [...payers.entries()].map(([p, xs]) => ({
    payer: p, n: xs.length, ok: xs.filter((x) => x.a.success).length,
    dirs: Object.fromEntries([...groupBy(xs, (x) => x.a.direction).entries()].map(([k, v]) => [k, v.length])),
    net: sum(xs.map((x) => x.a.walletSolNet)), medianNet: quantile(xs.map((x) => x.a.walletSolNet), 0.5),
    medianIn: quantile(xs.map((x) => x.a.solIn ?? 0), 0.5), medianPrio: quantile(xs.map((x) => x.a.priorityFee), 0.5),
    jito: xs.filter((x) => x.a.jitoTip > 0).length, nonce: xs.filter((x) => x.a.nonce).length,
    topProgram: [...new Set(xs.map((x) => x.t.topPrograms.filter((k) => !k.startsWith("ComputeBudget") && k !== "11111111111111111111111111111111").map((k) => k.slice(0, 6)).join("+")))].slice(0, 3).join(" / "),
    otherLegs: xs.filter((x) => x.a.otherLegs > 0).length,
  })).sort((a, b) => b.n - a.n);
  return {
    sample: { sigs: sigs.length, decoded: dlmmRefs, span, dlmmSwaps: dlmmSwaps.length },
    arbs: arbs.length, success: arbs.filter((x) => x.a.success).length,
    netAll: q(arbs.map((x) => x.a.walletSolNet)), solIn: q(arbs.map((x) => x.a.solIn ?? 0)),
    priority: q(arbs.map((x) => x.a.priorityFee)), jitoTipped: arbs.filter((x) => x.a.jitoTip > 0).length, jitoTip: q(arbs.filter((x) => x.a.jitoTip > 0).map((x) => x.a.jitoTip)),
    nonce: arbs.filter((x) => x.a.nonce).length, multiHop: arbs.filter((x) => x.a.otherLegs > 0).length,
    dirs: Object.fromEntries([...groupBy(arbs, (x) => x.a.direction).entries()].map(([k, v]) => [k, v.length])),
    backrun: { idxKnown, sameSlotDlmmTrigger: sameSlotTrigger, dlmmTriggerWithin3SlotsBefore: prevSlotTrigger },
    perPayer,
    perRoute: Object.fromEntries([...groupBy(arbs, (x) => x.a.route).entries()].map(([k, v]) => [k, { n: v.length, payers: new Set(v.map((x) => x.a.feePayer)).size, net: q(v.map((x) => x.a.walletSolNet)), above100k: v.filter((x) => x.a.walletSolNet >= 100_000).length }])),
    arbsPerHour: span && span.minutes > 0 ? (arbs.length / span.minutes) * 60 : undefined,
    above100k: arbs.filter((x) => x.a.walletSolNet >= 100_000).length,
  };
}

function arg(n: string): string | undefined { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; }

async function main() {
  const tips = new Set<string>(JSON.parse(readFileSync(arg("tips")!, "utf8")).result);
  const wtx = loadDir(arg("wallet-tx")!, tips, RESEARCH_PROGRAM);
  const wsigs = JSON.parse(readFileSync(arg("wallet-sigs")!, "utf8")) as Sig[];
  const ptx = loadDir(arg("pool-tx")!, tips, RESEARCH_PROGRAM);
  const psigs = JSON.parse(readFileSync(arg("pool-sigs")!, "utf8")) as Sig[];
  const ws = walletStats(wtx, wsigs);
  const ps = poolArbStats(ptx, psigs);
  const out = arg("json") ?? "/dev/stdout";
  writeFileSync(out, JSON.stringify({ wallet: ws, pool: ps, tips: [...tips] }, null, 1));
}

if (process.argv[1]?.endsWith("report.ts")) main().catch((e) => { console.error(e); process.exit(1); });
