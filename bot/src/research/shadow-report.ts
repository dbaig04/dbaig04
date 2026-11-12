// Shadow-run analysis: per-stage latency stats and, for every competitor MAX arb that landed
// during the run, whether our engine saw the opportunity before the competitor's slot, how early,
// at what size/profit, and whether our full-tx simulation at that time passed the floor.
import type { PairTickInfo } from "../engine/pair-engine.js";
import { stats, type StageStats } from "../engine/shadow.js";
import type { CompetitorArb } from "./competitors.js";

export const DIR_MAP: Record<string, string> = { buyAsellB: "buyPumpSellDlmm", buyBsellA: "buyDlmmSellPump" };

export interface Comparison {
  signature: string;
  slot: number;
  blockTime: number | null;
  feePayer: string;
  direction: string;
  competitorSolIn?: number;
  competitorNet: number;
  competitorSuccess: boolean;
  /** Our last tick on pre-trade state (snapshot slot < competitor slot). */
  lastPreSlot?: number;
  lastPreBestExpected?: string;
  lastPreBestIn?: string;
  /** Did we have a feasible (floor-clearing) plan in the same direction on pre-trade state (within 25 slots)? */
  seen: boolean;
  firstSeenSlot?: number;
  firstSeenWall?: number;
  /** competitor slot − our first detection slot (>0: we saw it that many slots before it landed). */
  leadSlots?: number;
  /** competitor blockTime − our first detection wall time, ms (blockTime has 1 s resolution). */
  leadMs?: number;
  ourIn?: string;
  ourExpected?: string;
  /** Our simulation on pre-trade state passed (ok and >= floor). */
  executable: boolean;
  simReasons: string[];
  /** First tick on post-trade state: best expected profit in that direction (opportunity gone?). */
  postSlot?: number;
  postBestExpected?: string;
  /** Polling gap: ticks with snapshot slot in [S-25, S-1]. */
  preTicks: number;
}

export function compare(ticks: PairTickInfo[], arbs: CompetitorArb[], window = 25): Comparison[] {
  const sorted = [...ticks].sort((a, b) => a.slot - b.slot || a.wallStart - b.wallStart);
  return arbs.map((c) => {
    const dir = Object.entries(DIR_MAP).find(([, v]) => v === c.direction)?.[0];
    const pre = sorted.filter((t) => t.slot < c.slot && t.slot >= c.slot - window);
    const lastPre = pre.at(-1);
    const best = (t?: PairTickInfo) => (t && dir ? t.best?.[dir as keyof NonNullable<PairTickInfo["best"]>] : undefined);
    const seenTicks = pre.filter((t) => t.plan && !t.forced && t.plan.direction === dir);
    const first = seenTicks[0];
    const sims = seenTicks.filter((t) => t.sim);
    const post = sorted.find((t) => t.slot >= c.slot);
    return {
      signature: c.signature, slot: c.slot, blockTime: c.blockTime, feePayer: c.feePayer, direction: c.direction,
      competitorSolIn: c.solIn, competitorNet: c.walletSolNet, competitorSuccess: c.success,
      lastPreSlot: lastPre?.slot, lastPreBestExpected: best(lastPre)?.expectedProfit, lastPreBestIn: best(lastPre)?.grossIn,
      seen: !!first, firstSeenSlot: first?.slot, firstSeenWall: first?.wallDecided ?? first?.wallStart,
      leadSlots: first ? c.slot - first.slot : undefined,
      leadMs: first && c.blockTime ? c.blockTime * 1000 - (first.wallDecided ?? first.wallStart) : undefined,
      ourIn: first?.plan?.grossIn !== undefined ? String(first.plan.grossIn) : undefined, ourExpected: first?.plan?.expectedProfit !== undefined ? String(first.plan.expectedProfit) : undefined,
      executable: sims.some((t) => t.sim!.ok), simReasons: [...new Set(sims.filter((t) => !t.sim!.ok).map((t) => (t.sim!.reason ?? "").slice(0, 80)))],
      postSlot: post?.slot, postBestExpected: best(post)?.expectedProfit, preTicks: pre.length,
    };
  });
}

export interface ShadowSummary {
  ticks: number;
  byStatus: Record<string, number>;
  stages: Record<string, StageStats>;
  forcedStages: Record<string, StageStats>;
  /** slots between consecutive snapshots (polling granularity). */
  slotGap: StageStats;
  opportunities: number;
  simulatedOk: number;
}

export function summarizeTicks(ticks: PairTickInfo[]): ShadowSummary {
  const col = (f: (t: PairTickInfo) => number | undefined, filt: (t: PairTickInfo) => boolean = () => true) => stats(ticks.filter(filt).map(f).filter((x): x is number => x !== undefined));
  const real = (t: PairTickInfo) => !t.forced;
  const forced = (t: PairTickInfo) => !!t.forced;
  const gaps: number[] = [];
  for (let i = 1; i < ticks.length; i++) gaps.push(ticks[i].slot - ticks[i - 1].slot);
  const byStatus: Record<string, number> = {};
  for (const t of ticks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  return {
    ticks: ticks.length, byStatus,
    stages: {
      "detect: state poll RTT (getSlot + getMultipleAccounts)": col((t) => t.pollMs),
      "quote: two-stage optimizer, both directions (uncached)": col((t) => (t.quoteUs !== undefined ? t.quoteUs / 1000 : undefined), (t) => !t.cached),
      "build: tx build (opportunities)": col((t) => t.buildMs, real),
      "simulate: pre-sim RTT (opportunities)": col((t) => t.preSimMs, real),
      "simulate: final-sim RTT (opportunities)": col((t) => t.finalSimMs, real),
      "data arrival -> decision": col((t) => t.dataToDecisionMs),
      "data arrival -> final sim returned (opportunities)": col((t) => t.dataToSimulatedMs, real),
    },
    forcedStages: {
      "build (forced latency probes)": col((t) => t.buildMs, forced),
      "pre-sim RTT (forced)": col((t) => t.preSimMs, forced),
      "final-sim RTT (forced)": col((t) => t.finalSimMs, forced),
    },
    slotGap: stats(gaps),
    opportunities: ticks.filter((t) => t.plan && !t.forced).length,
    simulatedOk: ticks.filter((t) => !t.forced && t.sim?.ok).length,
  };
}

const f = (s: StageStats, unit = "ms") => (s.n ? `${s.median} / ${s.p95} / ${s.max} ${unit} (n=${s.n})` : "n=0");
const sol = (x: string | number | undefined) => (x === undefined ? "–" : (Number(x) / 1e9).toFixed(6));

export function renderShadowMd(o: { title: string; startedAt: string; minutes: number; interim: boolean; summary: ShadowSummary; comparisons: Comparison[]; competitorTxsScanned: number; notes: string[] }): string {
  const s = o.summary;
  const L: string[] = [];
  L.push(`# ${o.title}`, "");
  L.push(`${o.interim ? "**INTERIM** (run in progress)" : "Final"} — started ${o.startedAt}, ${o.minutes.toFixed(1)} min, ${s.ticks} ticks, simulate mode, public RPC polling (no gRPC / shreds in this sandbox).`, "");
  L.push("## Latency per stage (median / p95 / max)", "", "| stage | median / p95 / max |", "|---|---|");
  for (const [k, v] of Object.entries(s.stages)) L.push(`| ${k} | ${f(v)} |`);
  for (const [k, v] of Object.entries(s.forcedStages)) L.push(`| ${k} | ${f(v)} |`);
  L.push(`| slots between consecutive snapshots | ${f(s.slotGap, "slots")} |`, "");
  L.push(`Tick status counts: ${Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}. Opportunities (floor-clearing plans): ${s.opportunities}; passing simulations: ${s.simulatedOk}.`, "");
  const c = o.comparisons;
  const seen = c.filter((x) => x.seen), exec = c.filter((x) => x.executable);
  L.push("## Competitor MAX arbs landed during the run vs our view", "");
  L.push(`${c.length} competitor round trips through both MAX pools (from ${o.competitorTxsScanned} DLMM-pool txs scanned). Seen by us on pre-trade state: ${seen.length}; executable (our sim passed the floor on pre-trade state): ${exec.length}.`, "");
  if (c.length) {
    L.push("| slot | payer | direction | their SOL in | their net SOL | our last pre-trade snapshot (slots before) | our best net then | seen | lead (slots / ms) | our size / expected | sim | after their slot: our best |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const x of c) L.push(`| ${x.slot} | ${x.feePayer.slice(0, 6)} | ${x.direction} | ${sol(x.competitorSolIn)} | ${sol(x.competitorNet)}${x.competitorSuccess ? "" : " (failed)"} | ${x.lastPreSlot ?? "–"} (${x.lastPreSlot !== undefined ? x.slot - x.lastPreSlot : "–"}) | ${sol(x.lastPreBestExpected)} | ${x.seen ? "yes" : "no"} | ${x.seen ? `${x.leadSlots} / ${x.leadMs ?? "–"}` : "–"} | ${x.seen ? `${sol(x.ourIn)} / ${sol(x.ourExpected)}` : "–"} | ${x.seen ? (x.executable ? "ok" : `fail: ${x.simReasons.join("; ")}`) : "–"} | ${sol(x.postBestExpected)} |`);
  }
  L.push("");
  for (const n of o.notes) L.push(n);
  return L.join("\n") + "\n";
}

/** Opportunity ticks (floor-clearing, non-forced) with no competitor arb in the same direction within `window` slots after. */
export function untakenOpportunities(ticks: PairTickInfo[], arbs: CompetitorArb[], window = 25) {
  const opp = ticks.filter((t) => t.plan && !t.forced);
  const untaken = opp.filter((t) => !arbs.some((a) => a.direction === DIR_MAP[t.plan!.direction] && a.slot > t.slot && a.slot <= t.slot + window));
  return { opportunityTicks: opp.length, untaken: untaken.map((t) => ({ slot: t.slot, direction: t.plan!.direction, grossIn: String(t.plan!.grossIn), expected: String(t.plan!.expectedProfit), simOk: t.sim?.ok ?? null, simReason: t.sim?.reason })) };
}
